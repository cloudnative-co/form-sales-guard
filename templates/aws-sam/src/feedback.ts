/**
 * Slack 修正ボタン雛形: 署名検証 → IDOR 突合 → 人間ラベル記録 → メッセージ更新
 *
 * セキュリティ上の順序が最重要:
 *  1. Base64 デコード（API Gateway は body を Base64 エンコードすることがある — PITFALLS D-2）
 *  2. 署名検証（生 body に対して。タイミングセーフ比較 + 300 秒リプレイ窓）
 *  3. 検証成功後にのみ body をパース（PITFALLS D-1: parse を先にやると不正 JSON で
 *     500 が返り、署名を素通りした内部エラーを外部から誘発できる。
 *     順序は「不正JSON+不正署名→401」「不正JSON+正署名→500」の回帰テストで固定する）
 *  4. ボタン value の recordId は信用せず、メッセージ ts からの逆引きで実レコードと
 *     突合してから書き込む（PITFALLS D-3: IDOR 対策）
 *
 * 記録の原則: 人間の修正は humanLabel（別フィールド）に保存し、AI の元判定
 * （aiLabel）を上書きしない（PITFALLS D-5: 上書きすると精度測定が永久にできなくなる）。
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { ClassificationLabel } from './claude.js';

const log = {
  info: (msg: string, data?: object) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  warn: (msg: string, data?: object) => console.warn(JSON.stringify({ level: 'warn', msg, ...data })),
  error: (msg: string, data?: object) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
};

// AWS SDK v3 の既定 requestTimeout は無制限。Slack の 3 秒 ack 要件（PITFALLS D）に対し、
// DynamoDB / Secrets がハングすると Lambda 25s まで粘って Slack 側にエラー表示が出る。
// 明示タイムアウトで内側を短くする（厳密な 3 秒 ack には非同期化が必要 — README 参照）。
// throwOnRequestTimeout を付けないと requestTimeout 超過は警告ログのみでリクエストが
// 継続する（= 無制限のまま）。requestTimeout は headers 到達で解除されるため、body が
// 止まる故障は socketTimeout（無通信検知）が受け持つ（SDK は template.yaml でバンドルし ^3.910.0 以上を保証）。
// 実効上限は maxAttempts × timeout + バックオフ。
const AWS_CLIENT_CONFIG = {
  requestHandler: { requestTimeout: 8_000, connectionTimeout: 3_000, socketTimeout: 8_000, throwOnRequestTimeout: true },
  maxAttempts: 2,
};
const ddbClient = new DynamoDBClient(AWS_CLIENT_CONFIG);
const smClient = new SecretsManagerClient(AWS_CLIENT_CONFIG);

interface Secrets {
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
  for (const key of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) {
      throw new Error(`Missing required secret key: ${key}`);
    }
  }
  cachedSecrets = parsed as unknown as Secrets;
  return cachedSecrets;
};

const getHeader = (
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined => {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
};

/**
 * Slack 署名検証。basestring は `v0:{timestamp}:{body}` の HMAC-SHA256。
 * - リプレイ窓 300 秒: 古いリクエストの再送（キャプチャしたペイロードの再利用）を拒否
 * - timingSafeEqual: 文字列比較のタイミング差から署名を推測される攻撃を防ぐ。
 *   長さ不一致で throw するため try/catch で false に落とす
 */
export const verifySlackSignature = (
  signingSecret: string,
  signature: string | undefined,
  timestamp: string | undefined,
  body: string,
): boolean => {
  if (!signature || !timestamp) {
    log.warn('Missing signature or timestamp');
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 300) {
    log.warn('Timestamp outside replay window', { diff: Math.abs(now - tsNum) });
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${createHmac('sha256', signingSecret).update(sigBasestring).digest('hex')}`;

  try {
    return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
};

/** API Gateway が body を Base64 エンコードしてくる場合のデコード（PITFALLS D-2）。
 *  デコードせずに署名検証すると正規リクエストまで全部 401 になる */
const resolveBody = (event: APIGatewayProxyEvent): string => {
  if (event.isBase64Encoded && event.body) {
    return Buffer.from(event.body, 'base64').toString('utf-8');
  }
  return event.body || '';
};

/** ボタン value（"LABEL:recordId"）のパース。この recordId はまだ信用しない */
const parseCorrectionValue = (
  value: string,
): { label: ClassificationLabel; recordId: string } | null => {
  const sep = value.indexOf(':');
  if (sep === -1) return null;
  const label = value.slice(0, sep);
  const recordId = value.slice(sep + 1);
  if (!['LEAD', 'REVIEW', 'SPAM'].includes(label) || !recordId) return null;
  return { label: label as ClassificationLabel, recordId };
};

/** Slack メッセージ ts からレコードを逆引きする（SlackTsIndex GSI） */
const findRecordByMessageTs = async (
  tableName: string,
  messageTs: string,
): Promise<{ recordId: string } | null> => {
  const res = await ddbClient.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'SlackTsIndex',
    KeyConditionExpression: 'slackMessageTs = :ts',
    ExpressionAttributeValues: { ':ts': { S: messageTs } },
    Limit: 1,
  }));
  const item = res.Items?.[0];
  return item?.recordId?.S ? { recordId: item.recordId.S } : null;
};

const ok = (headers: Record<string, string>): APIGatewayProxyResult => ({
  statusCode: 200,
  headers,
  body: JSON.stringify({ ok: true }),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const tableName = process.env.TABLE_NAME;
    if (!tableName) throw new Error('Missing required environment variable: TABLE_NAME');
    const secrets = await getSecrets();

    // 1. Base64 デコード → 2. 署名検証（パースより必ず先）
    const body = resolveBody(event);
    const valid = verifySlackSignature(
      secrets.SLACK_SIGNING_SECRET,
      getHeader(event.headers, 'x-slack-signature'),
      getHeader(event.headers, 'x-slack-request-timestamp'),
      body,
    );
    if (!valid) {
      log.warn('Invalid Slack signature');
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    // 3. 検証成功後にのみパース（Slack の interactive payload は form-encoded の
    //    "payload" パラメータに JSON が入る）
    const payloadStr = new URLSearchParams(body).get('payload');
    if (!payloadStr) return ok(headers);
    const payload = JSON.parse(payloadStr) as {
      type: string;
      user: { id: string };
      channel: { id: string };
      message: { ts: string; blocks?: Array<Record<string, unknown>> };
      actions: Array<{ action_id: string; value: string }>;
    };

    if (payload.type !== 'block_actions') return ok(headers);
    const action = payload.actions?.[0];
    if (!action?.action_id?.startsWith('correction_')) return ok(headers);

    const correction = parseCorrectionValue(action.value);
    if (!correction) {
      log.warn('Invalid correction value');
      return ok(headers);
    }

    // 4. IDOR 対策: ボタン value の recordId を信用せず、メッセージ ts からの
    //    逆引きで実レコードと突合する。不一致 = payload 改ざんとみなし黙って無視
    //    （Slack への応答は常に 200: 攻撃者に成否を教えない）
    const verifiedRecord = await findRecordByMessageTs(tableName, payload.message.ts);
    if (!verifiedRecord || verifiedRecord.recordId !== correction.recordId) {
      log.warn('Correction record ID mismatch', {
        claimed: correction.recordId,
        actual: verifiedRecord?.recordId,
      });
      return ok(headers);
    }

    // 5. 人間ラベルを別フィールドに記録（aiLabel は上書きしない — PITFALLS D-5）。
    //    feedbackPartition = "corrected" を立てることで CorrectedIndex に載り、
    //    processor の few-shot 例として次回以降の分類に還流する（安全不変条件 6）
    await ddbClient.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { recordId: { S: correction.recordId } },
      UpdateExpression:
        'SET humanLabel = :l, correctedAt = :t, correctedBy = :u, feedbackPartition = :p',
      ExpressionAttributeValues: {
        ':l': { S: correction.label },
        ':t': { S: new Date().toISOString() },
        ':u': { S: payload.user.id },
        ':p': { S: 'corrected' },
      },
    }));

    log.info('Correction recorded', { recordId: correction.recordId, label: correction.label });

    // 6. 元メッセージのボタンを結果テキストに置き換え（二重押下の防止と操作の可視化）。
    //    ここの失敗は修正記録の成功を巻き戻さないため never-reject
    try {
      const updatedBlocks = (payload.message.blocks || []).map((block) =>
        block.block_id === 'correction_actions'
          ? {
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                text: `:white_check_mark: *${correction.label}* に修正済（<@${payload.user.id}>）`,
              }],
            }
          : block,
      );
      const res = await fetch('https://slack.com/api/chat.update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secrets.SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
          channel: payload.channel.id,
          ts: payload.message.ts,
          blocks: updatedBlocks,
          text: `正しい分類 ${correction.label} が記録されました`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (error) {
      log.error('Failed to update Slack message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return ok(headers);
  } catch (error) {
    log.error('Feedback handler error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
