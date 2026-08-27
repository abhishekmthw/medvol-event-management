import { NextResponse } from "next/server";
import { replayEmployeeStream } from "@/lib/correction";
import type { Environment } from "@/lib/types";
import { assertCorrectionWritesEnabled } from "@/lib/write-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  empmasterId?: string;
  /** true → return the event list without sending anything. */
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
  const preview = body.preview !== false;

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!/^\d+$/.test(empmasterId)) {
    return NextResponse.json({ error: "Invalid empmaster id." }, { status: 400 });
  }

  // Display-only mode: a preview may run, an actual write may not.
  // Enforced here as well as in the UI so a hand-crafted POST is refused.
  const blocked = assertCorrectionWritesEnabled(preview);
  if (blocked) return blocked;

  try {
    const result = await replayEmployeeStream(environment, empmasterId, preview);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[correction/replay ${environment} ${empmasterId}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
