# 経路C: AWS 参照実装（SAM 雛形）

株式会社クラウドネイティブが**自社サイトで実運用している構成のサニタイズ版**。エンジニア向け。

> **これはそのままデプロイする完成品ではなく、設計参照（雛形）です。**
> 実運用版から会社固有の判定基準・外部連携（CRM・タスク管理・メール送信）・固有 ID 類を
> すべて取り除き、「なぜこの数値・この順序なのか」という設計判断が読み取れる形に
> 再構成しています。導入時は Claude Code が [SKILL.md](../../SKILL.md) に沿って、
> この雛形をあなたの環境に合わせて具体化します。

## 構成

```
フォーム POST /submit
  → API Gateway（スロットリング 10 req/s）
  → 同期 Classifier Lambda（Timeout 25s < API GW 29s）
      検証（honeypot / 送信速度 / 長さ上限）→ DynamoDB 保存 → SQS 送信 → 即 200
  → SQS 標準キュー（可視性 720s = 関数 120s の6倍 / 保持4日 / maxReceiveCount 5）
      → 非同期 Processor Lambda（Timeout 120s）
          few-shot 取得（3s タイムアウト + キャッシュ）→ AI 分類（fail-open）
          → 記録更新 ∥ Slack 通知（Promise.allSettled・never-reject）
      → DLQ（5回失敗で退避 / 保持14日 / アラーム付き）

Slack 修正ボタン POST /slack/actions
  → Feedback Lambda（署名検証 → IDOR 突合 → humanLabel 記録 → few-shot 還流）

シークレット: Secrets Manager（ANTHROPIC_API_KEY / SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET）
検知: CloudWatch メトリクスフィルタ（"Classification failed" 等のプレーン文字列マッチ）+ アラーム
```

| ファイル | 役割 |
|---|---|
| `template.yaml` | SAM テンプレート。キュー・アラーム・テーブルの数値設計の理由はコメント参照 |
| `src/classifier.ts` | 同期受付。ボット対策（AI の前段の多層防御）と即応答 |
| `src/processor.ts` | 非同期分類。few-shot 還流・never-reject な下流処理・判定基準の注入点 |
| `src/claude.ts` | AI 分類サービス。防御的パース一式と REVIEW フォールバック |
| `src/feedback.ts` | Slack 修正ボタン。署名検証・IDOR 対策・人間ラベルの別フィールド記録 |

## この構成を選ぶ理由（経路A: Cloudflare Worker との違い）

| 観点 | 経路A（Cloudflare Worker） | 経路C（この雛形） |
|---|---|---|
| 非同期化の手段 | `ctx.waitUntil()`（応答後の処理続行が公式サポート） | SQS 経由で別 Lambda。**Lambda では fire-and-forget が実行環境の凍結で消える**ため必須（[PITFALLS B-1](../../docs/PITFALLS.md)） |
| 失敗時の再処理 | なし（失敗は検知して手動対応） | SQS 自動リトライ + DLQ 退避 + アラーム |
| 検知 | ⚠️ 付き通知 + ログ | CloudWatch メトリクスフィルタ + アラーム（SNS メール通知） |
| 修正 UI | HMAC 署名付きリンク | Slack ボタン（署名検証・IDOR 突合込み） |
| 記録先 | Workers KV | DynamoDB（GSI で逆引き・few-shot 抽出） |
| 費用 | 無料枠で収まりうる | 少額の AWS 費用（API GW / Lambda / SQS / DynamoDB） |
| 向き | まず始める・小規模 | 既に AWS で運用している・確実な再処理と観測性が要る |

小規模なフォームには過剰。**まず経路Aで始めて、必要になったら移行する**のが推奨。

## 使い方（Claude Code が SKILL.md に沿って案内します）

1. **判定基準の生成**: `src/criteria.example.ts` を `src/criteria.ts` にコピーし、
   [prompts/classifier-skeleton.md](../../prompts/classifier-skeleton.md) の手順で
   ブロック①（会社知識）②（LEAD/SPAM 基準）を生成して埋める。`criteria.ts` は
   **`.gitignore` 済み**（機微な判定基準を tracked な `processor.ts` に書かせないための分離。
   `processor.ts` は `import { CRITERIA } from './criteria.ts'` で読む — 拡張子 `.ts` は
   検収用の一時 JS が残留してもバンドルに紛れ込まないための意図的な指定）。
   生成した基準はあなたのものであり、このリポジトリに投稿しない
2. **Secrets Manager にシークレットを作成**: JSON で `ANTHROPIC_API_KEY` / `SLACK_BOT_TOKEN` /
   `SLACK_SIGNING_SECRET` を格納し、ARN を `SecretsArn` パラメータに渡す
3. **Slack App の作成**: Bot Token Scopes に `chat:write`。デプロイ後、Outputs の
   `SlackActionsEndpoint` を Interactivity の Request URL に設定
4. **デプロイ**: `sam build && sam deploy --guided`（`SlackChannel*` / `AllowedOrigin` /
   `AlarmEmail` を自分の値に）。esbuild ビルドのため `esbuild` と依存パッケージ
   （`@anthropic-ai/sdk`、`@aws-sdk/client-sqs` 等）の `package.json` が必要
5. **費用上限の設定**（安全不変条件 7・スキップ不可）: Anthropic Console の Usage limits と
   AWS Budgets を必ず設定する
6. **テスト送信**: 正常系（LEAD 相当）→ Slack 通知確認 → 修正ボタン → DynamoDB の
   `humanLabel` を確認。分類失敗系は `CRITERIA` を壊すのではなく無効な API キーで
   REVIEW フォールバックとアラームを検証する

## 隔離ボックス（SPAM の閲覧・救出導線）

SPAM も削除されず (1) DynamoDB の全レコード、(2) SPAM 専用 Slack チャンネル、の2箇所に残る
（安全不変条件 2）。月1回は SPAM チャンネルを見返し、誤判定があれば修正ボタンで救出する。

## 本番の教訓との対応（詳細は [docs/PITFALLS.md](../../docs/PITFALLS.md)）

| 教訓 | この雛形での実装箇所 |
|---|---|
| A-1 モデル引退のサイレント劣化 | `claude.ts` の `MODEL_ID` 1箇所集約 + `template.yaml` の分類失敗アラーム |
| A-2/A-3 thinking ブロックと max_tokens | `claude.ts` の text ブロック探索・`max_tokens: 4096` |
| A-4 LLM 出力の防御的パース | `claude.ts` の型ガード（label enum / confidence 丸め / reasoning フォールバック+500字） |
| A-5 SDK タイムアウトの階層 | `claude.ts` の `timeout: 60_000, maxRetries: 0`（再試行を断ち単一 60s < Lambda 120s）+ `classifier/processor/feedback.ts` の AWS SDK 各 client に requestTimeout / `throwOnRequestTimeout: true`（無いと超過は警告のみ）/ `socketTimeout`（body 局面の無通信検知）。SDK は `template.yaml` でバンドルし版を固定 |
| A-6/A-7 few-shot のタグと分離 | `claude.ts` の untrusted タグ / `processor.ts` の 3s タイムアウト+キャッシュ |
| B-1 fire-and-forget 禁止 | SQS 分離 + `Promise.allSettled` 並列（`processor.ts`） |
| B-2 同期 25s < API GW 29s | `template.yaml` の Globals コメント |
| C-1〜C-4 キューの数値設計 | `template.yaml` の SQS/DLQ 定義コメント |
| D-1〜D-5 Slack コールバック | `feedback.ts`（署名→パースの順序 / Base64 / IDOR / 同一ラベルボタン非表示 / aiLabel 非上書き） |
| E-1〜E-3 ボット対策 | `classifier.ts`（黙殺応答 / 長さ上限 / Turnstile 追加点のコメント） |
| F-1/F-2 ログとアラームの契約 | `template.yaml` の FilterPattern コメント + 各ファイルの契約文字列コメント |

## 拡張ポイント（実運用版で存在するが雛形から省いたもの）

実運用版はこの雛形に加えて外部連携のオーケストレーションを持つ。雛形では記録先を
DynamoDB に単純化しているが、以下のインターフェースで差し替え・追加できる:

- **RecordStore**: DynamoDB の保存・更新・逆引きを Notion / Google Sheets 等に差し替える。
  「分類なしで即保存 → 分類を後から更新」「メッセージ ID からの逆引き」「修正済みレコードの
  抽出（few-shot 用）」の3操作を満たすこと
- **TaskTracker**: LEAD 判定時にタスク管理ツール（Asana / Jira 等）へ起票し、Slack の
  担当者選択と連動させる。失敗しても throw しない（never-reject）構造を維持する
- **CrmSync**: LEAD を CRM（Salesforce 等）へ upsert する。同上
- **確認メール送信**: 送信者への自動返信。**再送が最も痛い非冪等処理**なので、追加する場合は
  never-reject と DLQ redrive 手順（PITFALLS C-5）を必ず整合させること

いずれも `processor.ts` の `Promise.allSettled` に並列参加させ、失敗検知用の
メトリクスフィルタを `template.yaml` に対で追加する（ペア設計）。

## 既知の限界（雛形として意図的に単純化している点）

この雛形は低流量（月数十〜数百件・操作者1名）を前提に、分散システムとしての厳密さより読み取りやすさを優先している。大規模化・多人数運用する場合は以下を認識すること:

- **SQS の重複配送に対する冪等性がない**: SQS 標準キューは at-least-once 配送であり、稀な重複配送時は Slack 通知が二重に投稿され、後着の `slackMessageTs` が先着を上書きする（問い合わせデータ自体は壊れない）。厳密にするなら recordId ベースの条件付き状態遷移（`received`→`processing` の conditional update）を入れる
- **修正ボタンの処理が同期的**: Slack の 3 秒 ack 要件に対し、Secrets 取得〜GSI Query〜UpdateItem〜chat.update を完了してから 200 を返すため、遅延時は Slack 側にエラー表示が出ることがある（**DB への記録は成功していることがある**。メッセージのボタンが残っていれば再度押してよい — 記録済みなら no-op になる）。また GSI は結果整合のため、通知の投稿直後にボタンを押すと逆引きに失敗して無視されることがある（数秒待って押し直せばよい）。厳密にするなら署名検証後に即 ack して処理を非同期化する
- **DynamoDB 保存と SQS 送信が非トランザクション**: PutItem 成功後に SendMessage が失敗すると `received` のまま処理されないレコードが残る（クライアントには 500 が返るため利用者は再送できる）。厳密にするなら outbox パターンか未投入レコードの定期照合を入れる
- **Processor の SQS 実行ロールは全キュー対象**: DynamoDB/Secrets の IAM は最小化したが、SAM が SQS イベントソース用に付与する実行ロール（`AWSLambdaSQSQueueExecutionRole`）は `ReceiveMessage`/`DeleteMessage` の Resource が `*`（全キュー）になる。厳密には Processor に custom role を指定し、対象 `ProcessingQueue` の ARN だけに限定する
- **タイムアウトは各 SDK 呼び出し単位で、end-to-end のハード上限ではない**: Anthropic は `maxRetries:0`（60s 単発）、AWS SDK 各 client は明示 requestTimeout + `throwOnRequestTimeout: true` + `socketTimeout`（requestTimeout は headers 到達で解除されるため、body が止まる故障は socketTimeout の無通信検知が受け持つ。SDK はバンドルして版を固定 — ランタイム同梱 SDK は版が変動し timeout の意味論ごと変わる）。各呼び出しの実効上限は「maxAttempts × timeout + バックオフ」。残る穴は2つ: (1) データが細く流れ続ける trickle 応答は socketTimeout をすり抜ける — `processor` は Lambda 120s → SQS 再配信 → DLQ アラームで検知され、`classifier` は 25s で死に送信者にエラーが見える（無音の消失にはならない。心配なら classifier の Lambda Errors アラームを追加する） (2) 複数 await の積み上げが理論上 Lambda 上限を超えうる — 厳密にするなら各 await を Lambda 残時間（`context.getRemainingTimeInMillis()`）ベースの deadline で締める

## 変えてはいけないもの

[docs/DESIGN_PRINCIPLES.md](../../docs/DESIGN_PRINCIPLES.md) の7原則に対応する箇所。特に:
分類の catch → REVIEW フォールバック / SPAM の記録保存 / SQS 分離（fire-and-forget 禁止）/
untrusted タグ / 署名検証 → パースの順序 / `humanLabel` と `aiLabel` の分離 /
検知アラームとログ文言の契約。
