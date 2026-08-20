import type { ClassificationCriteria } from './claude.js';

/**
 * 判定基準のプレースホルダー。
 *
 * これをコピーして src/criteria.ts を作り（.gitignore 済み）、
 * prompts/classifier-skeleton.md の手順で「実際に届いた営業メッセージ」から
 * ブロック①（会社知識）・②（LEAD/SPAM 基準）を類型化して生成する。
 *
 * criteria.ts はあなたのローカル資産であり、公開リポジトリに投稿しない
 * （tracked な processor.ts に機微な判定基準を書かせないための分離）。
 * 実在の社名・人名や、貼られた営業文面の原文をそのまま書かないこと。
 */
export const CRITERIA: ClassificationCriteria = {
  companyName: 'YOUR_COMPANY_NAME',
  companyBlock: `## 会社について
（prompts/classifier-skeleton.md のブロック①をここに生成する）`,
  labelBlock: `## 分類ラベル
（prompts/classifier-skeleton.md のブロック②をここに生成する。
LEAD/SPAM/REVIEW の 3 ラベル構成は変えないこと）`,
};
