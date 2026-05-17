// The Playground SQS API (delete / changeVisibility) was migrated to direct
// AWS SDK calls — see `lib/sqs.ts`. This file remains the home for the
// batch-scheduler integration, which is still HTTP-based (the scheduler
// playground does not have a direct AWS SDK equivalent we use today).

const DEFAULT_TIMEOUT_MS = Number(
  process.env.PLAYGROUND_FETCH_TIMEOUT_MS ?? 10_000,
);

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildCurl(opts: {
  method: "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body: string;
}): string {
  const lines: string[] = [`curl -X ${opts.method} ${shellQuote(opts.url)}`];
  for (const [k, v] of Object.entries(opts.headers)) {
    lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (opts.body) lines.push(`  --data-raw ${shellQuote(opts.body)}`);
  return lines.join(" \\\n");
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

export async function deleteSqsBatchScheduler(
  schedulerName: string,
): Promise<{ ok: boolean; status: number; raw: string; curl: string }> {
  const url = process.env.PLAYGROUND_SQS_BATCH_API_URL;
  const key = process.env.PLAYGROUND_SQS_BATCH_API_KEY;
  if (!url) throw new Error("Missing PLAYGROUND_SQS_BATCH_API_URL env var");
  if (!key) throw new Error("Missing PLAYGROUND_SQS_BATCH_API_KEY env var");

  const headers = {
    Authorization: JSON.stringify({ apiKey: key }),
    "Content-Type": "application/json",
  };
  const bodyStr = JSON.stringify({ scheduler_name: schedulerName });

  const res = await fetchWithTimeout(
    url,
    { method: "DELETE", headers, body: bodyStr },
    DEFAULT_TIMEOUT_MS,
    "Playground batch scheduler delete",
  );

  const raw = await res.text();
  const curl = buildCurl({ method: "DELETE", url, headers, body: bodyStr });
  return { ok: res.ok, status: res.status, raw, curl };
}
