import { NextResponse } from "next/server";
import { queryRawEvents } from "@/lib/raw-events";
import { parseList } from "@/lib/events";
import { getInstance } from "@/lib/instances";
import type { Environment, Service, Target } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];
const ALLOWED_SERVICES: Service[] = ["corp", "oms"];

type Body = {
  environment?: Environment;
  service?: Service;
  instance?: string | null;
  /** Raw stream-id text (comma/space/newline separated). */
  streamIds?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const environment = body.environment;
  const service = body.service;
  const rawInstance = body.instance;

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!service || !ALLOWED_SERVICES.includes(service)) {
    return NextResponse.json({ error: "Invalid service." }, { status: 400 });
  }

  const streamIds = parseList(body.streamIds ?? "");
  if (!streamIds.length) {
    return NextResponse.json(
      { error: "At least one stream ID is required." },
      { status: 400 },
    );
  }

  // Normalise instance: empty string / "shared" / undefined → null (shared).
  let instance: string | null = null;
  if (typeof rawInstance === "string" && rawInstance.trim()) {
    const trimmed = rawInstance.trim().toLowerCase();
    if (trimmed !== "shared") instance = trimmed;
  }

  if (instance) {
    const meta = getInstance(instance);
    if (!meta) {
      return NextResponse.json(
        { error: `Unknown instance "${instance}".` },
        { status: 400 },
      );
    }
    if (meta.service !== service) {
      return NextResponse.json(
        {
          error: `Instance "${instance}" is for service "${meta.service}", not "${service}".`,
        },
        { status: 400 },
      );
    }
  }

  const target: Target = { environment, service, instance };

  try {
    const result = await queryRawEvents(target, streamIds);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[counter/raw-events ${environment}/${service}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
