import { NextResponse } from "next/server";
import {
  checkEmployeesAgainstCognito,
  isEmployeeScope,
} from "@/lib/auth-comparison";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  scope?: string;
  /** Chunk offset within the scan base; 0 (default) starts a scan. */
  offset?: number;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const environment = body.environment;
  const scope = body.scope ?? "active";
  const offset = body.offset ?? 0;

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!isEmployeeScope(scope)) {
    return NextResponse.json({ error: "Invalid scope." }, { status: 400 });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "Invalid offset." }, { status: 400 });
  }

  try {
    const result = await checkEmployeesAgainstCognito(environment, scope, offset);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[auth-comparison/employee-cognito ${environment} ${scope} @${offset}]`,
      msg,
    );
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
