import { NextResponse } from "next/server";
import { fetchDivisions } from "@/lib/counter";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const environment = searchParams.get("environment") as Environment | null;
  const company = (searchParams.get("company") ?? "").trim();

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!company) {
    // No company selected yet — nothing to cascade.
    return NextResponse.json({ divisions: [] });
  }
  try {
    const divisions = await fetchDivisions(environment, company);
    return NextResponse.json({ divisions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[counter/divisions]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
