# 経路A: Cloudflare Worker 単体構成

初心者向けデフォルト経路。**アカウント1つ・ファイル数個で完結**し、無料枠でも動く。

## 構成

```
フォーム → POST /submit → 即「受け付けました」応答
                └ ctx.waitUntil() で応答後に:
                    few-shot 取得（KV） → AI 分類 → 通知 → KV 記録更新（分類後は1回だけ）
LEAD / REVIEW → Slack Webhook に通知（修正リンク付き）
SPAM         → 通常の通知先には出さず KV に隔離（/quarantine で一覧・救出。
                SLACK_WEBHOOK_SPAM を設定すれば SPAM 専用チャンネルにも流せる）
修正リンク    → GET /correct（確認画面・副作用なし）→ POST /correct（実行・HMAC 署名付き）→ few-shot に還流
```

| ファイル | 役割 |
|---|---|
| `src/index.js` | Worker 本体。安全不変条件の対応箇所はコード冒頭のコメント参照 |
| `src/criteria.example.js` | 判定基準の例（架空の会社）。コピーして `src/criteria.js` を作る |
| `wrangler.toml` | 設定。KV の id とモデル・オリジン等 |

## セットアップ（Claude Code が SKILL.md に沿って案内します）

1. `src/criteria.example.js` を参考に `src/criteria.js` を生成（対話で判定基準を作る）
2. `npx wrangler kv namespace create RECORDS` → 出力の id を `wrangler.toml` へ
3. シークレット3つを設定: `ANTHROPIC_API_KEY` / `CORRECTION_SECRET` / `SLACK_WEBHOOK_URL`（**`SLACK_WEBHOOK_URL` は必須**。未設定だと `/submit` が 500 を返して受付を止める — 下の「既知の限界」参照）。任意で `SLACK_WEBHOOK_SPAM`（SPAM 専用チャンネル。未設定なら SPAM は隔離ボックスにしか出ない）
4. `npx wrangler deploy` → 表示された URL を `wrangler.toml` の `PUBLIC_URL` に入れて再デプロイ
5. `/test-form` でテスト送信 → 通知・隔離・修正リンクを確認
6. 本番フォームの送信先を `/submit` に向け、`ALLOWED_ORIGIN` を本番オリジンに設定、`TEST_FORM = "false"` に

## 隔離ボックスの URL

`/quarantine?sig=<署名>` — 署名は `HMAC-SHA256(CORRECTION_SECRET, "quarantine")` の16進表現。
セットアップ時に Claude Code が生成して利用者に渡す（ブックマーク推奨・月1回の確認を推奨）。

一覧に出るのは3種類。**SPAM**（営業と判定して通常の通知に出さなかったもの。ここから救出する）/
**未分類**（分類ラベルが入らないまま10分以上経った取り残し）/ **未配信**（通知が届かなかった
LEAD・REVIEW。Webhook の失効・チャンネル削除・Slack 障害で発生する）。後ろの2つは
「本来なら人間に届いていたはずのもの」なので、出ていたら原因を必ず確認すること。

## カスタマイズの口

- **通知先の変更**: Slack を読む面は `notify()` / `missingNotifyConfig()` / `alertStorageFailure()` の**3つ**あり、まとめて差し替えること（`grep -n 'SLACK_WEBHOOK\|escapeSlackText\|correctionLinks' src/index.js` で全部出る）。`alertStorageFailure()` を残すと、保存失敗の⚠️だけが旧チャンネルに出る（旧シークレットごと消していれば黙って消える）。Slack 固有の記法（`escapeSlackText()` の `&<>` 変換、`correctionLinks()` の `<URL|ラベル>`）も移送先の記法に直すこと。「LEAD/REVIEW は通知・SPAM は通常の通知先に出さない・失敗しても throw しない」構造は維持する
- **記録先の追加**: `processSubmission()` に追記（Google Sheets / Notion 等）。内蔵 KV 記録は隔離ボックスと few-shot の基盤なので**残す**
- **モデル変更**: `wrangler.toml` の `MODEL` のみ（コードは触らない）

## 既知の限界（低流量・操作者1名を前提にした単純化）

- **通知先が未設定だとフォームが止まる**: `SLACK_WEBHOOK_URL` が無いまま受け付けると、LEAD/REVIEW は Slack に出ず、隔離ボックスの「未配信」行（月1回見る面）にしか残らない ——**人間に push される面がゼロになる**。そのため `/submit` は通知先の有無を受付の前提条件として扱い、未設定なら 500 を返す（`missingNotifyConfig()`）。運用中に Webhook のシークレットを消すとその瞬間にフォームが止まるが、「受け付けたのに誰にも届かない」より「送信者にエラーが見えて別の連絡手段に切り替えられる」ほうを選んでいる（安全不変条件1）。別チャネルに差し替えるときに直す関数は上の「カスタマイズの口」を参照（列挙をここに重複させない）
- **隔離ボックスには「未分類」の行が出ることがある**: KV は同一キーへの並行書き込みが last-write-wins で順序保証が無く、受付時の保存が期限超過の後から着地する・`waitUntil` が 30 秒で打ち切られる・分類後の保存が失敗する、のいずれでも分類ラベルが入らないまま残ることがある。この取り残しは隔離ボックスに「未分類」として表示され、そこから内容を確認して救出できる（原因は塞げないが、見えなくなる経路は塞いである）。分類後に同一キーへ書くのを**1回だけ**にしているのはこのため —— 2回書くと、先に発行した put が後から着地して「未配信」の印を消す競合が生まれ、記録が隔離ボックスからも Slack からも消える
- **通知を出してから記録を確定させている**: 分類後の書き込みを1回にするため、Slack 通知 → KV 保存の順にしている。そのため通知直後のごく短い間だけ、人間が修正リンクを実行するとその修正が上書きされうる窓がある。通常はこの put が数百ミリ秒で終わるので、Slack にメッセージが配信されて人が確認画面を開き実行するまでの時間には届かない。ただし KV が劣化してこの put が期限超過した場合（裏では走り続ける）は、数秒後に着地して `humanLabel` と `corrected` を巻き戻しうる —— 救出したはずの SPAM が隔離ボックスに再び現れ、`correction:` の few-shot 例だけが二重に残る（該当キーを削除すれば直る。「修正処理は原子的でない」と同じ性質の限界）。**記録が消えるわけではなく**、Slack 通知に残る修正リンクから再度修正できる（SPAM 判定なら隔離ボックスからも）
- **分類後の保存に失敗したことは、別便の⚠️で知らせる**: 通知は保存より前に出るため（同一キーへの書き込みを1回にするため）、保存の失敗を本来の通知に載せられない。人間に push される面が無い記録（SPAM 判定＝主チャンネルに出していない／通知そのものが失敗した）だけ、「保存に失敗した」ことを別の Slack メッセージで出す。記録自体は受付時の保存が残っていれば10分後に隔離ボックスの「未分類」に現れる。ただしこのアラートは `waitUntil` の時間切れで保存自体が走らなかった場合には出ないため、**最終的な回収面は月1回の隔離ボックス確認**であることに変わりはない
- **KV 障害と Slack 障害が同時に起きると取りこぼす**: 受付時の保存に失敗した問い合わせは Slack 通知が唯一の可視面になり（SPAM 判定でも⚠️付きで通知する）、その Slack も同時に落ちていると Worker のログにしか残らない。単一の障害では必ずどこかに残るが、独立した2つの障害が重なる場合はこの限界がある

- **修正処理は原子的でない**: Workers KV は read-modify-write のトランザクションを持たないため、複数人がほぼ同時に同じ通知の修正リンクを実行すると、矛盾した few-shot 例（`correction:` キー）が両方残りうる。起きたら隔離ボックス・`wrangler kv key list` で該当 `correction:` キーを削除すれば直る。操作者が実質1名の運用では問題にならない
- **修正・隔離リンクに有効期限はない**: リンクは Slack 内部にのみ流れる前提。万一 URL が外部に漏れた場合は `CORRECTION_SECRET` を再生成して再デプロイすれば全リンクが失効する

## 変えてはいけないもの

`docs/DESIGN_PRINCIPLES.md` の7原則に対応する箇所（`src/index.js` 冒頭のコメントに対応表あり）。
特に: 分類の catch → REVIEW フォールバック / SPAM の記録保存 / `ctx.waitUntil` / untrusted タグ / 修正時に `aiLabel` を上書きしない。
