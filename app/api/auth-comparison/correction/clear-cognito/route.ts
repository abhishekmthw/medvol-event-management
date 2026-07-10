import { NextResponse } from "next/server";
import { clearWrongCognitoId } from "@/lib/correction";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  empmasterId?: string;
  /** true → list what would be cleared without writing. */
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

  try {
    const result = await clearWrongCognitoId(environment, empmasterId, preview);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[correction/clear-cognito ${environment} ${empmasterId}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
