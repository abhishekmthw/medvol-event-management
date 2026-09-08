import {
  buildConsumerRequest,
  callConsumerApi,
  describeConsumerRoute,
  resolveConsumerApi,
  SUPPORTED_DESTINATION,
  type ConsumerEventInput,
} from "./consumer-api";
import { getPool } from "./db";
import { deleteSqsBatchScheduler } from "./playground";
import { deleteSqsMessage, refireSqsMessage } from "./sqs";
import { isAppliedStatus } from "./types";
import type {
  BatchStatusRow,
  EventStatusRow,
  ExecuteEventRow,
  OperationResult,
  Target,
} from "./types";

const CONSUMER = "V2";

export function parseList(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function partitionIdentifiers(input: string): {
  eventIds: number[];
  streamIds: string[];
} {
  const tokens = parseList(input);
  const eventIds: number[] = [];
  const streamIds: string[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) eventIds.push(Number(t));
    else streamIds.push(t);
  }
  return { eventIds, streamIds };
}

async function fetchEventStatusRows(
  target: Target,
  where: { eventIds?: number[]; streamIds?: string[]; failedOnly?: boolean },
): Promise<EventStatusRow[]> {
  const pool = getPool(target);
  const conditions: string[] = [`ecs.consumer_name = $1`];
  const params: unknown[] = [CONSUMER];

  if (where.eventIds && where.eventIds.length) {
    params.push(where.eventIds);
    conditions.push(`ecs.eventid = ANY($${params.length}::numeric[])`);
  }
  if (where.streamIds && where.streamIds.length) {
    params.push(where.streamIds);
    conditions.push(`ecs.streamid = ANY($${params.length}::text[])`);
  }
  if (where.failedOnly) {
    conditions.push(`ecs.event_status = 'Failed'`);
  }

  const sql = `
    SELECT
      ecs.id,
      ecs.eventid::text AS eventid,
      ecs.streamid,
      ecs.consumer_name,
      ecs.event_status,
      ecs."forceStatus" AS "forceStatus",
      ecs.receipthandle,
      ecs.approximatereceivecount,
      ecs.sentry_issue_id::text AS sentry_issue_id,
      ecs.sentry_issue_status,
      ecs.error_message,
      ecs.modified_date
    FROM public.event_consumer_status ecs
    WHERE ${conditions.join(" AND ")}
    ORDER BY ecs.eventid DESC
  `;
  const { rows } = await pool.query(sql, params);
  const eventRows = rows as Omit<EventStatusRow, "event_type">[];

  // Resolve event_type in a separate, narrowly-scoped query keyed by the IDs
  // we actually returned. Joining against public.events in the main query
  // forced a Seq Scan on a multi-million-row table in prod (the `numeric` cast
  // on eventid defeated the bigint index on events."eventId"), which is what
  // caused 504s on the Vercel-hosted UI.
  if (!eventRows.length) {
    return eventRows.map((r) => ({ ...r, event_type: null }));
  }

  const ids = Array.from(new Set(eventRows.map((r) => r.eventid)));
  const typeMap = new Map<string, string | null>();
  try {
    const { rows: typeRows } = await pool.query(
      `SELECT "eventId"::text AS eventid, event_type
       FROM public.events
       WHERE "eventId" = ANY($1::bigint[])`,
      [ids],
    );
    for (const r of typeRows as { eventid: string; event_type: string | null }[]) {
      typeMap.set(r.eventid, r.event_type);
    }
  } catch (e) {
    console.error(
      `[fetchEventStatusRows] event_type lookup failed:`,
      e instanceof Error ? e.message : String(e),
    );
  }

  return eventRows.map((r) => ({
    ...r,
    event_type: typeMap.get(r.eventid) ?? null,
  }));
}

/** Returns the number of consumer-status rows actually updated. */
async function markEventForceSuccess(
  target: Target,
  eventId: string | number,
): Promise<number> {
  const pool = getPool(target);
  const res = await pool.query(
    `UPDATE public.event_consumer_status
     SET event_status = 'Success', "forceStatus" = true
     WHERE eventid = $1 AND consumer_name = $2`,
    [eventId, CONSUMER],
  );
  return res.rowCount ?? 0;
}

export async function checkStatus(
  target: Target,
  input: string,
): Promise<OperationResult> {
  const { eventIds, streamIds } = partitionIdentifiers(input);
  if (!eventIds.length && !streamIds.length) {
    return {
      ok: false,
      message: "Provide at least one event ID or stream ID.",
      attempted: 0,
      cleared: 0,
      errors: [],
      events: [],
    };
  }

  const rows = await fetchEventStatusRows(target, { eventIds, streamIds });
  return {
    ok: true,
    message: rows.length
      ? `Found ${rows.length} event consumer status row${rows.length === 1 ? "" : "s"}.`
      : "No matching rows.",
    attempted: 0,
    cleared: 0,
    errors: [],
    events: rows,
  };
}

export async function clearByEventIds(
  target: Target,
  input: string,
  options: { preview?: boolean } = {},
): Promise<OperationResult> {
  const { eventIds } = partitionIdentifiers(input);
  if (!eventIds.length) {
    return {
      ok: false,
      message: "No numeric event IDs found in input.",
      attempted: 0,
      cleared: 0,
      errors: [],
      events: [],
    };
  }

  const failed = await fetchEventStatusRows(target, {
    eventIds,
    failedOnly: true,
  });

  if (options.preview) {
    return {
      ok: true,
      preview: true,
      candidates: failed.length,
      message: failed.length
        ? `${failed.length} failed event${failed.length === 1 ? "" : "s"} will be force-succeeded.`
        : "No failed events match the supplied IDs. Nothing would change.",
      attempted: 0,
      cleared: 0,
      errors: [],
      events: failed,
    };
  }

  const errors: OperationResult["errors"] = [];
  let cleared = 0;
  let gone = 0;

  for (const row of failed) {
    const handled = await tryClearEvent(target, row);
    if (handled.ok) {
      cleared++;
      if (handled.gone) gone++;
    } else {
      errors.push({ id: row.eventid, reason: handled.reason });
    }
  }

  const events = await fetchEventStatusRows(target, { eventIds });
  const foundIds = new Set(events.map((r) => Number(r.eventid)));
  for (const id of eventIds) {
    if (!foundIds.has(id)) {
      errors.push({ id, reason: "Event ID not found for consumer V2." });
    }
  }

  return {
    ok: errors.length === 0,
    message:
      failed.length === 0
        ? `No failed events found for the supplied IDs.`
        : buildClearMessage(cleared, failed.length, gone, "event"),
    attempted: failed.length,
    cleared,
    gone,
    errors,
    events,
  };
}

type ClearOutcome =
  | { ok: true; gone: boolean }
  | { ok: false; reason: string };

async function tryClearEvent(
  target: Target,
  row: EventStatusRow,
): Promise<ClearOutcome> {
  // No receipt handle to act on — still update the DB. The user's intent for
  // a "clear" operation is to mark the event force-succeeded; if there's no
  // SQS message to delete (never published, or already cleaned up), the DB
  // update alone fulfils that intent.
  if (!row.receipthandle) {
    try {
      await markEventForceSuccess(target, row.eventid);
      return { ok: true, gone: true };
    } catch (e) {
      return {
        ok: false,
        reason: `DB update failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  try {
    const out = await deleteSqsMessage(row.receipthandle, target);
    if (out.kind === "success" || out.kind === "gone") {
      // For "gone", the receipt handle is no longer valid (SQS retains
      // messages for 15 days). The message can no longer be re-delivered, so
      // it is safe — and per spec, required — to still update the DB.
      await markEventForceSuccess(target, row.eventid);
      return { ok: true, gone: out.kind === "gone" };
    }
    return { ok: false, reason: out.reason };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

function buildClearMessage(
  cleared: number,
  attempted: number,
  gone: number,
  noun: "event" | "stream event" | "batch row",
): string {
  const base = `Cleared ${cleared} of ${attempted} failed ${noun}${attempted === 1 ? "" : "s"}.`;
  if (gone > 0) {
    return `${base} ${gone} SQS message${gone === 1 ? " was" : "s were"} already expired (>15 days) — DB was still force-succeeded.`;
  }
  return base;
}

export async function refireByEventIds(
  target: Target,
  input: string,
): Promise<OperationResult> {
  const { eventIds } = partitionIdentifiers(input);
  if (!eventIds.length) {
    return {
      ok: false,
      message: "No numeric event IDs found in input.",
      attempted: 0,
      cleared: 0,
      errors: [],
      events: [],
    };
  }

  const failed = await fetchEventStatusRows(target, {
    eventIds,
    failedOnly: true,
  });
  const errors: OperationResult["errors"] = [];
  let refired = 0;

  for (const row of failed) {
    if (!row.receipthandle) {
      errors.push({
        id: row.eventid,
        reason:
          "No SQS receipt handle — cannot refire. Use 'Clear by Event IDs' to force-succeed in the DB instead.",
      });
      continue;
    }
    try {
      const out = await refireSqsMessage(row.receipthandle, target);
      // Refire (changeVisibility) MUST NOT touch the DB under any circumstance.
      if (out.kind === "success") {
        refired++;
      } else if (out.kind === "gone") {
        errors.push({
          id: row.eventid,
          reason:
            "SQS message is no longer in the queue (>15 day SQS retention). Cannot refire — use 'Clear by Event IDs' to force-succeed in the DB instead.",
        });
      } else {
        errors.push({ id: row.eventid, reason: out.reason });
      }
    } catch (e) {
      errors.push({
        id: row.eventid,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const events = await fetchEventStatusRows(target, { eventIds });

  return {
    ok: errors.length === 0,
    message:
      failed.length === 0
        ? `No failed events found to refire.`
        : `Refired ${refired} of ${failed.length} failed event${failed.length === 1 ? "" : "s"} (visibility changed; consumer will re-process).`,
    attempted: failed.length,
    cleared: refired,
    errors,
    events,
  };
}

export async function clearByStreamIds(
  target: Target,
  input: string,
  options: { preview?: boolean } = {},
): Promise<OperationResult> {
  const streamIds = parseList(input);
  if (!streamIds.length) {
    return {
      ok: false,
      message: "Provide at least one stream ID.",
      attempted: 0,
      cleared: 0,
      errors: [],
      events: [],
    };
  }

  const failed = await fetchEventStatusRows(target, {
    streamIds,
    failedOnly: true,
  });

  if (options.preview) {
    return {
      ok: true,
      preview: true,
      candidates: failed.length,
      message: failed.length
        ? `${failed.length} failed event${failed.length === 1 ? "" : "s"} across ${streamIds.length} stream${streamIds.length === 1 ? "" : "s"} will be force-succeeded.`
        : `No failed events found on the supplied stream${streamIds.length === 1 ? "" : "s"}. Nothing would change.`,
      attempted: 0,
      cleared: 0,
      errors: [],
      events: failed,
    };
  }

  const errors: OperationResult["errors"] = [];
  let cleared = 0;
  let gone = 0;

  for (const row of failed) {
    const handled = await tryClearEvent(target, row);
    if (handled.ok) {
      cleared++;
      if (handled.gone) gone++;
    } else {
      errors.push({ id: row.eventid, reason: handled.reason });
    }
  }

  const events = await fetchEventStatusRows(target, { streamIds });

  return {
    ok: errors.length === 0,
    message:
      failed.length === 0
        ? `No failed events found on the supplied stream${streamIds.length === 1 ? "" : "s"}.`
        : `${buildClearMessage(cleared, failed.length, gone, "stream event")} (${streamIds.length} stream${streamIds.length === 1 ? "" : "s"}.)`,
    attempted: failed.length,
    cleared,
    gone,
    errors,
    events,
  };
}

export async function clearBatchEvents(
  target: Target,
  input: string,
  options: { preview?: boolean } = {},
): Promise<OperationResult> {
  const batchIds = parseList(input);
  if (!batchIds.length) {
    return {
      ok: false,
      message: "Provide at least one batch ID.",
      attempted: 0,
      cleared: 0,
      errors: [],
      batch: [],
    };
  }

  const pool = getPool(target);
  const { rows } = await pool.query(
    `SELECT
       id,
       batch_id,
       batch_sequence,
       event_type,
       event_status,
       force_status,
       data,
       modified_date
     FROM public.batch_event_status
     WHERE batch_id = ANY($1::text[]) AND event_status = 'Failed'
     ORDER BY id DESC`,
    [batchIds],
  );
  const failed = rows as BatchStatusRow[];

  if (options.preview) {
    return {
      ok: true,
      preview: true,
      candidates: failed.length,
      message: failed.length
        ? `${failed.length} failed batch row${failed.length === 1 ? "" : "s"} will be force-succeeded.`
        : `No failed batch rows found for the supplied batch ID${batchIds.length === 1 ? "" : "s"}. Nothing would change.`,
      attempted: 0,
      cleared: 0,
      errors: [],
      batch: failed,
    };
  }

  const errors: OperationResult["errors"] = [];
  let cleared = 0;
  for (const row of failed) {
    const schedulerName = `${row.batch_sequence}-${row.batch_id}`;
    try {
      const res = await deleteSqsBatchScheduler(schedulerName);
      if (res.ok) {
        await pool.query(
          `UPDATE public.batch_event_status
           SET event_status = 'Success', "force_status" = true
           WHERE id = $1`,
          [row.id],
        );
        cleared++;
      } else {
        errors.push({
          id: row.id,
          reason: `Scheduler delete failed (HTTP ${res.status}): ${res.raw || "<empty>"}\nRequest:\n${res.curl}`,
        });
      }
    } catch (e) {
      errors.push({
        id: row.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const { rows: currentRows } = await pool.query(
    `SELECT
       id,
       batch_id,
       batch_sequence,
       event_type,
       event_status,
       force_status,
       data,
       modified_date
     FROM public.batch_event_status
     WHERE batch_id = ANY($1::text[])
     ORDER BY id DESC
     LIMIT 200`,
    [batchIds],
  );

  return {
    ok: errors.length === 0,
    message:
      failed.length === 0
        ? `No failed batch rows found for the supplied batch ID${batchIds.length === 1 ? "" : "s"}.`
        : `Cleared ${cleared} of ${failed.length} failed batch row${failed.length === 1 ? "" : "s"}.`,
    attempted: failed.length,
    cleared,
    errors,
    batch: currentRows as BatchStatusRow[],
  };
}

/* ------------------------------------------------------------------ *
 * Execute Expired Events — replays a stored event straight at the
 * backend API, reproducing the HTTP call the V2 SQS consumer would
 * have made. For events whose SQS receipt handle has aged out (>14 day
 * retention), where `refire-by-event-ids` can no longer re-deliver.
 * ------------------------------------------------------------------ */

/**
 * Per-run cap. Each call can take up to `CONSUMER_API_FETCH_TIMEOUT_MS`
 * (30s default), so a large paste would blow the serverless wall-clock.
 */
const MAX_EXECUTE_IDS = 50;

/** How many events are in flight at once (the script used a batch of 5). */
const EXECUTE_CONCURRENCY = 4;

/** Response bodies are echoed to the UI — cap what we carry per row. */
const RESPONSE_PREVIEW_LIMIT = 2000;

type RawEventRow = {
  event_id: string;
  stream_id: string | null;
  event_type: string | null;
  destination: string | null;
  domain: string | null;
  action: string | null;
  method: string | null;
  data: string | null;
  user_details: string | null;
};

function truncateResponse(raw: string): string {
  return raw.length > RESPONSE_PREVIEW_LIMIT
    ? `${raw.slice(0, RESPONSE_PREVIEW_LIMIT)}… (truncated)`
    : raw;
}

/**
 * Loads the event rows plus their current V2 consumer status.
 *
 * Deliberately TWO queries joined in Node rather than one SQL join: joining
 * `event_consumer_status` to `public.events` forced a Seq Scan on the
 * multi-million-row events table in prod and caused 504s (see the note in
 * `fetchEventStatusRows`). Each query here uses the cast its own indexed
 * column wants — `::bigint` for `events."eventId"`, `::numeric` for
 * `event_consumer_status.eventid`.
 */
async function fetchEventsForExecute(
  target: Target,
  eventIds: number[],
): Promise<{ events: RawEventRow[]; statuses: Map<string, string> }> {
  const pool = getPool(target);

  const { rows } = await pool.query(
    `SELECT
       e."eventId"::text       AS event_id,
       e."eventStreamStreamId" AS stream_id,
       e.event_type,
       e.destination,
       e.domain,
       e.action,
       e.method,
       e.data::text            AS data,
       e."userDetails"::text   AS user_details
     FROM public.events e
     WHERE e."eventId" = ANY($1::bigint[])
     ORDER BY e."eventId"`,
    [eventIds],
  );
  const events = rows as RawEventRow[];

  const statuses = new Map<string, string>();
  if (events.length) {
    const { rows: statusRows } = await pool.query(
      `SELECT eventid::text AS event_id, event_status
       FROM public.event_consumer_status
       WHERE eventid = ANY($1::numeric[]) AND consumer_name = $2`,
      [events.map((e) => e.event_id), CONSUMER],
    );
    for (const r of statusRows as { event_id: string; event_status: string }[]) {
      statuses.set(r.event_id, r.event_status);
    }
  }

  return { events, statuses };
}

/**
 * Resolves one raw event row into a display/execution row: parses
 * `userDetails`, decides eligibility, and collects the cautions the operator
 * needs to see BEFORE confirming.
 */
function resolveExecuteRow(
  target: Target,
  raw: RawEventRow,
  consumerStatus: string | null,
  cfg: ReturnType<typeof resolveConsumerApi>,
): { row: ExecuteEventRow; input: ConsumerEventInput | null } {
  const warnings: string[] = [];

  let userDetails: Record<string, unknown> | null = null;
  if (raw.user_details) {
    try {
      const parsed = JSON.parse(raw.user_details);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        userDetails = parsed as Record<string, unknown>;
      }
    } catch {
      warnings.push(
        "userDetails is not valid JSON — the call will be sent with the machine (AuthMachine) identity instead.",
      );
    }
  }
  if (!userDetails || !Object.keys(userDetails).length) {
    warnings.push(
      "No userDetails on the event — the backend will attribute this write to the machine identity (AuthMachine).",
    );
  }

  // Hard ineligibility: the real consumer could not build a request either.
  const problems: string[] = [];
  if ((raw.destination ?? "") !== SUPPORTED_DESTINATION) {
    problems.push(
      `destination is "${raw.destination ?? "null"}" — only "${SUPPORTED_DESTINATION}" maps to a backend URL (the consumer itself returns 400 for anything else).`,
    );
  }
  if (!raw.domain?.trim()) problems.push("domain is empty.");
  if (!raw.action?.trim()) problems.push("action is empty.");
  if (!raw.method?.trim()) problems.push("method is empty.");

  const eligible = problems.length === 0;

  // Cautions that do NOT block — the operator decides.
  if (eligible) {
    const statusKey = (consumerStatus ?? "").toLowerCase();
    if (isAppliedStatus(consumerStatus)) {
      warnings.push(
        `Already ${consumerStatus} — this event has been applied. Re-running it will apply the same change a SECOND time.`,
      );
    } else if (!consumerStatus) {
      warnings.push(
        "No V2 consumer-status row — the call will be made, but there is no row to mark Success afterwards.",
      );
    } else if (statusKey === "queue") {
      warnings.push(
        `Status is ${consumerStatus} — the SQS message may still be live and could be delivered later, applying this change twice.`,
      );
    }
    if (target.service === "corp" && (raw.method ?? "").trim().toUpperCase() === "GET") {
      warnings.push(
        "Method is GET — the Corp API-key authorizer only allows non-GET /api/v1 paths unless the route is explicitly whitelisted, so this is likely to be denied.",
      );
    }
  }

  const input: ConsumerEventInput | null = eligible
    ? {
        eventId: raw.event_id,
        streamId: raw.stream_id,
        eventType: raw.event_type,
        domain: raw.domain!.trim(),
        action: raw.action!.trim(),
        method: raw.method!.trim(),
        data: raw.data,
        userDetails,
      }
    : null;

  const url = input ? buildConsumerRequest(target, input, cfg).url : null;

  return {
    row: {
      event_id: raw.event_id,
      stream_id: raw.stream_id,
      event_type: raw.event_type,
      destination: raw.destination,
      domain: raw.domain,
      action: raw.action,
      method: raw.method,
      url,
      consumer_status: consumerStatus,
      eligible,
      warnings: [...problems, ...warnings],
      http_status: null,
      response: null,
      db_updated: false,
    },
    input,
  };
}

/**
 * Replays the given event IDs against the target's backend API.
 *
 * Accepts ANY event ID present in `public.events` regardless of its consumer
 * status (user-directed), so the preview is the safety net: it shows the
 * resolved URL, the current status and an explicit warning on every event that
 * has already been applied. On a 2xx the V2 consumer-status row is marked
 * `Success` / `forceStatus = true`; SQS is never touched.
 */
export async function executeExpiredEvents(
  target: Target,
  input: string,
  options: { preview?: boolean } = {},
): Promise<OperationResult> {
  const { eventIds, streamIds } = partitionIdentifiers(input);
  const errors: OperationResult["errors"] = streamIds.map((t) => ({
    id: t,
    reason: "Not a numeric event ID — this operation accepts event IDs only.",
  }));

  if (!eventIds.length) {
    return {
      ok: false,
      message: "No numeric event IDs found in input.",
      attempted: 0,
      cleared: 0,
      errors,
      executed: [],
    };
  }
  if (eventIds.length > MAX_EXECUTE_IDS) {
    return {
      ok: false,
      message: `Too many event IDs (${eventIds.length}). Run at most ${MAX_EXECUTE_IDS} at a time — each event is a live HTTP call.`,
      attempted: 0,
      cleared: 0,
      errors,
      executed: [],
    };
  }

  // Resolved once up front: a missing base URL / API key should fail the whole
  // request loudly (the route surfaces the message) rather than per event.
  const cfg = resolveConsumerApi(target);

  const { events, statuses } = await fetchEventsForExecute(target, eventIds);

  const found = new Set(events.map((e) => e.event_id));
  for (const id of eventIds) {
    if (!found.has(String(id))) {
      errors.push({ id, reason: "Event ID not found in public.events." });
    }
  }

  const resolved = events.map((raw) =>
    resolveExecuteRow(target, raw, statuses.get(raw.event_id) ?? null, cfg),
  );
  const rows = resolved.map((r) => r.row);
  // Type predicate so the run loop needs no non-null assertion on `input`.
  const runnable = resolved.filter(
    (r): r is { row: ExecuteEventRow; input: ConsumerEventInput } =>
      r.input !== null,
  );

  if (options.preview) {
    const alreadyApplied = rows.filter(
      (r) => r.eligible && isAppliedStatus(r.consumer_status),
    ).length;
    const notFailed = rows.filter(
      (r) => r.eligible && (r.consumer_status ?? "").toLowerCase() !== "failed",
    ).length;

    const parts: string[] = [];
    if (runnable.length) {
      parts.push(
        `${runnable.length} event${runnable.length === 1 ? "" : "s"} will be sent to the live ${target.service.toUpperCase()} backend at ${describeConsumerRoute(target, cfg)}.`,
      );
    } else {
      parts.push("No event can be replayed. Nothing would be sent.");
    }
    if (alreadyApplied) {
      parts.push(
        `${alreadyApplied} ${alreadyApplied === 1 ? "has" : "have"} already been applied — re-running ${alreadyApplied === 1 ? "it" : "them"} duplicates the change.`,
      );
    } else if (notFailed) {
      parts.push(`${notFailed} ${notFailed === 1 ? "is" : "are"} not in Failed state.`);
    }

    return {
      ok: true,
      preview: true,
      candidates: runnable.length,
      message: parts.join(" "),
      attempted: 0,
      cleared: 0,
      errors,
      executed: rows,
    };
  }

  for (const r of resolved) {
    if (!r.input) {
      errors.push({
        id: r.row.event_id,
        reason: `Cannot be replayed: ${r.row.warnings.join(" ")}`,
      });
    }
  }

  let succeeded = 0;
  let dbUpdated = 0;

  for (let i = 0; i < runnable.length; i += EXECUTE_CONCURRENCY) {
    const batch = runnable.slice(i, i + EXECUTE_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ row, input: ev }) => {
        const req = buildConsumerRequest(target, ev, cfg);
        const out = await callConsumerApi(req);
        row.http_status = out.status;
        row.response = truncateResponse(out.raw);

        if (!out.ok) {
          errors.push({
            id: row.event_id,
            reason: `HTTP ${out.status ?? "—"}: ${truncateResponse(out.raw) || "<empty>"}\nRequest:\n${out.curl}`,
          });
          return;
        }

        succeeded++;
        // 2xx — mark the consumer-status row Success. SQS is deliberately left
        // alone for this action.
        try {
          const updated = await markEventForceSuccess(target, row.event_id);
          row.db_updated = updated > 0;
          if (updated > 0) dbUpdated++;
          else {
            row.warnings.push(
              "Call succeeded but no V2 consumer-status row existed to update.",
            );
          }
        } catch (e) {
          errors.push({
            id: row.event_id,
            reason: `Call succeeded (HTTP ${out.status}) but the consumer-status update failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
        }
      }),
    );
  }

  const failedCalls = runnable.length - succeeded;
  const message = runnable.length
    ? `Executed ${runnable.length} event${runnable.length === 1 ? "" : "s"}: ${succeeded} succeeded, ${failedCalls} failed. ${dbUpdated} consumer-status row${dbUpdated === 1 ? "" : "s"} marked Success.`
    : "No event could be replayed — nothing was sent.";

  return {
    ok: errors.length === 0,
    message,
    attempted: runnable.length,
    cleared: succeeded,
    errors,
    executed: rows,
  };
}
