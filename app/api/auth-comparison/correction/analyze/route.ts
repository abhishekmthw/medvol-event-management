import { NextResponse } from "next/server";
import { analyzeByMobile } from "@/lib/correction";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  mobile?: string;
};

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
  if (mobile.replace(/\D/g, "").length < 10) {
    return NextResponse.json(
      { error: "Mobile number must be at least 10 digits." },
      { status: 400 },
    );
  }

  try {
    const result = await analyzeByMobile(environment, mobile);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[correction/analyze ${environment}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
