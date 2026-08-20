# 経路B: メール転送方式（Cloudflare Email Routing + Email Worker）

**既存のフォームに一切手を入れずに導入する**経路。フォームサービス（formrun・Tally 等）や WordPress の「通知メール」を専用アドレスで受け、AI が分類してから本来の宛先に届ける。

```
既存フォーム → 通知メール → form-guard@あなたのドメイン（Email Routing）→ Email Worker
  → LEAD / REVIEW / 分類失敗 / 保存失敗: 本来の宛先へ転送（X-FormGuard-Label ヘッダ付き）+ 任意で Slack 通知
  → SPAM: 転送せず KV に隔離（/quarantine で本文閲覧・救出）
```

## この経路の特徴と制約

- **フォーム改修ゼロ**: 変えるのはフォームサービスの「通知先メールアドレス」だけ
- **前提**: 独自ドメインのゾーンが Cloudflare にあること（Email Routing の要件）。転送先アドレスは Email Routing での事前検証が必要
- **件名は書き換えられない**（Cloudflare の仕様で転送時に追加できるのは X- ヘッダのみ）。ラベルは `X-FormGuard-Label` ヘッダで付与されるため、メールソフト側の振り分けルール（ヘッダ条件）か Slack 通知で確認する
- **fail-open の形が経路Aと違う**: 分類に失敗したメールは**必ず転送される**（メールは絶対に落とさない）。転送を止めるのは「SPAM 判定かつ隔離ボックスへの保存に成功した」場合だけ（保存に失敗したメールは SPAM でも転送される）
- **隔離で保存されるのは本文（テキスト、無ければ HTML）の先頭1万文字のみ**。添付ファイルとメールの原本（raw MIME）は保存されない。メールは事後に再転送できないため、SPAM 誤判定されたメールの添付は救出しても取り戻せない —— 添付付きの重要メールが届きうる窓口には、この経路ではなく経路A、または SPAM も転送して振り分けはメールソフト側のルール（`X-FormGuard-Label` ヘッダ条件）で行う構成を検討すること
- 救出時の挙動: 救出リンクを開くと確認画面が出て、実行ボタンを押すと保存済みの本文が画面に表示される（+ few-shot に反映）

## ファイル

| ファイル | 役割 |
|---|---|
| `src/email-worker.js` | Email Worker 本体（email ハンドラ + 隔離ボックス/救出リンクの fetch ハンドラ） |
| `src/criteria.js` | 判定基準（**テンプレートには含まれない・セットアップ時に生成する**。`../cloudflare-worker/src/criteria.example.js` を参考に。無いとデプロイが失敗する） |
| `wrangler.toml` | 設定。セットアップ手順はファイル冒頭のコメント参照 |

## セットアップ

`wrangler.toml` 冒頭のコメントの手順どおり（Claude Code が SKILL.md に沿って案内します）。要点:

1. `npm install` で依存パッケージ（`postal-mime` / `wrangler`）を取得（Node.js 20 以上）。これを飛ばすとデプロイ時のバンドルが `postal-mime` のモジュール解決エラーで失敗する
2. Email Routing 有効化 → 宛先アドレス検証 → 専用受信アドレス作成
3. KV 作成・シークレット設定（`ANTHROPIC_API_KEY` / `CORRECTION_SECRET` / 任意で `SLACK_WEBHOOK_URL`）
4. `npx wrangler deploy` → 表示された Worker の URL を `wrangler.toml` の `PUBLIC_URL` に設定して**再デプロイ**（未設定だと Slack 通知内の修正リンクが相対 URL になり壊れる）→ Email Routing のルールで専用アドレスをこの Worker に接続
5. フォームサービスの通知先を専用アドレスに変更
6. テスト: フォームからテスト送信 → 転送メールに `X-FormGuard-Label` が付くこと、営業様文面が隔離されること、Slack 通知の修正リンクが開けることを確認 → **テストデータを KV から削除**（SKILL.md Step 5-5）

## 隔離ボックスの URL

`<PUBLIC_URL>/quarantine?sig=<署名>` — 署名は `HMAC-SHA256(CORRECTION_SECRET, "quarantine")` の16進表現。
セットアップ時に Claude Code が生成して利用者に渡す（ブックマーク推奨・月1回の確認を推奨）。
Slack Webhook を設定しない構成では、隔離ボックスが SPAM 判定メールを見る唯一の手段になる。

## 既知の限界（低流量・操作者1名を前提にした単純化）

- **修正処理は原子的でない**: Workers KV は read-modify-write のトランザクションを持たないため、複数人がほぼ同時に同じ救出リンクを実行すると、矛盾した few-shot 例（`correction:` キー）が両方残りうる。起きたら該当 `correction:` キーを削除すれば直る
- **救出・隔離リンクに有効期限はない**: リンクは Slack・転送メール内にのみ流れる前提。万一 URL が外部に漏れた場合は `CORRECTION_SECRET` を再生成して再デプロイすれば全リンクが失効する

## 変えてはいけないもの

`docs/DESIGN_PRINCIPLES.md` の7原則。特にこの経路では **「SPAM 以外は必ず転送する」構造**（分類失敗・パース失敗・設定不備のいずれでもメールを落とさない）を崩さないこと。
