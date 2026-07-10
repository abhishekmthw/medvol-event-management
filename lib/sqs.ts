import { randomUUID } from "crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  SQSClient,
  SQSServiceException,
} from "@aws-sdk/client-sqs";
import { getInstance } from "./instances";
import type { Environment, Target } from "./types";

/**
 * Outcome of an SQS call.
 *  - "success": the SQS operation acknowledged success.
 *  - "gone":    the receipt handle is no longer valid (the message was already
 *               deleted, or the >15 day SQS retention elapsed). Callers may
 *               still mark the DB row force-succeeded on this outcome.
 *  - "error":   any other failure (auth, network, region misconfiguration, …).
 */
export type SqsOutcome =
  | { kind: "success" }
  | { kind: "gone"; reason: string }
  | { kind: "error"; reason: string };

const DEFAULT_REGION = "ap-south-1";
// Mirrors the Playground Lambda: short visibility so the consumer picks the
// message up almost immediately after refire.
const REFIRE_VISIBILITY_SECONDS = 5;

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function requireEnv(name: string): string {
  const v = readEnv(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

type SqsConfig = {
  queueUrl: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  cacheKey: string;
};

function resolveConfig(target: Target): SqsConfig {
  const envUpper = target.environment.toUpperCase();

  if (target.instance) {
    const meta = getInstance(target.instance);
    if (!meta) {
      throw new Error(`Unknown private instance "${target.instance}".`);
    }
    const idUpper = target.instance.toUpperCase();
    // Credentials and region are instance-wide (the instance lives in one AWS
    // account, hosting both stage and prod queues). Only the queue URL varies
    // per environment.
    return {
      queueUrl: requireEnv(
        `PRIVATE_INSTANCE_${idUpper}_${envUpper}_SQS_QUEUE_URL`,
      ),
      region:
        readEnv(`PRIVATE_INSTANCE_${idUpper}_AWS_REGION`) ?? DEFAULT_REGION,
      credentials: {
        accessKeyId: requireEnv(
          `PRIVATE_INSTANCE_${idUpper}_AWS_ACCESS_KEY_ID`,
        ),
        secretAccessKey: requireEnv(
          `PRIVATE_INSTANCE_${idUpper}_AWS_SECRET_ACCESS_KEY`,
        ),
      },
      cacheKey: `instance:${target.instance}`,
    };
  }

  return {
    queueUrl: requireEnv(`${target.service.toUpperCase()}_${envUpper}_SQS_QUEUE_URL`),
    region: readEnv(`${envUpper}_AWS_REGION`) ?? DEFAULT_REGION,
    credentials: {
      accessKeyId: requireEnv(`${envUpper}_AWS_ACCESS_KEY_ID`),
      secretAccessKey: requireEnv(`${envUpper}_AWS_SECRET_ACCESS_KEY`),
    },
    cacheKey: `shared:${target.environment}`,
  };
}

const clientCache = new Map<string, SQSClient>();

function getClient(cfg: SqsConfig): SQSClient {
  const cached = clientCache.get(cfg.cacheKey);
  if (cached) return cached;
  const client = new SQSClient({
    region: cfg.region,
    credentials: cfg.credentials,
  });
  clientCache.set(cfg.cacheKey, client);
  return client;
}

// AWS SQS error names that mean "this receipt handle is no longer actionable".
// The message has been removed from the queue (manual delete elsewhere, or the
// 14-day retention elapsed). Treated as "gone" — destructive ops still mark the
// DB row force-succeeded; refire reports it as un-refireable.
const GONE_ERROR_NAMES = new Set([
  "ReceiptHandleIsInvalid",
  "InvalidParameterValue",
  "InvalidIdFormat",
  "MessageNotInflight",
]);

function describeError(
  action: "delete" | "changeVisibility",
  cfg: SqsConfig,
  receiptHandle: string,
  err: unknown,
): string {
  const name = err instanceof Error ? err.name : "Error";
  const msg = err instanceof Error ? err.message : String(err);
  const lines: string[] = [`SQS ${action} failed (${name}): ${msg}`];
  lines.push(`  queueUrl=${cfg.queueUrl}`);
  lines.push(`  region=${cfg.region}`);
  lines.push(
    `  receiptHandle=${receiptHandle.length > 48 ? `${receiptHandle.slice(0, 48)}…` : receiptHandle}`,
  );
  if (err instanceof SQSServiceException) {
    const meta = err.$metadata;
    if (meta?.httpStatusCode != null) {
      lines.push(`  httpStatus=${meta.httpStatusCode}`);
    }
    if (meta?.requestId) lines.push(`  requestId=${meta.requestId}`);
  }
  return lines.join("\n");
}

async function callSqs(
  action: "delete" | "changeVisibility",
  receiptHandle: string,
  target: Target,
): Promise<SqsOutcome> {
  const cfg = resolveConfig(target);
  const client = getClient(cfg);
  try {
    if (action === "delete") {
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: cfg.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } else {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: cfg.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: REFIRE_VISIBILITY_SECONDS,
        }),
      );
    }
    return { kind: "success" };
  } catch (err) {
    const reason = describeError(action, cfg, receiptHandle, err);
    const name = err instanceof Error ? err.name : "";
    if (GONE_ERROR_NAMES.has(name)) return { kind: "gone", reason };
    return { kind: "error", reason };
  }
}

export function deleteSqsMessage(
  receiptHandle: string,
  target: Target,
): Promise<SqsOutcome> {
  return callSqs("delete", receiptHandle, target);
}

export function refireSqsMessage(
  receiptHandle: string,
  target: Target,
): Promise<SqsOutcome> {
  return callSqs("changeVisibility", receiptHandle, target);
}

/* --------------------- V1 auth consumer queue send --------------------- */

/**
 * Config for the V1 auth-backend consumer FIFO queue (event replay for the
 * Employee Data Correction card). The queue lives in the same per-env AWS
 * account as the shared Corp/OMS queues, so credentials/region are reused
 * from `{ENV}_AWS_*` — only the queue URL is new (`AUTH_{ENV}_SQS_QUEUE_URL`).
 * The `{ENV}_AWS_*` IAM credentials additionally need `sqs:SendMessage` on it.
 */
function resolveAuthQueueConfig(environment: Environment): SqsConfig {
  const envUpper = environment.toUpperCase();
  return {
    queueUrl: requireEnv(`AUTH_${envUpper}_SQS_QUEUE_URL`),
    region: readEnv(`${envUpper}_AWS_REGION`) ?? DEFAULT_REGION,
    credentials: {
      accessKeyId: requireEnv(`${envUpper}_AWS_ACCESS_KEY_ID`),
      secretAccessKey: requireEnv(`${envUpper}_AWS_SECRET_ACCESS_KEY`),
    },
    // Same account/creds as the shared queues — reuse the cached client.
    cacheKey: `shared:${environment}`,
  };
}

/**
 * Send one message to the V1 auth consumer FIFO queue. `body` is the
 * JSON-serialized corp `public.events` row (the auth-backend consumer accepts
 * raw event rows: it only unwraps `body.Message` when `event_type` is absent,
 * and events rows carry no `signature` column, so verification is skipped).
 * `groupId` should be the event stream id — mirrors the SDK's SNS publishing
 * (`MessageGroupId = streamId`) so replayed events stay FIFO-ordered.
 */
export async function sendAuthQueueMessage(
  environment: Environment,
  body: string,
  groupId: string,
): Promise<SqsOutcome> {
  const cfg = resolveAuthQueueConfig(environment);
  const client = getClient(cfg);
  try {
    await client.send(
      new SendMessageCommand({
        QueueUrl: cfg.queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: randomUUID().replace(/-/g, ""),
      }),
    );
    return { kind: "success" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    const lines = [
      `SQS send failed (${name}): ${msg}`,
      `  queueUrl=${cfg.queueUrl}`,
      `  region=${cfg.region}`,
    ];
    if (err instanceof SQSServiceException) {
      const meta = err.$metadata;
      if (meta?.httpStatusCode != null) lines.push(`  httpStatus=${meta.httpStatusCode}`);
      if (meta?.requestId) lines.push(`  requestId=${meta.requestId}`);
    }
    return { kind: "error", reason: lines.join("\n") };
  }
}
