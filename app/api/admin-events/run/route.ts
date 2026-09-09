import { NextResponse } from "next/server";
import {
  MAX_IDS_PER_CHUNK,
  previewAdminEdits,
  runAdminEdits,
} from "@/lib/admin-events";
import type { Environment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ENVS: Environment[] = ["prod", "stage"];

type Body = {
  environment?: Environment;
  /** Optional mobile-number filter (preview only). Blank = every match. */
  input?: string;
  /** Previewed user ids to apply (run only). */
  ids?: unknown;
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
  if (!environment || !ALLOWED_ENVS.includes(environment)) {
    return NextResponse.json({ error: "Invalid environment." }, { status: 400 });
  }

  const preview = Boolean(body.preview);

  try {
    if (preview) {
      // A blank filter is intentional and means "every eligible admin user";
      // the preview is what surfaces the count before anything is sent.
      const result = await previewAdminEdits(environment, body.input ?? "");
      return NextResponse.json(result);
    }

    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "A non-empty array of previewed user ids is required." },
        { status: 400 },
      );
    }
    if (ids.length > MAX_IDS_PER_CHUNK) {
      return NextResponse.json(
        {
          error: `At most ${MAX_IDS_PER_CHUNK} ids per request — the UI sends the previewed list in chunks.`,
        },
        { status: 400 },
      );
    }
    if (!ids.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
      return NextResponse.json(
        { error: "User ids must be numeric strings." },
        { status: 400 },
      );
    }

    const result = await runAdminEdits(environment, ids as string[]);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[admin-events/run ${environment}]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
