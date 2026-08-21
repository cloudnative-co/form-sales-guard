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

1. **判定基準の生成**: `src/criteria.example.ts` を `src/criteria.ts` に**コピーして**（1行目の
   `import type` から `type` を落とさないこと。落とすと実行時の import として残り、検収が
   「モジュールを解決できません」で止まる）、
   [prompts/classifier-skeleton.md](../../prompts/classifier-skeleton.md) の手順で
   ブロック①（会社知識）②（LEAD/SPAM 基準）を生成して埋める。`criteria.ts` は
   **`.gitignore` 済み**（機微な判定基準を tracked な `processor.ts` に書かせないための分離。
   `processor.ts` は `import { CRITERIA } from './criteria.ts'` で読む — 拡張子 `.ts` は
   検収用の一時 JS が残留してもバンドルに紛れ込まないための意図的な指定）。
   生成した基準はあなたのものであり、このリポジトリに投稿しない。
   デプロイ前の検収（`node <このリポジトリ>/tools/eval.mjs <このプロジェクト>`）は、
   **本番と同じ `src/criteria.ts` をそのまま読む**（Node が型注釈を剥がして直接 import するため
   **Node.js 22.18 以上が必要**・推奨 24 LTS）。検収用に別ファイルへ値を写さないこと —
   写しを直しても本番のバンドルには載らないため、「検収で直したのに古い基準がデプロイされる」
   という乖離が起きる（旧手順で作った `src/criteria.mjs` が残っていると検収は停止する）
2. **Secrets Manager にシークレットを作成**: JSON で `ANTHROPIC_API_KEY` / `SLACK_BOT_TOKEN` /
   `SLACK_SIGNING_SECRET` を格納し、ARN を `SecretsArn` パラメータに渡す
3. **Slack App の作成**: Bot Token Scopes に `chat:write`。デプロイ後、Outputs の
   `SlackActionsEndpoint` を Interactivity の Request URL に設定
4. **デプロイ**: 先に `npm install`（esbuild ビルドには `esbuild` と依存パッケージの
   実体が要る）→ `sam build && sam deploy --guided`（`SlackChannel*` / `AllowedOrigin` /
   `AlarmEmail` を自分の値に）。
   **本番運用では、`npm install` で生成される `package-lock.json` を自分のリポジトリに
   コミットし、`template.yaml` の各 `BuildProperties` に `UseNpmCi: true` を足すこと。**
   雛形は最新のセキュリティ修正を取り込めるよう caret 指定・lockfile 非同梱にしてあるが、
   それは「毎回同じ版でビルドされる」ことを意味しない（AWS SDK はほぼ毎日リリースされ、
   timeout の意味論を実装している `@smithy/*` も caret で入る）。SAM が `npm ci` を使うのは
   lockfile と `UseNpmCi` が両方揃ったときだけで、片方だけだと `npm install` に戻って版が動く。
   なお `UseNpmCi` は SAM のビルドイメージによっては `Invalid build flag` になることがある。
   その場合は lockfile のコミットだけでも実務上はほぼ固定される
5. **デプロイしたら SNS 購読を確認する（踏み忘れるとアラームが1本も届かない）**:
   `AlarmEmail` 宛に `AWS Notification - Subscription Confirmation` が届くので
   **Confirm subscription** リンクを開く。**未確認の購読は 48 時間で SNS が自動削除する**
   （[SNS 開発者ガイド](https://docs.aws.amazon.com/sns/latest/dg/sns-email-notifications.html):
   "Amazon SNS deletes all other unconfirmed subscriptions after 48 hours."）。
   リンクを踏まなくても CloudFormation は `CREATE_COMPLETE` で成功するため、**11本のアラームは
   正常に ALARM へ遷移するのにメールだけが1通も来ない**状態になる（分類失敗だけは
   ⚠️ 付きの Slack 通知でも見えるが、Slack 投稿失敗・DLQ 到達・processor の異常終了など
   残り10本には代替経路が無く運用者には完全に無音になる）。トピックの ARN は
   `sam deploy` の Outputs の `AlarmTopicArn`（手順6 の経路で更新した場合は
   `aws cloudformation describe-stacks --stack-name <スタック名> --query "Stacks[0].Outputs"`）:

   ```bash
   aws sns list-subscriptions-by-topic --topic-arn <AlarmTopicArn> \
     --query 'Subscriptions[].[Protocol,Endpoint,SubscriptionArn]' --output table
   ```

   `SubscriptionArn` が `arn:aws:sns:...` なら確認済み。`PendingConfirmation` ならリンク未押下
   （48時間以内に踏めばよい。期限が切れていたら下の (b) と同じ扱い）。
   **1件も出ない場合は2通りある**: (a) `AlarmEmail` を空のままデプロイした（購読リソース自体が
   作られていない）/ (b) 確認リンクを踏まないまま 48 時間が過ぎ、SNS が購読を削除した。
   (a) は `AlarmEmail` を指定して `sam deploy` し直せば直る。(b) は打ち直しても復旧しない
   （CloudFormation はリソースが在ると認識したままで差分ゼロ）ので、**`AlarmEmail` の値を
   変えて（別アドレス → 元のアドレス）`sam deploy` し直し、CloudFormation に購読を作り直させる**。
   急ぐなら手で購読し直してもよいが、**その購読は CloudFormation の管理外**になり、以後
   `AlarmEmail` を変更しても古いアドレスに配信され続ける（不要になったら手で
   `aws sns unsubscribe` すること）:

   ```bash
   aws sns subscribe --topic-arn <AlarmTopicArn> --protocol email \
     --notification-endpoint <AlarmEmail と同じアドレス>
   ```

   ※ 判定は `PendingConfirmation` の文字列一致ではなく「`arn:` で始まるかどうか」で行うこと
   （SNS は API によって `pending confirmation` / `PendingConfirmation` と表記が揺れる）
6. **既に運用中のスタックを更新する場合の注意**: 追加された `ClassifierLogGroup`
   （`/aws/lambda/form-guard-classifier`）と `FeedbackLogGroup`
   （`/aws/lambda/form-guard-feedback`）は、既存スタックでは Lambda が自動作成した
   同名のロググループが CloudFormation の管理外に存在するため、`already exists` で
   スタック更新が失敗する（新規デプロイでは何も要らない）。対処は2択:

   **(A) 既存のログを残したまま取り込む（推奨）** — CloudFormation の auto-import を使う。
   このテンプレートのロググループは `DeletionPolicy: Retain` + 静的な `LogGroupName` を
   持たせてあるので、auto-import の要件を満たしている。`sam deploy` には import 機能が無いため、
   `sam build` の出力を使って CLI でチェンジセットを組む（通常の UPDATE なので、同じ更新で
   メトリクスフィルタ・アラームも一緒に作れる）:

   ```bash
   sam build
   # CloudFormation はローカルパスの CodeUri を解決できないので、成果物を S3 に上げて
   # CodeUri を s3:// に書き換えたテンプレートを作る（sam deploy はこれを内部でやっている）。
   # --resolve-s3 は SAM 管理バケットを使う（無ければ作る）。samconfig.toml の s3_bucket は
   # 見ないので、バケットを指定したいなら --s3-bucket <名前> に置き換えること
   sam package \
     --template-file .aws-sam/build/template.yaml \
     --resolve-s3 \
     --output-template-file .aws-sam/packaged.yaml

   # ⚠️ --parameters は省略も部分指定も不可。sam deploy と違い samconfig.toml の
   #    parameter_overrides は効かず、渡さなかったパラメータはテンプレートの既定値に戻る。
   #    SecretsArn は既定値が無いのでまず失敗し、そこだけ補って通すと AllowedOrigin が
   #    https://www.example.com に、SlackChannel* が YOUR_SLACK_CHANNEL_ID_* に戻り、
   #    AlarmEmail が空になって SNS 購読ごと削除される（CORS 遮断・Slack 通知全停止・
   #    アラームメール停止が同時に起きる）
   aws cloudformation create-change-set \
     --stack-name <スタック名> --change-set-name import-loggroups \
     --change-set-type UPDATE --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
     --template-body file://.aws-sam/packaged.yaml \
     --parameters \
       ParameterKey=SecretsArn,UsePreviousValue=true \
       ParameterKey=AllowedOrigin,UsePreviousValue=true \
       ParameterKey=SlackChannelLeads,UsePreviousValue=true \
       ParameterKey=SlackChannelReview,UsePreviousValue=true \
       ParameterKey=SlackChannelSpam,UsePreviousValue=true \
       ParameterKey=AlarmEmail,UsePreviousValue=true \
     --import-existing-resources

   # create-change-set は非同期。待たずに describe すると CREATE_IN_PROGRESS の空の結果を
   # 見て「問題なし」と誤読し、execute が InvalidChangeSetStatus で落ちる
   aws cloudformation wait change-set-create-complete \
     --stack-name <スタック名> --change-set-name import-loggroups
   aws cloudformation describe-change-set --stack-name <スタック名> --change-set-name import-loggroups
   aws cloudformation execute-change-set --stack-name <スタック名> --change-set-name import-loggroups
   ```

   （`--parameters` の6件は `template.yaml` の `Parameters` と同じ集合。雛形を改造して
   パラメータを増やしたら、ここにも足すこと。渡し漏れたものは既定値に戻る）

   `wait` が失敗したら `describe-change-set` の `StatusReason` を読むこと
   （`The submitted information didn't contain changes` なら取り込むものが無い＝既に取り込み済み）。

   `describe-change-set` では3点を見る: **`Status` が `FAILED` でないこと** /
   **`ClassifierLogGroup` と `FeedbackLogGroup` が `Import` として出ること** / **`AlarmEmailSubscription` の `Remove` や
   パラメータの既定値への巻き戻りが出ていないこと**。`FAILED` なら (B) に切り替える
   （auto-import と SAM の Transform の組み合わせは公式に禁止されてはいないが、成功する旨の
   明示的な記載も無い）。実行後は `aws cloudformation detect-stack-drift` でドリフト検出をかける。
   なお import はテンプレートのプロパティを既存リソースに適用しないため、**取り込んだロググループの
   保持期間は「無期限」のまま残る**（テンプレート側の `RetentionInDays: 90` との差はドリフトとして
   出る）。90日にしたい場合は `aws logs put-retention-policy` を手で実行すること。

   **(B) ログが要らないなら、退避して消してから `sam deploy`**:

   ```bash
   # Lambda が自動作成したロググループは既定で「失効しない」ので、--since は運用開始日を含む長さにする
   for fn in classifier feedback; do
     aws logs tail /aws/lambda/form-guard-$fn --since 3650d > $fn-logs.txt
     aws logs delete-log-group --log-group-name /aws/lambda/form-guard-$fn
   done
   sam build && sam deploy
   ```

   `aws logs tail` の出力は時刻・ストリーム名・本文に整形されたテキストで、忠実なエクスポートでは
   ない（原本が要るなら `aws logs create-export-task` で S3 に出す）。また削除から `sam deploy`
   完了までの間にフォーム送信が入ると Lambda がロググループを作り直し、再び `already exists` で
   落ちる。その場合は削除からやり直す（送信の少ない時間帯が確実）
7. **費用上限の設定**（安全不変条件 7・スキップ不可）: Anthropic Console の Usage limits と
   AWS Budgets を必ず設定する
8. **テスト送信**: 正常系（LEAD 相当）→ Slack 通知確認 → 修正ボタン → DynamoDB の
   `humanLabel` を確認。分類失敗系は `CRITERIA` を壊すのではなく無効な API キーで
   REVIEW フォールバックとアラームを検証する（**ALARM への遷移だけでなく `AlarmEmail` に
   実際にメールが届くところまで確認する**。届かなければ手順5の購読確認が済んでいない）

## 隔離ボックス（SPAM の閲覧・救出導線）

SPAM も削除されず (1) DynamoDB の全レコード、(2) SPAM 専用 Slack チャンネル、の2箇所に残る
（安全不変条件 2）。月1回は SPAM チャンネルを見返し、誤判定があれば修正ボタンで救出する。

## 本番の教訓との対応（詳細は [docs/PITFALLS.md](../../docs/PITFALLS.md)）

| 教訓 | この雛形での実装箇所 |
|---|---|
| A-1 モデル引退のサイレント劣化 | `claude.ts` の `MODEL_ID` 1箇所集約 + `template.yaml` の分類失敗アラーム |
| 安全不変条件5 受付の hard fail が無検知 | `template.yaml` の `ClassifierErrorAlarm`（`"Handler error"` のメトリクスフィルタ）。catch 済みの失敗は Lambda の Errors には乗らない |
| 安全不変条件5 poison pill が滞留アラームから消える | `template.yaml` の `ProcessorErrorAlarm`（`AWS/Lambda` の `Errors`）。標準キューは3回以上受信されたメッセージを `ApproximateAgeOfOldestMessage` の対象から外すため、失敗し続けるメッセージは `QueueAgeAlarm` では検知できない。2本は役割が違う（詳細は template.yaml のコメント） |
| 安全不変条件5 受付が catch 外で落ちると無検知 | `template.yaml` の `ClassifierLambdaErrorAlarm`（`AWS/Lambda` の `Errors`）。`getConfig()` は try の外・タイムアウト/OOM/初期化エラーも同様で、`"Handler error"` のフィルタでは拾えない |
| 安全不変条件2/5 壊れた SQS メッセージが無音で捨てられる | `template.yaml` の `MalformedMessageAlarm`。skip（`continue`）は正常終了なので DLQ にも `Errors` にも乗らず、レコードが `received` のまま取り残される |
| 安全不変条件5/6 修正ボタンが静かに効かなくなる | `template.yaml` の `FeedbackErrorAlarm`（ログ文字列）と `FeedbackLambdaErrorAlarm`（`AWS/Lambda` の `Errors`）。人間の修正 → few-shot 還流が止まると分類精度が静かに劣化するが、分類側のアラームからは原因が分からない |
| F-3 契約文字列の外部注入 | `claude.ts` の `Invalid label` は値を英数字20字に丸め、`JSON.parse` の例外文言も自前に置換（LLM 出力＝フォーム入力の影響下にある文字列が、他のアラームの契約文字列としてロググループに出るのを防ぐ） |
| A-2/A-3 thinking ブロックと max_tokens | `claude.ts` の text ブロック探索・`max_tokens: 4096` |
| A-4 LLM 出力の防御的パース | `claude.ts` の型ガード（label enum / confidence 丸め / reasoning フォールバック+500字） |
| A-5 SDK タイムアウトの階層 | `claude.ts` の `timeout: 60_000, maxRetries: 0`（再試行を断ち単一 60s < Lambda 120s）+ `classifier/processor/feedback.ts` の AWS SDK 各 client に requestTimeout / `throwOnRequestTimeout: true`（無いと超過は警告のみ）/ `socketTimeout`（body 局面の無通信検知）。SDK は `template.yaml` でバンドルし、版が変動する同梱 SDK ではなく `^3.910.0` 以上を使わせる（厳密な版固定は lockfile 側の責務 — 手順4） |
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
- **署名不一致だけはアラームに乗らない**: `SLACK_SIGNING_SECRET` を回して Slack アプリ側とずれると、修正ボタンは全て 401 になるが `feedback.ts` は警告ログを出すだけで、`FeedbackErrorAlarm`（`log.error` が契約）にも `Errors` にも乗らない。公開エンドポイントなので単発の署名不一致で鳴らすとスキャナのノイズでアラーム全体を切られるほうが危険と判断した。**シークレットをローテーションしたら、必ず修正ボタンを1回押して効くことを確認すること**
- **修正ボタンの処理が同期的**: Slack の 3 秒 ack 要件に対し、Secrets 取得〜GSI Query〜UpdateItem〜chat.update を完了してから 200 を返すため、遅延時は Slack 側にエラー表示が出ることがある（**DB への記録は成功していることがある**。メッセージのボタンが残っていれば再度押してよい — 記録済みなら no-op になる）。また GSI は結果整合のため、通知の投稿直後にボタンを押すと逆引きに失敗して無視されることがある（数秒待って押し直せばよい）。厳密にするなら署名検証後に即 ack して処理を非同期化する
- **DynamoDB 保存と SQS 送信が非トランザクション**: PutItem 成功後に SendMessage が失敗すると `received` のまま処理されないレコードが残る（クライアントには 500 が返るため利用者は再送でき、運用者には `form-guard-classifier-errors` アラームが飛ぶ）。PutItem 自体が失敗した場合も同様に 500 + 同アラームで、受付は成立しない＝台帳にも Slack にも出ない（なお `Handler error` を出さずに落ちる失敗＝設定欠落・初期化エラー・タイムアウト・OOM は `ClassifierLambdaErrorAlarm` が拾う）。**この経路の「届く」は「運用者に通知が届く」ではなく「送信者にエラーが返り、運用者にはアラームが飛ぶ」であることに注意**（経路A/B は保存に失敗しても通知・転送に倒れるので形が違う）。厳密にするなら outbox パターンか未投入レコードの定期照合を入れる
- **Lambda のスロットリングによる停滞はどちらのアラームでも見えない**: 同時実行数の上限に当たって invoke が絞られると、`Throttles` は増えるが `Errors` は増えず（`ProcessorErrorAlarm` は鳴らない）、SQS 側では受信カウントが加算されるためメッセージが3回受信を超えて `ApproximateAgeOfOldestMessage` から外れる（`QueueAgeAlarm` も鳴らない）。低流量前提では起きないため雛形には入れていないが、流量が増えたら `AWS/Lambda` の `Throttles` にもアラームを足すこと
- **ロググループはスタック削除後も残る**: 既存スタックへの auto-import（手順6）を成立させるため `DeletionPolicy: Retain` を付けている。`sam delete` で片付けきりたい場合は `aws logs delete-log-group` を手で実行する（新規作成したロググループなら `RetentionInDays: 90` の設定が残るので放置してもログ自体は消える。**手順6(A) で取り込んだ場合は保持期間が無期限のままなので消えない** — import はテンプレートのプロパティを既存リソースに適用しない）
- **Processor の SQS 実行ロールは全キュー対象**: DynamoDB/Secrets の IAM は最小化したが、SAM が SQS イベントソース用に付与する実行ロール（`AWSLambdaSQSQueueExecutionRole`）は `ReceiveMessage`/`DeleteMessage` の Resource が `*`（全キュー）になる。厳密には Processor に custom role を指定し、対象 `ProcessingQueue` の ARN だけに限定する
- **タイムアウトは各 SDK 呼び出し単位で、end-to-end のハード上限ではない**: Anthropic は `maxRetries:0`（60s 単発）、AWS SDK 各 client は明示 requestTimeout + `throwOnRequestTimeout: true` + `socketTimeout`（requestTimeout は headers 到達で解除されるため、body が止まる故障は socketTimeout の無通信検知が受け持つ。SDK はバンドルして `^3.910.0` 以上を保証 — ランタイム同梱 SDK は版が変動し timeout の意味論ごと変わる。ただし caret は下限の保証であって版の固定ではないので、再現可能なビルドが要るなら lockfile をコミットすること）。各呼び出しの実効上限は「maxAttempts × timeout + バックオフ」。残る穴は2つ: (1) データが細く流れ続ける trickle 応答は socketTimeout をすり抜ける — `processor` は Lambda 120s → SQS 再配信 → DLQ アラームで検知され、`classifier` は 25s で死に送信者にエラーが見える（無音の消失にはならない） (2) 複数 await の積み上げが理論上 Lambda 上限を超えうる — 厳密にするなら各 await を Lambda 残時間（`context.getRemainingTimeInMillis()`）ベースの deadline で締める

## 変えてはいけないもの

[docs/DESIGN_PRINCIPLES.md](../../docs/DESIGN_PRINCIPLES.md) の7原則に対応する箇所。特に:
分類の catch → REVIEW フォールバック / SPAM の記録保存 / SQS 分離（fire-and-forget 禁止）/
untrusted タグ / 署名検証 → パースの順序 / `humanLabel` と `aiLabel` の分離 /
検知アラームとログ文言の契約。
