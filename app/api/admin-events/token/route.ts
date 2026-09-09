import { NextResponse } from "next/server";
import { generateToken } from "@/lib/admin-events";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  mobile?: string;
};

/**
 * Mints a Cognito CUSTOM_AUTH token for one mobile number — the ops
 * `mobileLogin` script as a UI operation.
 *
 * Independent of the bulk push, which mints and caches its own token for
 * `BULK_AUTH_MOBILE`; this endpoint never touches that cache.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const environment = body.environment;
  const mobile = (body.mobile ?? "").trim();

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!mobile) {
    return NextResponse.json(
      { error: "A mobile number is required." },
      { status: 400 },
    );
  }

  try {
    const result = await generateToken(environment, mobile);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Never log the token values themselves.
    console.error(`[admin-events/token ${environment}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
