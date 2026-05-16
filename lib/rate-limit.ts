type Entry = {
  failures: number;
  windowStart: number;
  lockUntil: number;
};

const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES ?? 5);
const WINDOW_MS =
  Number(process.env.LOGIN_WINDOW_MINUTES ?? 15) * 60_000;
const LOCKOUT_MS =
  Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 5) * 60_000;
const MAX_KEYS = 5_000;

const buckets = new Map<string, Entry>();

function gc(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, e] of buckets) {
    if (e.lockUntil < now && e.windowStart + WINDOW_MS < now) {
      buckets.delete(k);
    }
  }
}

export type LockState = {
  locked: boolean;
  retryAfterSec: number;
  remaining: number;
};

export function checkLock(key: string): LockState {
  const e = buckets.get(key);
  if (!e) return { locked: false, retryAfterSec: 0, remaining: MAX_FAILURES };
  const now = Date.now();
  if (e.lockUntil > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((e.lockUntil - now) / 1000),
      remaining: 0,
    };
  }
  return {
    locked: false,
    retryAfterSec: 0,
    remaining: Math.max(0, MAX_FAILURES - e.failures),
  };
}

export function recordFailure(key: string): LockState {
  const now = Date.now();
  gc(now);

  let e = buckets.get(key);
  const windowExpired = !!e && e.windowStart + WINDOW_MS < now;
  const lockoutExpired = !!e && e.lockUntil > 0 && e.lockUntil <= now;
  if (!e || windowExpired || lockoutExpired) {
    e = { failures: 0, windowStart: now, lockUntil: 0 };
  }

  e.failures += 1;
  if (e.failures >= MAX_FAILURES) {
    e.lockUntil = now + LOCKOUT_MS;
  }
  buckets.set(key, e);

  return {
    locked: e.lockUntil > now,
    retryAfterSec:
      e.lockUntil > now ? Math.ceil((e.lockUntil - now) / 1000) : 0,
    remaining: Math.max(0, MAX_FAILURES - e.failures),
  };
}

export function clearFailures(key: string): void {
  buckets.delete(key);
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) {
    const first = xf.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
