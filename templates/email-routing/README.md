# 経路B: メール転送方式（準備中）

**既存のフォームに一切手を入れずに導入する**ための経路。フォームサービス（formrun 等）や WordPress からの通知メールを Cloudflare Email Routing で受け、Email Worker が分類して振り分ける。

```
既存フォーム → 通知メール → 専用アドレス（Email Routing）→ Email Worker
  → 分類 → LEAD/REVIEW: 件名に [LEAD]/[要確認] を付けて本来の宛先へ転送
         → SPAM: 転送せず KV に隔離（経路Aと同じ隔離ボックス）
```

## 状態

このテンプレートは**ステップ3（経路B/C の実機検証）で追加予定**。

それまでの代替案: 通知メールを受け取れるアドレスから経路Aの Worker `/submit` に中継する（メール本文のパースが必要になるため、フォームの通知メール形式に合わせた調整を Claude Code と相談すること）。

## 前提（実装時の要件メモ）

- Cloudflare に独自ドメインのゾーンがあること（Email Routing の要件）
- 分類ロジック・隔離・修正リンクは経路Aと共通化する（`src/index.js` の classify / quarantine を流用）
- 安全不変条件（docs/DESIGN_PRINCIPLES.md）は経路によらず全て適用
