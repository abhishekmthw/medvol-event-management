import { getPool } from "./db";
import type { CounterColumn, CounterQueryResult, Target } from "./types";

/**
 * Raw Event Payloads — read-only browser over `public.events` (the V2 event
 * store) for ANY target: Corp or OMS, shared or a private instance (Lupin),
 * stage or prod. Given one or more stream IDs it returns the FULL event
 * records on those streams (metadata columns + the complete `data` and
 * `userDetails` payloads), newest first.
 *
 * Unlike the Counter Events views (which are Corp-only and reshape specific
 * event types), this card does no enrichment joins and no event-type filter —
 * it dumps every event on the stream verbatim. Everything is READ-ONLY and
 * parameterized; the mandatory stream-id predicate is the only selective
 * filter (performance assumes an index on `events."eventStreamStreamId"`).
 *
 * `public.events` is the shared event-store schema, so the same query runs
 * identically against every Corp/OMS/private-instance database.
 */

/** Hard cap on rows returned to the UI (guards against runaway result sets). */
const ROW_LIMIT = 1000;

/**
 * Columns for the raw dump. `payload` / `user_details` carry the whole JSONB
 * document (as a single-line JSON string) so the CSV export keeps each event's
 * full payload in one column, while the on-screen table pretty-prints them.
 */
export const RAW_EVENT_COLUMNS: CounterColumn[] = [
  { key: "stream_id", label: "Stream ID" },
  { key: "event_id", label: "Event ID" },
  { key: "event_type", label: "Event Type" },
  { key: "status", label: "Status" },
  { key: "timestamp", label: "Timestamp", isDate: true },
  { key: "domain", label: "Domain" },
  { key: "action", label: "Action" },
  { key: "method", label: "Method" },
  { key: "created_by", label: "Created By" },
  { key: "batch_id", label: "Batch ID" },
  { key: "payload", label: "Payload (data)", json: true },
  { key: "user_details", label: "User Details", json: true },
];

/**
 * Fetches every event on the given stream IDs for the target, newest first.
 * `data` / `userDetails` are cast to text (`::text`) so `pg` hands back a JSON
 * string ready for both the table and the CSV — no server-side stringify.
 */
export async function queryRawEvents(
  target: Target,
  streamIds: string[],
): Promise<CounterQueryResult> {
  if (!streamIds.length) {
    return {
      ok: false,
      columns: RAW_EVENT_COLUMNS,
      rows: [],
      count: 0,
      truncated: false,
      message: "At least one stream ID is required.",
    };
  }

  const pool = getPool(target);
  const sql = `
    SELECT
      e."eventStreamStreamId" AS stream_id,
      e."eventId"             AS event_id,
      e.event_type,
      e.status,
      e.timestamp,
      e.domain,
      e.action,
      e.method,
      e.created_by,
      e."batchId"             AS batch_id,
      e.data::text            AS payload,
      e."userDetails"::text   AS user_details
    FROM public.events e
    WHERE e."eventStreamStreamId" = ANY($1::text[])
    ORDER BY e."eventStreamStreamId", e.timestamp DESC
    LIMIT $2
  `;
  const { rows } = await pool.query(sql, [streamIds, ROW_LIMIT + 1]);

  const truncated = rows.length > ROW_LIMIT;
  const out = (truncated ? rows.slice(0, ROW_LIMIT) : rows) as Record<
    string,
    unknown
  >[];

  return {
    ok: true,
    columns: RAW_EVENT_COLUMNS,
    rows: out,
    count: out.length,
    truncated,
    message: out.length
      ? `Found ${out.length}${truncated ? "+" : ""} event${out.length === 1 ? "" : "s"}.`
      : "No events found for the supplied stream ID(s).",
  };
}
