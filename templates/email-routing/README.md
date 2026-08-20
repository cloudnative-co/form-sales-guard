# 経路B: メール転送方式（Cloudflare Email Routing + Email Worker）

**既存のフォームに一切手を入れずに導入する**経路。フォームサービス（formrun・Tally 等）や WordPress の「通知メール」を専用アドレスで受け、AI が分類してから本来の宛先に届ける。

```
既存フォーム → 通知メール → form-guard@あなたのドメイン（Email Routing）→ Email Worker
  → LEAD / REVIEW / 分類失敗: 本来の宛先へ転送（X-FormGuard-Label ヘッダ付き）+ 任意で Slack 通知
  → SPAM: 転送せず KV に隔離（/quarantine で全文閲覧・救出）
```

## この経路の特徴と制約

- **フォーム改修ゼロ**: 変えるのはフォームサービスの「通知先メールアドレス」だけ
- **前提**: 独自ドメインのゾーンが Cloudflare にあること（Email Routing の要件）。転送先アドレスは Email Routing での事前検証が必要
- **件名は書き換えられない**（Cloudflare の仕様で転送時に追加できるのは X- ヘッダのみ）。ラベルは `X-FormGuard-Label` ヘッダで付与されるため、メールソフト側の振り分けルール（ヘッダ条件）か Slack 通知で確認する
- **fail-open の形が経路Aと違う**: 分類に失敗したメールは**必ず転送される**（メールは絶対に落とさない）。SPAM 判定だけが転送を止める
- 救出時の挙動: メールは事後に再転送できないため、救出リンクを押すと**全文が画面に表示**される（+ few-shot に反映）

## ファイル

| ファイル | 役割 |
|---|---|
| `src/email-worker.js` | Email Worker 本体（email ハンドラ + 隔離ボックス/救出リンクの fetch ハンドラ） |
| `src/criteria.js` | 判定基準（**テンプレートには含まれない・セットアップ時に生成する**。`../cloudflare-worker/src/criteria.example.js` を参考に。無いとデプロイが失敗する） |
| `wrangler.toml` | 設定。セットアップ手順はファイル冒頭のコメント参照 |

## セットアップ

`wrangler.toml` 冒頭のコメントの手順どおり（Claude Code が SKILL.md に沿って案内します）。要点:

1. Email Routing 有効化 → 宛先アドレス検証 → 専用受信アドレス作成
2. KV 作成・シークレット設定（`ANTHROPIC_API_KEY` / `CORRECTION_SECRET` / 任意で `SLACK_WEBHOOK_URL`）
3. `npx wrangler deploy` → Email Routing のルールで専用アドレスをこの Worker に接続
4. フォームサービスの通知先を専用アドレスに変更
5. テスト: フォームからテスト送信 → 転送メールに `X-FormGuard-Label` が付くこと、営業様文面が隔離されることを確認 → **テストデータを KV から削除**（SKILL.md Step 5-5）

## 隔離ボックスの URL

`<PUBLIC_URL>/quarantine?sig=<署名>` — 署名は `HMAC-SHA256(CORRECTION_SECRET, "quarantine")` の16進表現。
セットアップ時に Claude Code が生成して利用者に渡す（ブックマーク推奨・月1回の確認を推奨）。
Slack Webhook を設定しない構成では、隔離ボックスが SPAM 判定メールを見る唯一の手段になる。

## 変えてはいけないもの

`docs/DESIGN_PRINCIPLES.md` の7原則。特にこの経路では **「SPAM 以外は必ず転送する」構造**（分類失敗・パース失敗・設定不備のいずれでもメールを落とさない）を崩さないこと。
