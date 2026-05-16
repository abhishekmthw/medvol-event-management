import { getInstance } from "./instances";
import type { Target } from "./types";

type SqsAction = "delete" | "changeVisibility";

/**
 * Outcome of a Playground SQS call.
 *  - "success": the SQS operation acknowledged success.
 *  - "gone":    the playground reported the SQS operation failed; this is the
 *               case when the receipt handle is no longer valid (SQS retains
 *               messages for 15 days, after which the handle is dead).
 *  - "error":   anything unexpected (network failure, HTTP error, body we
 *               don't recognise).
 */
export type PlaygroundOutcome =
  | { kind: "success"; raw: string }
  | { kind: "gone"; raw: string }
  | { kind: "error"; reason: string; raw: string; httpStatus: number };

const DEFAULT_TIMEOUT_MS = Number(
  process.env.PLAYGROUND_FETCH_TIMEOUT_MS ?? 10_000,
);

function playgroundUrl(env: Target["environment"]): string {
  const url =
    env === "prod"
      ? process.env.PLAYGROUND_SQS_API_URL_PROD
      : process.env.PLAYGROUND_SQS_API_URL_STAGE;
  if (!url) {
    throw new Error(
      `Missing PLAYGROUND_SQS_API_URL_${env.toUpperCase()} env var`,
    );
  }
  return url;
}

function playgroundKey(): string {
  const k = process.env.PLAYGROUND_SQS_API_KEY;
  if (!k) throw new Error("Missing PLAYGROUND_SQS_API_KEY env var");
  return k;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === "AbortError" || ctrl.signal.aborted)
    ) {
      throw new Error(
        `${label} timed out after ${timeoutMs}ms — Playground API did not respond.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function callPlaygroundSqs(
  action: SqsAction,
  receiptHandle: string,
  target: Target,
): Promise<PlaygroundOutcome> {
  const body: Record<string, unknown> = {
    action,
    handles: [receiptHandle],
  };
  if (target.service === "oms") {
    body.isOms = true;
  }
  if (target.instance) {
    const meta = getInstance(target.instance);
    if (meta?.playgroundFlag) {
      body[meta.playgroundFlag] = true;
    }
  }

  const res = await fetchWithTimeout(
    playgroundUrl(target.environment),
    {
      method: "POST",
      headers: {
        "x-api-key": playgroundKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    DEFAULT_TIMEOUT_MS,
    `Playground SQS ${action}`,
  );

  const raw = (await res.text()).trim();

  if (!res.ok) {
    return {
      kind: "error",
      reason: `Playground SQS ${action} returned HTTP ${res.status}: ${raw || "<empty>"}`,
      raw,
      httpStatus: res.status,
    };
  }
  if (raw === `"success"`) return { kind: "success", raw };
  if (raw === `"failed"`) return { kind: "gone", raw };
  return {
    kind: "error",
    reason: `Unexpected Playground SQS ${action} response: ${raw || "<empty>"}`,
    raw,
    httpStatus: res.status,
  };
}

export function deleteSqsMessage(
  receiptHandle: string,
  target: Target,
): Promise<PlaygroundOutcome> {
  return callPlaygroundSqs("delete", receiptHandle, target);
}

export function refireSqsMessage(
  receiptHandle: string,
  target: Target,
): Promise<PlaygroundOutcome> {
  return callPlaygroundSqs("changeVisibility", receiptHandle, target);
}

export async function deleteSqsBatchScheduler(
  schedulerName: string,
): Promise<{ ok: boolean; status: number; raw: string }> {
  const url = process.env.PLAYGROUND_SQS_BATCH_API_URL;
  const key = process.env.PLAYGROUND_SQS_BATCH_API_KEY;
  if (!url) throw new Error("Missing PLAYGROUND_SQS_BATCH_API_URL env var");
  if (!key) throw new Error("Missing PLAYGROUND_SQS_BATCH_API_KEY env var");

  const res = await fetchWithTimeout(
    url,
    {
      method: "DELETE",
      headers: {
        Authorization: JSON.stringify({ apiKey: key }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scheduler_name: schedulerName }),
    },
    DEFAULT_TIMEOUT_MS,
    "Playground batch scheduler delete",
  );

  const raw = await res.text();
  return { ok: res.ok, status: res.status, raw };
}
