import { NextResponse } from "next/server";
import { listPrivateInstances } from "@/lib/instances";
import type { InstanceOption } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const instances: InstanceOption[] = listPrivateInstances().map((i) => ({
    id: i.id,
    label: i.label,
    service: i.service,
  }));
  return NextResponse.json({ instances });
}
