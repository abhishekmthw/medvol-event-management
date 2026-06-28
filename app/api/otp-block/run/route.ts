import { NextResponse } from "next/server";
import { clearOtpBlock, isOtpUserType } from "@/lib/otp-block";
import type { Environment, OtpUserType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  userType?: OtpUserType;
  input?: string;
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
  const userType = body.userType;
  const input = (body.input ?? "").trim();

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!userType || !isOtpUserType(userType)) {
    return NextResponse.json({ error: "Invalid user type." }, { status: 400 });
  }
  if (!input) {
    return NextResponse.json(
      { error: "At least one mobile number is required." },
      { status: 400 },
    );
  }

  const preview = Boolean(body.preview);

  try {
    const result = await clearOtpBlock(environment, userType, input, {
      preview,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[otp-block/run ${userType}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
