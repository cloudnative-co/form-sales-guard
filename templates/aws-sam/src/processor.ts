/**
 * 非同期ハンドラ雛形: SQS → few-shot 取得 → AI 分類 → 記録更新・Slack 通知
 *
 * 設計の要点:
 *  - 分類（classifyContact）は fail-open で決して throw しない（claude.ts 参照）
 *  - 下流の副作用（記録更新・Slack 通知）は never-reject: 失敗しても throw せず
 *    error ログのみ残す（PITFALLS C-1）。throw すると SQS が再試行し、成功済みの
 *    通知まで再実行される（非冪等な二重実行）。その代償として DLQ にもアラームにも
 *    自然には乗らないため、template.yaml のメトリクスフィルタ + アラームが
 *    これらの失敗の唯一の検知手段になる（ペア設計・安全不変条件 5）
 *  - 速度は fire-and-forget ではなく Promise.allSettled の並列化で稼ぐ（PITFALLS B-1）
 */
import type { SQSEvent } from 'aws-lambda';
import {
  DynamoDBClient,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  createClaudeClient,
  classifyContact,
  type ClassificationCriteria,
  type ClassificationResult,
  type ClassificationLabel,
  type FewShotExample,
} from './claude.js';
import type { FormInput, ProcessorMessage } from './classifier.js';

const log = {
  info: (msg: string, data?: object) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  warn: (msg: string, data?: object) => console.warn(JSON.stringify({ level: 'warn', msg, ...data })),
  error: (msg: string, data?: object) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
};

// ---------------------------------------------------------------------------
// 判定基準（導入者が生成して差し替える）
// prompts/classifier-skeleton.md の手順で、実際に届いた営業メッセージから
// 類型化して生成する。生成した基準は導入者のものであり、公開リポジトリに
// 投稿しない。以下はプレースホルダー。
// ---------------------------------------------------------------------------
const CRITERIA: ClassificationCriteria = {
  companyName: 'YOUR_COMPANY_NAME',
  companyBlock: `## 会社について
（prompts/classifier-skeleton.md のブロック①をここに生成する）`,
  labelBlock: `## 分類ラベル
（prompts/classifier-skeleton.md のブロック②をここに生成する。
LEAD/SPAM/REVIEW の 3 ラベル構成は変えないこと）`,
};

// few-shot 取得は付加価値機能にすぎない。短いタイムアウト + キャッシュ + 失敗時は
// 例なしで続行とし、付加機能の障害がコア機能（分類）を人質に取らない構造にする
// （PITFALLS A-7）。キャッシュはモジュールレベル = Lambda 実行環境の再利用間で生きる。
let cachedExamples: FewShotExample[] | null = null;
let cacheTimestamp = 0;
const FEW_SHOT_CACHE_TTL_MS = 10 * 60 * 1000;
const FEW_SHOT_FETCH_TIMEOUT_MS = 3000;
const FEW_SHOT_LIMIT = 10;

const ddbClient = new DynamoDBClient({});
const smClient = new SecretsManagerClient({});

// Secrets Manager からの取得もモジュールレベルでキャッシュし、必須キーを fail-fast
// 検証する（PITFALLS B-4）。シークレットを環境変数に直接置かないための構成。
interface Secrets {
  ANTHROPIC_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
}
let cachedSecrets: Secrets | null = null;
const getSecrets = async (): Promise<Secrets> => {
  if (cachedSecrets) return cachedSecrets;
  const arn = process.env.SECRETS_ARN;
  if (!arn) throw new Error('Missing required environment variable: SECRETS_ARN');
  const res = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(res.SecretString || '{}') as Record<string, unknown>;
  for (const key of ['ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) {
      throw new Error(`Missing required secret key: ${key}`);
    }
  }
  cachedSecrets = parsed as unknown as Secrets;
  return cachedSecrets;
};

const getConfig = () => {
  const required = ['TABLE_NAME', 'SLACK_CHANNEL_LEADS', 'SLACK_CHANNEL_REVIEW', 'SLACK_CHANNEL_SPAM'] as const;
  for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
  return {
    TABLE_NAME: process.env.TABLE_NAME!,
    channels: {
      LEAD: process.env.SLACK_CHANNEL_LEADS!,
      REVIEW: process.env.SLACK_CHANNEL_REVIEW!,
      // SPAM も通知チャンネルを分けて必ず流す（安全不変条件 2: 隔離であって削除ではない）
      SPAM: process.env.SLACK_CHANNEL_SPAM!,
    } satisfies Record<ClassificationLabel, string>,
  };
};

// SQS メッセージも外部入力として扱い、ランタイムで型検証する。
// 不正メッセージは throw せず skip する（再試行しても直らないため DLQ 行きにしない）
const validateMessage = (data: unknown): ProcessorMessage | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'contact') return null;
  if (typeof obj.recordId !== 'string' || !obj.recordId || obj.recordId.length > 200) return null;
  const input = obj.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const inp = input as Record<string, unknown>;
  for (const key of ['inquiryType', 'company', 'lastName', 'firstName', 'email', 'message']) {
    if (typeof inp[key] !== 'string') return null;
  }
  return { type: 'contact', input: inp as unknown as FormInput, recordId: obj.recordId };
};

/** 人間が修正したレコード（CorrectedIndex）から few-shot 例を取得する */
const fetchFewShotExamples = async (tableName: string): Promise<FewShotExample[]> => {
  const res = await ddbClient.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'CorrectedIndex',
    KeyConditionExpression: 'feedbackPartition = :p',
    ExpressionAttributeValues: { ':p': { S: 'corrected' } },
    ScanIndexForward: false, // 新しい修正を優先
    Limit: FEW_SHOT_LIMIT,
  }));
  return (res.Items || [])
    .filter((item) => item.humanLabel?.S && item.company?.S && item.message?.S)
    .map((item) => ({
      input: { company: item.company!.S!, message: item.message!.S! },
      label: item.humanLabel!.S! as ClassificationLabel,
    }));
};

const getFewShotExamples = async (tableName: string): Promise<FewShotExample[]> => {
  const now = Date.now();
  if (cachedExamples && now - cacheTimestamp < FEW_SHOT_CACHE_TTL_MS) return cachedExamples;
  try {
    const examples = await Promise.race([
      fetchFewShotExamples(tableName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Few-shot fetch timeout')), FEW_SHOT_FETCH_TIMEOUT_MS),
      ),
    ]);
    cachedExamples = examples;
    cacheTimestamp = Date.now();
    return examples;
  } catch (error) {
    log.warn('Few-shot fetch failed, continuing without examples', { error: String(error) });
    return cachedExamples || [];
  }
};

const escapeSlackMrkdwn = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 通知メッセージ（修正ボタン付き）を組み立てる。
 * AI 判定と同じラベルのボタンは出さない（PITFALLS D-4: 同一ラベルボタンは
 * 「承認・確認」のつもりで押され、修正記録にノイズが混入する実話あり）。
 */
const buildSlackBlocks = (
  input: FormInput,
  result: ClassificationResult,
  recordId: string,
): object[] => {
  // 分類失敗は ⚠️ 付きで通常通知と区別する（安全不変条件 5 の最小構成）
  const failed = result.confidence === 0 && result.label === 'REVIEW';
  const header = failed ? ':warning: AI分類失敗（要人間確認）' : `[${result.label}] 新しい問い合わせ`;
  const otherLabels = (['LEAD', 'REVIEW', 'SPAM'] as const).filter((l) => l !== result.label);
  const mrkdwn = (text: string) => ({ type: 'mrkdwn', text });

  return [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    {
      type: 'section',
      fields: [
        mrkdwn(`*会社名*\n${escapeSlackMrkdwn(input.company)}`),
        mrkdwn(`*名前*\n${escapeSlackMrkdwn(`${input.lastName} ${input.firstName}`)}`),
      ],
    },
    { type: 'section', text: mrkdwn(`*本文*\n${escapeSlackMrkdwn(input.message.slice(0, 1000))}`) },
    {
      type: 'context',
      elements: [mrkdwn(`AI判定: *${result.label}* (confidence ${result.confidence}) — ${escapeSlackMrkdwn(result.reasoning)}`)],
    },
    {
      type: 'actions',
      block_id: 'correction_actions',
      elements: otherLabels.map((label) => ({
        type: 'button',
        action_id: `correction_${label}`,
        text: { type: 'plain_text', text: `${label} に修正` },
        // value の recordId は改ざんされうる前提で、feedback.ts が逆引き突合する（PITFALLS D-3）
        value: `${label}:${recordId}`,
      })),
    },
  ];
};

/** Slack chat.postMessage（never-reject: 失敗は契約文字列のログのみ） */
const postToSlack = async (
  botToken: string,
  channel: string,
  blocks: object[],
  fallbackText: string,
): Promise<{ ok: boolean; ts?: string }> => {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ channel, blocks, text: fallbackText }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { ok: true, ts: data.ts };
  } catch (error) {
    // "Slack post failed" は template.yaml のメトリクスフィルタとの契約文字列
    log.error('Slack post failed', { error: error instanceof Error ? error.message : String(error) });
    return { ok: false };
  }
};

/** 記録に AI 判定を書き込む（never-reject）。人間ラベルとは別フィールド（PITFALLS D-5） */
const updateClassification = async (
  tableName: string,
  recordId: string,
  result: ClassificationResult,
): Promise<void> => {
  try {
    await ddbClient.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { recordId: { S: recordId } },
      UpdateExpression: 'SET aiLabel = :l, aiConfidence = :c, aiReasoning = :r, #st = :s',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':l': { S: result.label },
        ':c': { N: String(result.confidence) },
        ':r': { S: result.reasoning },
        ':s': { S: 'classified' },
      },
    }));
  } catch (error) {
    // "Failed to update classification" は template.yaml のメトリクスフィルタとの契約文字列
    log.error('Failed to update classification', {
      recordId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Slack メッセージ ts を記録に保存（feedback.ts の IDOR 逆引き突合に必須） */
const updateSlackInfo = async (
  tableName: string,
  recordId: string,
  channel: string,
  ts: string,
): Promise<void> => {
  await ddbClient.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { recordId: { S: recordId } },
    UpdateExpression: 'SET slackChannel = :c, slackMessageTs = :t',
    ExpressionAttributeValues: { ':c': { S: channel }, ':t': { S: ts } },
  }));
};

const processContact = async (
  cfg: ReturnType<typeof getConfig>,
  secrets: Secrets,
  msg: ProcessorMessage,
): Promise<void> => {
  const { input, recordId } = msg;

  // 1. few-shot 取得（失敗しても分類は止めない）
  const examples = await getFewShotExamples(cfg.TABLE_NAME);

  // 2. AI 分類（fail-open: 失敗は REVIEW として返ってくる。throw しない）
  const claudeClient = createClaudeClient(secrets.ANTHROPIC_API_KEY);
  const result = await classifyContact(claudeClient, CRITERIA, input, examples);

  // 3. 記録更新と Slack 通知を並列実行。どちらも never-reject のため rejected 分岐は
  //    不要。検知は CloudWatch メトリクスフィルタ + アラーム側で行う（template.yaml）
  const channel = cfg.channels[result.label];
  const blocks = buildSlackBlocks(input, result, recordId);
  const fallbackText = `[${result.label}] ${input.company} からの問い合わせ`;

  const [, slackResult] = await Promise.allSettled([
    updateClassification(cfg.TABLE_NAME, recordId, result),
    postToSlack(secrets.SLACK_BOT_TOKEN, channel, blocks, fallbackText),
  ]);

  // 4. Slack ts の保存（修正ボタン → レコードの逆引きに使う）
  if (slackResult.status === 'fulfilled' && slackResult.value.ok && slackResult.value.ts) {
    await updateSlackInfo(cfg.TABLE_NAME, recordId, channel, slackResult.value.ts).catch((err) =>
      log.error('Failed to update Slack info', { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  log.info('Processing complete', { recordId, label: result.label, channel });
};

export const handler = async (event: SQSEvent): Promise<void> => {
  const cfg = getConfig();
  const secrets = await getSecrets();

  for (const record of event.Records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.body);
    } catch (error) {
      log.error('Invalid JSON in SQS message, skipping', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue; // 再試行しても直らないため skip（DLQ 行きにしない）
    }

    const msg = validateMessage(parsed);
    if (!msg) {
      log.error('Invalid SQS message structure, skipping', { messageId: record.messageId });
      continue;
    }

    try {
      await processContact(cfg, secrets, msg);
    } catch (error) {
      // ここに来るのは infra レベルの予期しない失敗のみ（分類・通知・記録更新は
      // それぞれ内部で catch 済み）。throw して SQS の再試行 → 5 回失敗で DLQ +
      // アラームに乗せる（template.yaml の RedrivePolicy 参照）
      log.error('Processor error', {
        recordId: msg.recordId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
};
