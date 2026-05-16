import { NextResponse } from "next/server";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyStaticCredentials,
} from "@/lib/auth";
import {
  checkLock,
  clearFailures,
  clientIp,
  recordFailure,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

function lockoutMessage(retryAfterSec: number): string {
  const minutes = Math.ceil(retryAfterSec / 60);
  return `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export async function POST(req: Request) {
  const ip = clientIp(req);

  const locked = checkLock(ip);
  if (locked.locked) {
    return NextResponse.json(
      { error: lockoutMessage(locked.retryAfterSec) },
      {
        status: 429,
        headers: { "Retry-After": String(locked.retryAfterSec) },
      },
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!username || !password) {
    return NextResponse.json(
      { error: "Username and password are required." },
      { status: 400 },
    );
  }

  try {
    if (!verifyStaticCredentials(username, password)) {
      const f = recordFailure(ip);
      if (f.locked) {
        return NextResponse.json(
          { error: lockoutMessage(f.retryAfterSec) },
          {
            status: 429,
            headers: { "Retry-After": String(f.retryAfterSec) },
          },
        );
      }
      const tail =
        f.remaining > 0 && f.remaining <= 2
          ? ` ${f.remaining} attempt${f.remaining === 1 ? "" : "s"} remaining before lockout.`
          : "";
      return NextResponse.json(
        { error: `Invalid username or password.${tail}` },
        { status: 401 },
      );
    }

    clearFailures(ip);
    const token = await createSessionToken(username);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
