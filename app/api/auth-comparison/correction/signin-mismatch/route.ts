import { NextResponse } from "next/server";
import { repairSigninMismatch } from "@/lib/correction";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  /** The 10-digit number that shows on the account but cannot log in. */
  mobile?: string;
  /** Or the account's Cognito sub, when the number is not known. */
  sub?: string;
  /** true → diagnose both indexes and report, without writing. */
  preview?: boolean;
};

/**
 * Deliberately NOT behind `assertCorrectionWritesEnabled`, for the same reason
 * `correction/release-number` is not: this is the tool for a mobile stuck in
 * Cognito's sign-in index, which is the whole reason it exists, and it writes
 * only a Cognito phone attribute — never employee data, never the DB.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const environment = body.environment;
  const mobile = String(body.mobile ?? "").trim();
  const sub = String(body.sub ?? "").trim();
  const preview = body.preview !== false;

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!mobile && !sub) {
    return NextResponse.json(
      { error: "Provide a 10-digit mobile number or a Cognito sub." },
      { status: 400 },
    );
  }
  if (mobile && !/^\d{10,13}$/.test(mobile.replace(/\D/g, ""))) {
    return NextResponse.json(
      { error: "Invalid mobile number — 10 digits required." },
      { status: 400 },
    );
  }

  try {
    const result = await repairSigninMismatch(
      environment,
      { mobile, sub },
      preview,
    );
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[correction/signin-mismatch ${environment} ${mobile || sub}]`,
      msg,
    );
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
