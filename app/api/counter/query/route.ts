import { NextResponse } from "next/server";
import { queryCounterEvents } from "@/lib/counter";
import { parseList } from "@/lib/events";
import type {
  CounterFilters,
  CounterView,
  Environment,
  Target,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];
const ALLOWED_VIEWS: CounterView[] = ["division", "products", "stockist"];

type Body = {
  environment?: Environment;
  view?: CounterView;
  /** Raw stream-id text (comma/space/newline separated). */
  streamIds?: string;
  companyCode?: string | null;
  divisionCode?: string | null;
  locationCode?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
};

/** Trim to a non-empty string, else null. */
function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const environment = body.environment;
  const view = body.view;

  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }
  if (!view || !ALLOWED_VIEWS.includes(view)) {
    return NextResponse.json({ error: "Invalid view." }, { status: 400 });
  }

  const streamIds = parseList(body.streamIds ?? "");
  if (!streamIds.length) {
    return NextResponse.json(
      { error: "At least one stream ID is required." },
      { status: 400 },
    );
  }

  const filters: CounterFilters = {
    streamIds,
    companyCode: clean(body.companyCode),
    // Division is not a concept for the stockist view — drop it defensively.
    divisionCode: view === "stockist" ? null : clean(body.divisionCode),
    locationCode: clean(body.locationCode),
    fromDate: clean(body.fromDate),
    toDate: clean(body.toDate),
  };

  // Counter Events is Corp-only, shared instance.
  const target: Target = { environment, service: "corp", instance: null };

  try {
    const result = await queryCounterEvents(target, view, filters);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[counter/query ${view}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
