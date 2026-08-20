# フォーム営業撲滅AI（form-sales-guard）

お問い合わせフォームに届く「フォーム営業」（人間・代行業者・AIエージェントが送ってくる営業文面）を、AI が自動で仕分けする仕組みを **あなたの環境に合わせて構築するためのレシピ** です。

> **撲滅されるのは、営業文面を読むあなたの時間です。**
> メッセージは削除されず隔離ボックスに残るので、万一の誤判定でも隔離ボックスから確認・救出できます（メール転送方式では保存範囲に制約あり。[経路B の注記](templates/email-routing/README.md)参照）。

## これは何か

- 完成品のソフトウェアではなく、**Claude Code（AI コーディングエージェント）が読んで実行する「作り方」** です
- あなたのフォーム・通知先（Slack / メール等）・記録先に合わせて、Claude Code が対話しながら組み立てます
- 株式会社クラウドネイティブが自社サイトで実際に運用している仕組みの設計・教訓・費用データを基にしています

**実績**: 運用約6ヶ月・AI分類494件のうち人手修正9件(1.8%)。SPAM判定に埋もれたリードの救出は0件 —— 営業文面377件（全問い合わせの約7割）が人の目に触れずに隔離され、本物の問い合わせの取りこぼしは検知されていません。（※当社環境・当社基準での数値です）

## はじめかた（3ステップ）

必要なもの: **Claude Code**（利用プランが必要）/ **Anthropic API キー**（従量課金・カード登録が必要。月100件なら数百円程度）/ **Cloudflare アカウント**（無料）。

1. **Claude Code を用意する** — 初めての方は [claude-code-starter-kit](https://github.com/cloudnative-co/claude-code-starter-kit) の対話型ウィザードで環境を作れます
2. **次の1行を Claude Code に貼る**

   ```
   https://github.com/cloudnative-co/form-sales-guard の SKILL.md を読んで、フォーム営業対策のセットアップを始めて
   ```

3. **質問に答える** — 今のフォーム・通知したい場所・月の件数などを聞かれるので、答えるだけで完成します

かかる費用の目安: **月100件のフォームなら AI 費用は月数百円**（詳細は [docs/COSTS.md](docs/COSTS.md)）。

## リポジトリの構成

| パス | 内容 |
|---|---|
| [SKILL.md](SKILL.md) | 本体。Claude Code が実行するセットアップ手順書（インタビュー → 生成 → デプロイ → 検証） |
| [docs/DESIGN_PRINCIPLES.md](docs/DESIGN_PRINCIPLES.md) | 安全不変条件 —— どの構成でも破ってはいけない7つの設計原則 |
| [docs/PITFALLS.md](docs/PITFALLS.md) | 実運用で痛い目を見た教訓集（本番障害の実話を含む） |
| [docs/COSTS.md](docs/COSTS.md) | 費用の実測と見積り（AI API・インフラ別、流量別） |
| [prompts/classifier-skeleton.md](prompts/classifier-skeleton.md) | 分類プロンプトの構造と「あなた専用の判定基準」の作らせ方 |
| [templates/cloudflare-worker/](templates/cloudflare-worker/) | 経路A: Cloudflare Worker 単体構成（初心者向けデフォルト） |
| [templates/email-routing/](templates/email-routing/) | 経路B: メール転送方式 —— 既存フォームを一切変えずに導入（通知メールを転送するだけ） |
| [templates/aws-sam/](templates/aws-sam/) | 経路C: AWS 参照実装 —— 当社が実運用している構成のサニタイズ版（エンジニア向け雛形） |
| [tools/eval.mjs](tools/eval.mjs) | 事前検収スクリプト —— 生成した判定基準を、あなたの実際のメールで運用前にテスト |
| [site/](site/) | 公開サイト（[form-sales-guard.cn-shinji.workers.dev](https://form-sales-guard.cn-shinji.workers.dev)）のソース |

## 大事な注意

- これは**レシピであり、サポート付き製品ではありません**。Issue への返答は保証されません
- 生成される実装は「自動削除」を絶対にしません（[安全不変条件](docs/DESIGN_PRINCIPLES.md) 参照）。この原則を外した改造は推奨しません
- 判定基準はあなたに実際に届いた営業メッセージから、あなたの手元で生成されます。このリポジトリに実際の営業文面を投稿しないでください

## 自分でやりたくない方へ

この仕組みの構築・運用を **株式会社クラウドネイティブが代わりに行うこと** もできます。お気軽にご相談ください → [お問い合わせ](https://cloudnative.co.jp/contact/)

## ライセンス

[MIT](LICENSE) © 2026 株式会社クラウドネイティブ（CloudNative Inc.）
