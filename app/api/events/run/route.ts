import { NextResponse } from "next/server";
import {
  checkStatus,
  clearBatchEvents,
  clearByEventIds,
  clearByStreamIds,
  refireByEventIds,
} from "@/lib/events";
import { getInstance } from "@/lib/instances";
import type { ActionKey, Environment, Service, Target } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS: ActionKey[] = [
  "clear-by-event-ids",
  "refire-by-event-ids",
  "clear-by-stream-ids",
  "clear-batch",
  "status",
];

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];
const ALLOWED_SERVICES: Service[] = ["corp", "oms"];

type Body = {
  action?: ActionKey;
  environment?: Environment;
  service?: Service;
  instance?: string | null;
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

  const action = body.action;
  const environment = body.environment;
  const service = body.service;
  const input = (body.input ?? "").trim();
  const rawInstance = body.instance;

  if (!action || !ALLOWED_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  }
  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!service || !ALLOWED_SERVICES.includes(service)) {
    return NextResponse.json({ error: "Invalid service." }, { status: 400 });
  }
  if (!input) {
    return NextResponse.json(
      { error: "Input is required." },
      { status: 400 },
    );
  }

  // Normalise instance: empty string / "shared" / undefined → null
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
  const preview = Boolean(body.preview);

  try {
    let result;
    switch (action) {
      case "clear-by-event-ids":
        result = await clearByEventIds(target, input, { preview });
        break;
      case "refire-by-event-ids":
        result = await refireByEventIds(target, input);
        break;
      case "clear-by-stream-ids":
        result = await clearByStreamIds(target, input, { preview });
        break;
      case "clear-batch":
        result = await clearBatchEvents(target, input, { preview });
        break;
      case "status":
        result = await checkStatus(target, input);
        break;
    }
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[events/run ${action}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
