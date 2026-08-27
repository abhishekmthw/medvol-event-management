import { NextResponse } from "next/server";
import { releaseReservedNumber } from "@/lib/correction";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  /** The 10-digit number that cannot be signed up. */
  mobile?: string;
  /** true → identify the holder and report, without writing. */
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
  const mobile = String(body.mobile ?? "").trim();
  const preview = body.preview !== false;

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!/^\d{10,13}$/.test(mobile.replace(/\D/g, ""))) {
    return NextResponse.json(
      { error: "Invalid mobile number — 10 digits required." },
      { status: 400 },
    );
  }

  try {
    const result = await releaseReservedNumber(environment, mobile, preview);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[correction/release-number ${environment} ${mobile}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
