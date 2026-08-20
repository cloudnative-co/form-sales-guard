# 経路A: Cloudflare Worker 単体構成

初心者向けデフォルト経路。**アカウント1つ・ファイル数個で完結**し、無料枠でも動く。

## 構成

```
フォーム → POST /submit → 即「受け付けました」応答
                └ ctx.waitUntil() で応答後に:
                    few-shot 取得（KV） → AI 分類 → KV 記録更新 → 通知
LEAD / REVIEW → Slack Webhook に通知（修正リンク付き）
SPAM         → 通知なし・KV に隔離（/quarantine で一覧・救出）
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
3. シークレット3つを設定: `ANTHROPIC_API_KEY` / `CORRECTION_SECRET` / `SLACK_WEBHOOK_URL`
4. `npx wrangler deploy` → 表示された URL を `wrangler.toml` の `PUBLIC_URL` に入れて再デプロイ
5. `/test-form` でテスト送信 → 通知・隔離・修正リンクを確認
6. 本番フォームの送信先を `/submit` に向け、`ALLOWED_ORIGIN` を本番オリジンに設定、`TEST_FORM = "false"` に

## 隔離ボックスの URL

`/quarantine?sig=<署名>` — 署名は `HMAC-SHA256(CORRECTION_SECRET, "quarantine")` の16進表現。
セットアップ時に Claude Code が生成して利用者に渡す（ブックマーク推奨・月1回の確認を推奨）。

## カスタマイズの口

- **通知先の変更**: `notify()` を差し替える（Teams / メール送信 API 等）。「LEAD/REVIEW は通知・SPAM は隔離のみ・失敗しても throw しない」構造は維持する
- **記録先の追加**: `processSubmission()` に追記（Google Sheets / Notion 等）。内蔵 KV 記録は隔離ボックスと few-shot の基盤なので**残す**
- **モデル変更**: `wrangler.toml` の `MODEL` のみ（コードは触らない）

## 変えてはいけないもの

`docs/DESIGN_PRINCIPLES.md` の7原則に対応する箇所（`src/index.js` 冒頭のコメントに対応表あり）。
特に: 分類の catch → REVIEW フォールバック / SPAM の記録保存 / `ctx.waitUntil` / untrusted タグ / 修正時に `aiLabel` を上書きしない。
