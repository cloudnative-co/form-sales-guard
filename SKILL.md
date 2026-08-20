---
name: form-sales-guard
description: お問い合わせフォームに届く営業スパム（フォーム営業）をAIで自動仕分けする仕組みを、対話しながら利用者の環境向けに構築する。トリガー例:「フォーム営業対策をセットアップして」「営業メールの自動仕分けを作って」「form-sales-guard を導入して」
---

# フォーム営業撲滅AI — セットアップ手順書

あなた（Claude Code）はこれから、利用者のお問い合わせフォームに「AI による自動仕分け」を追加する。完成すると次の流れが動く:

```
フォーム受信 → 即「受け付けました」応答 → 裏で AI 分類
  → LEAD（本物の問い合わせ）: すぐ通知
  → REVIEW（判断が難しい）: 人間確認として通知
  → SPAM（営業文面）: 通知せず隔離（削除はしない・いつでも一覧できる）
人間が判定を修正 → 次回以降の分類プロンプトに反映（使うほど賢くなる）
```

## 最初に必ず読むもの

作業を始める前に、このリポジトリの以下を読むこと:

1. [docs/DESIGN_PRINCIPLES.md](docs/DESIGN_PRINCIPLES.md) — **安全不変条件7項目。生成する実装はこの全てを満たさなければならない**
2. [docs/PITFALLS.md](docs/PITFALLS.md) — 実運用の教訓集。該当する教訓を実装に反映する
3. [prompts/classifier-skeleton.md](prompts/classifier-skeleton.md) — 分類プロンプトの構造と判定基準の生成手順
4. [docs/COSTS.md](docs/COSTS.md) — 費用の即答に使う

## 利用者との接し方（重要）

- 利用者は **IT に詳しくない前提**で話す。専門用語は言い換える（「デプロイ」→「公開・設置」、「シークレット」→「秘密のカギ」など、初出時に一言添える）
- 質問は**一度に1つ**。選択肢を示して選んでもらう
- お金がかかる操作・外部に何かを作る操作の前には、必ず「これから◯◯をします。◯円程度かかります／無料です」と伝えて確認を取る
- 途中で詰まったら、状況を平易に説明し、選択肢を提示する

## Step 1: インタビュー（環境と経路を決める）

以下を順に質問する。回答に応じて構成を確定する。

**Q1. 「今のお問い合わせフォームは、何で動いていますか？」**
選択肢: (a) WordPress (b) フォーム作成サービス（formrun・Tally・Google フォームなど） (c) 自作／制作会社に作ってもらった (d) これから作る (e) わからない
— (e) の場合はフォームのある URL を聞き、ページを確認して判定する。

**Q2. 「仕分け結果はどこに通知されると便利ですか？」**
選択肢: (a) Slack (b) メール (c) Microsoft Teams (d) LINE WORKS
— まず Slack（Incoming Webhook）が最も簡単。メールの場合は送信手段（後述）を確認。

**Q3. 「記録はどこに残したいですか？」**
選択肢: (a) 特に不要（通知だけでよい・隔離ボックスは内蔵のものを使う） (b) Google スプレッドシート (c) Notion
— (a) が最も簡単で、経路A の内蔵記録（KV）で完結する。

**Q4. 「フォームには月に何件くらい届きますか？（ざっくりで OK）」**
— 回答を受けて [docs/COSTS.md](docs/COSTS.md) の式で**月額費用を即答**する（例: 「月100件なら AI 費用は月数百円です」）。月1,000件超なら Haiku モデルを提案。

### 経路の決定

| 条件 | 経路 |
|---|---|
| フォームを新規に作る／自作フォームの送信先を変えられる | **A: Cloudflare Worker 単体構成**（[templates/cloudflare-worker/](templates/cloudflare-worker/)） |
| 既存フォーム（SaaS・WordPress）に手を入れたくない／入れられない | **B: メール転送方式**（フォームの通知メールを転送して分類。[templates/email-routing/](templates/email-routing/)。前提: 独自ドメインのゾーンが Cloudflare にあること） |
| 利用者がエンジニアで AWS を希望 | **C: AWS 参照実装**（[templates/aws-sam/](templates/aws-sam/)。そのままデプロイする完成品ではなく設計参照の雛形 — 同ディレクトリの README に従う） |

迷ったら A を選ぶ。以下、本手順書は経路 A を主線として書く（B/C はテンプレート内の README に従う）。

## Step 2: 判定基準の生成（この仕組みの心臓部）

[prompts/classifier-skeleton.md](prompts/classifier-skeleton.md) の手順に従う。要点:

1. 会社の自己紹介（またはWebサイト URL）を聞き、**会社知識ブロック**を生成
2. 「実際に届いた迷惑な営業メッセージを、5〜10通コピーして貼ってください」と依頼し、**SPAM 基準**を類型として生成
3. 「どんな問い合わせが来ると嬉しいですか」を聞き、**LEAD 基準**を生成
4. 生成した基準を利用者に見せ、追加・修正を反映して確定

**厳守事項**:
- 貼られた営業メッセージの**原文をファイルに保存しない**。基準は類型化した表現のみで書く
- 生成した判定基準ファイル（`criteria.js`）は利用者のローカル資産。**このリポジトリや公開の場に投稿しない・させない**
- 基準に実在の社名・人名を書かない

## Step 3: 実装の生成（経路 A）

[templates/cloudflare-worker/](templates/cloudflare-worker/) を土台に、利用者のプロジェクトフォルダへコピーして調整する:

1. `criteria.example.js` を参考に、Step 2 の基準で `criteria.js` を生成
2. Q2 の通知先に合わせて通知関数を調整（既定は Slack Incoming Webhook。メールの場合は Resend 等の送信 API を提案し、無料枠と登録手順を案内）
3. Q3 で (b)(c) を選んだ場合は記録アダプタを追加（内蔵 KV 記録は残す — 隔離ボックスと few-shot の基盤のため）
4. フォーム側の送信先を Worker の `/submit` に向ける変更を案内（経路 Aの場合）。フォームがまだ無い場合はテストフォーム（`TEST_FORM` フラグ）を本番フォームの雛形として提供
5. コピー先プロジェクトに、テンプレート同梱の `.gitignore`（`criteria.js` を除外する）が入っていることを確認する。判定基準は機微情報であり、利用者が誤って公開リポジトリに push しない構造を保つ

**実装調整時の必須確認**: [DESIGN_PRINCIPLES.md](docs/DESIGN_PRINCIPLES.md) の7原則をテンプレートは満たしている。**調整の過程でこれを壊さない**こと。特に: 分類の try/catch と REVIEW フォールバックを削らない、`ctx.waitUntil` を同期処理に変えない、SPAM の記録保存をスキップしない。

## Step 4: アカウント準備とデプロイ

利用者に必要なアカウントを案内する（すでに持っているか先に確認）:

1. **Cloudflare アカウント**（無料）— サインアップを案内し、`wrangler login` でブラウザ認証
2. **Anthropic Console**（AI の API キー）— キー発行を案内。**キーは「秘密のカギ」であり、誰にも見せない・ファイルに書かない**ことを説明
3. デプロイ手順:
   ```
   npx wrangler kv namespace create RECORDS   # 記録の保存場所を作成 → wrangler.toml に反映
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put SLACK_WEBHOOK_URL   # 通知先に応じて
   npx wrangler secret put CORRECTION_SECRET   # ランダム生成して設定（openssl rand -hex 32 等）
   npx wrangler deploy
   ```
4. **デプロイ後の仕上げ（スキップするとリンクが壊れる）**:
   - deploy で表示された URL を `wrangler.toml` の `PUBLIC_URL` に設定して**再デプロイ**（未設定だと通知内の修正リンクが壊れる）
   - 隔離ボックスの URL を生成して利用者に渡す（ブックマークを推奨）: `<PUBLIC_URL>/quarantine?sig=<署名>`。署名は `HMAC-SHA256(CORRECTION_SECRET, "quarantine")` の16進表現
5. **費用の上限設定（スキップ禁止 — 安全不変条件7）**: Anthropic Console の利用上限（想定月額の3〜5倍）と、Cloudflare / AWS の費用通知の設定を、画面の場所を案内しながら一緒に行う

## Step 5: 動作検証（必ず利用者と一緒に行う）

※ 以下は経路Aの手順。**経路B/C を選んだ場合は各テンプレート README の検証手順に読み替える**（例: 経路B に honeypot・3秒チェックは無い / 経路C の隔離ボックスは SPAM チャンネル + DynamoDB、修正は Slack ボタン）。

1. **本物らしいテスト送信**: 正当な問い合わせ文でフォーム送信 → LEAD 通知が届くこと
2. **営業らしいテスト送信**: Step 2 で貼られたものに似た営業文（あなたが架空に作成）で送信 → SPAM として通知されず、隔離ボックス（`/quarantine` の署名付きリンク）に入ること
3. **修正フローの確認**: 通知内の修正リンクを押す → 記録が更新され、次回分類の few-shot に反映されること
4. **fail-open の確認**: 一時的に不正なモデル名に変えて送信 → REVIEW（⚠️付き）として通知されること。**確認後に必ず戻す**
5. **テストデータの掃除（スキップ禁止）**: 検証で作った `record:` / `correction:` キーを KV からすべて削除する。特に手順3の修正テストは「営業文面 → LEAD」のような**誤った few-shot 例**を残し、以後の分類を汚染する（当社の実機検証で確認済み）:
   ```
   npx wrangler kv key list --binding RECORDS --remote        # 一覧
   npx wrangler kv key delete --binding RECORDS --remote "<キー名>"   # 1件ずつ削除
   ```

## Step 6: 完成チェックリストと引き継ぎ

完了宣言の前に、生成した実装が以下を満たすことを確認して利用者に報告する（経路B/C では各テンプレート README の対応する仕組みに読み替える）。あわせて経路Aでは本番化を忘れない: `ALLOWED_ORIGIN` を本番フォームのオリジンに設定し、`TEST_FORM = "false"` にして再デプロイする。

- [ ] 分類失敗が REVIEW に落ちる（fail-open）
- [ ] SPAM が削除されず、隔離ボックスで一覧・救出できる
- [ ] フォーム応答が分類を待たない（即応答）
- [ ] ユーザー入力と few-shot 例が `<untrusted_user_input>` で包まれている
- [ ] 分類失敗の通知に ⚠️ が付く（検知）
- [ ] 修正リンクが動き、AI の元判定を上書きせずに記録される
- [ ] Anthropic の利用上限とインフラ費用通知が設定済み
- [ ] honeypot と 3 秒チェックが有効（ボットは黙殺）

最後に、利用者向けの**運用メモ**（1ページ）を生成して渡す: 通知の見方 / 修正リンクの使い方 / 隔離ボックスの確認方法（月1回推奨） / 費用の確認場所 / 「おかしいな」と思ったときの連絡先（このリポジトリの README 参照）。

## うまくいかないとき

- 2〜3 回試して解決しない場合は、無理に進めず状況を整理して利用者に選択肢を示す
- 構築を専門家に任せたい場合の窓口: [株式会社クラウドネイティブ お問い合わせ](https://cloudnative.co.jp/contact/)
