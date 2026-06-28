import { NextResponse } from "next/server";
import { fetchCompanies } from "@/lib/counter";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const environment = searchParams.get("environment") as Environment | null;
  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  try {
    const companies = await fetchCompanies(environment);
    return NextResponse.json({ companies });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[counter/companies]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
