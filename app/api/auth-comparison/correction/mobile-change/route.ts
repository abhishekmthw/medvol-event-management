import { NextResponse } from "next/server";
import { changeMobileAndRelease } from "@/lib/correction";
import type { Environment } from "@/lib/types";
import { assertCorrectionWritesEnabled } from "@/lib/write-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  empmasterId?: string;
  /** New 10-digit mobile for the employee's Cognito account. */
  newMobile?: string;
  /**
   * Opt-in to freeing the number from another account that reserves it
   * (randomize its phone + disable it). Defaults to false, so a squatted
   * number is reported as a blocker instead of quietly disabling someone.
   */
  releaseConflicting?: boolean;
  /** true → resolve and report the plan without writing. */
  preview?: boolean;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const environment = body.environment;
  const empmasterId = String(body.empmasterId ?? "").trim();
  const newMobile = String(body.newMobile ?? "").trim();
  const releaseConflicting = body.releaseConflicting === true;
  const preview = body.preview !== false;

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!/^\d+$/.test(empmasterId)) {
    return NextResponse.json({ error: "Invalid empmaster id." }, { status: 400 });
  }
  if (!/^\d{10}$/.test(newMobile)) {
    return NextResponse.json(
      { error: "Invalid mobile number — 10 digits required." },
      { status: 400 },
    );
  }

  // Display-only mode: a preview may run, an actual write may not.
  // Enforced here as well as in the UI so a hand-crafted POST is refused.
  const blocked = assertCorrectionWritesEnabled(preview);
  if (blocked) return blocked;

  try {
    const result = await changeMobileAndRelease(
      environment,
      empmasterId,
      newMobile,
      releaseConflicting,
      preview,
    );
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[correction/mobile-change ${environment} ${empmasterId} → ${newMobile}]`,
      msg,
    );
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
