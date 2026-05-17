import { getPool } from "./db";
import {
  deleteSqsBatchScheduler,
  deleteSqsMessage,
  refireSqsMessage,
} from "./playground";
import type {
  BatchStatusRow,
  EventStatusRow,
  OperationResult,
  Target,
} from "./types";

const CONSUMER = "V2";

function parseList(input: string): string[] {
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
      ecs.modified_date,
      ev.event_type
    FROM public.event_consumer_status ecs
    LEFT JOIN public.events ev ON ev."eventId" = ecs.eventid
    WHERE ${conditions.join(" AND ")}
    ORDER BY ecs.eventid DESC
  `;
  const { rows } = await pool.query(sql, params);
  return rows as EventStatusRow[];
}

async function markEventForceSuccess(
  target: Target,
  eventId: string | number,
): Promise<void> {
  const pool = getPool(target);
  await pool.query(
    `UPDATE public.event_consumer_status
     SET event_status = 'Success', "forceStatus" = true
     WHERE eventid = $1 AND consumer_name = $2`,
    [eventId, CONSUMER],
  );
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
