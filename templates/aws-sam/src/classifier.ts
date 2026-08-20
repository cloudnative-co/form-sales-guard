/**
 * 同期ハンドラ雛形: フォーム受信 → 検証 → 記録保存 → SQS 送信 → 即 200
 *
 * この関数の責務は「1〜2 秒で受け付けを完了させること」だけ。AI 分類・通知は
 * SQS 経由で processor に渡す（安全不変条件 3: 即応答と非同期分類の分離）。
 *
 * Lambda では `void (async () => {...})()` のような fire-and-forget は
 * handler の return 後に実行環境が凍結されるため処理が途中で消える
 * （PITFALLS B-1）。「裏で処理」はキュー渡し以外の方法を使わないこと。
 *
 * テンプレート側の対応: この関数の Timeout は 25 秒 = API Gateway の統合
 * タイムアウト 29 秒より短い（PITFALLS B-2）。外部 SDK を追加する場合も
 * その既定タイムアウトが 25 秒を超えないか確認する（PITFALLS B-3）。
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

// 構造化ログ（雛形では console ベースで十分。文言は検知アラームとの契約になる
// ことがあるため、error レベルの文言変更は template.yaml の FilterPattern と突合する）
const log = {
  info: (msg: string, data?: object) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  warn: (msg: string, data?: object) => console.warn(JSON.stringify({ level: 'warn', msg, ...data })),
  error: (msg: string, data?: object) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
};

// 入力フィールドの長さ上限（PITFALLS E-3）。プロンプト肥大によるコスト増と
// 攻撃面の両方を抑える。フロント側のバリデーションとは独立に必ずサーバー側で敷く。
const LIMITS = {
  company: 100,
  name: 50,
  email: 254,
  phone: 20,
  message: 2000,
  inquiryType: 50,
  page: 200,
} as const;

// 3 秒未満の送信はボットとみなす（人間はフォームを 3 秒で埋められない）
const MIN_SUBMIT_TIME_MS = 3000;

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export interface FormInput {
  inquiryType: string;
  company: string;
  lastName: string;
  firstName: string;
  email: string;
  phone?: string;
  message: string;
  page?: string;
}

/** SQS で processor に渡すメッセージ（processor.ts 側のバリデーションと対） */
export interface ProcessorMessage {
  type: 'contact';
  input: FormInput;
  recordId: string;
}

// AWS SDK v3 の既定 requestTimeout は無制限。同期 Lambda（Timeout 25s < API GW 29s）で
// SQS / DynamoDB がハングすると 25s で強制終了し、クライアントは 5xx で再送しうる。
// 明示タイムアウトで内側を短くする。throwOnRequestTimeout を付けないと requestTimeout
// 超過は警告ログのみでリクエストが継続する（= 無制限のまま）。さらに requestTimeout は
// headers 到達で解除されるため、body が止まる故障は socketTimeout（無通信検知）が受け持つ
// （SDK の版は template.yaml でバンドルして固定 — ^3.910.0 未満は意味論が異なる）。
// いずれもリトライ対象のため、実効上限は maxAttempts × timeout + バックオフ（≈ 2 × 8s < 25s）。
const AWS_CLIENT_CONFIG = {
  requestHandler: { requestTimeout: 8_000, connectionTimeout: 3_000, socketTimeout: 8_000, throwOnRequestTimeout: true },
  maxAttempts: 2,
};
const sqsClient = new SQSClient(AWS_CLIENT_CONFIG);
const ddbClient = new DynamoDBClient(AWS_CLIENT_CONFIG);

// 必須設定は起動時に fail-fast で検証する（PITFALLS B-4）。欠落をリクエスト処理中の
// 不可解なエラーではなく、デプロイ直後の明確なエラーとして検知させる。
const getConfig = () => {
  const required = ['QUEUE_URL', 'TABLE_NAME', 'ALLOWED_ORIGIN'] as const;
  for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
  return {
    QUEUE_URL: process.env.QUEUE_URL!,
    TABLE_NAME: process.env.TABLE_NAME!,
    ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN!,
  };
};

/** body を型ガードでパースし、全フィールドに長さ上限を適用する */
const parseBody = (body: string) => {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON in request body');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Request body must be a JSON object');
  }
  const obj = data as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

  return {
    input: {
      inquiryType: str(obj.inquiryType).slice(0, LIMITS.inquiryType),
      company: str(obj.company).slice(0, LIMITS.company),
      lastName: str(obj.lastName).slice(0, LIMITS.name),
      firstName: str(obj.firstName).slice(0, LIMITS.name),
      email: str(obj.email).slice(0, LIMITS.email),
      phone: obj.phone ? str(obj.phone).slice(0, LIMITS.phone) : undefined,
      message: str(obj.message).slice(0, LIMITS.message),
      page: obj.page ? str(obj.page).slice(0, LIMITS.page) : undefined,
    } satisfies FormInput,
    // honeypot: フォームに CSS で不可視化した「website」フィールドを置き、
    // 値が入っていたらボットと判定する（人間には見えないので入力されない）
    honeypot: str(obj.website),
    // フロントがフォーム表示時刻を埋める。送信までの経過時間でボットを判定する
    timestamp: num(obj.timestamp),
  };
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const cfg = getConfig();

  const headers = {
    'Access-Control-Allow-Origin': cfg.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!event.body) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing request body' }) };
    }

    const { input, honeypot, timestamp } = parseBody(event.body);

    // --- ボット対策は AI 分類の前段に多層で敷く（AI は「人間が送る営業」用の最後の層）---

    // honeypot 検知時は「エラーではなく成功を装って黙殺」する（PITFALLS E-1）。
    // エラーを返すとボットに検知手法を教えることになる。
    if (honeypot) {
      log.warn('Honeypot field filled, likely bot');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // 送信速度チェック。3 秒未満は黙殺（同じく成功を装う）
    if (timestamp > 0 && Date.now() - timestamp < MIN_SUBMIT_TIME_MS) {
      log.warn('Submission too fast, likely bot', { elapsed: Date.now() - timestamp });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ここに Turnstile / reCAPTCHA 検証を追加する場合は、トークンの有効性だけで
    // なく発行元 hostname を許可リストと突合すること（PITFALLS E-2: 他サイトで
    // 取得した正規トークンの流用を防ぐ）。シークレットは Secrets Manager に置く。

    // --- 必須フィールドの最小限の検証 ---
    if (!input.company || !input.lastName || !input.firstName || !input.email || !input.message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }
    if (!EMAIL_REGEX.test(input.email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email format' }) };
    }

    // 1. 記録保存（分類なし）。SPAM 判定になっても消えない台帳をこの時点で作る
    //    （安全不変条件 2: 削除ではなく隔離）。分類ラベルは processor が後から埋める。
    const recordId = randomUUID();
    await ddbClient.send(new PutItemCommand({
      TableName: cfg.TABLE_NAME,
      Item: {
        recordId: { S: recordId },
        createdAt: { S: new Date().toISOString() },
        inquiryType: { S: input.inquiryType },
        company: { S: input.company },
        name: { S: `${input.lastName} ${input.firstName}` },
        email: { S: input.email },
        ...(input.phone ? { phone: { S: input.phone } } : {}),
        message: { S: input.message },
        ...(input.page ? { page: { S: input.page } } : {}),
        status: { S: 'received' },
      },
    }));

    // 2. SQS 送信。AI 分類・通知は processor が非同期で処理する
    const message: ProcessorMessage = { type: 'contact', input, recordId };
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: cfg.QUEUE_URL,
      MessageBody: JSON.stringify(message),
    }));

    log.info('Form accepted, queued for processing', { recordId });
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    log.error('Handler error', { error: error instanceof Error ? error.message : String(error) });
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
