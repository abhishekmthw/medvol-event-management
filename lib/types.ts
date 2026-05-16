export type Environment = "prod" | "stage";
export type Service = "corp" | "oms";

export type Target = {
  environment: Environment;
  service: Service;
  /** Private-instance id (matches PRIVATE_INSTANCE_{ID}_*). null = shared. */
  instance: string | null;
};

/** Payload returned by GET /api/instances and consumed by the UI. */
export type InstanceOption = {
  id: string;
  label: string;
  service: Service;
};

export type ActionKey =
  | "clear-by-event-ids"
  | "refire-by-event-ids"
  | "clear-by-stream-ids"
  | "clear-batch"
  | "status";

export const ACTIONS: {
  key: ActionKey;
  label: string;
  description: string;
  inputLabel: string;
  inputPlaceholder: string;
  inputHint: string;
  danger?: boolean;
}[] = [
  {
    key: "clear-by-event-ids",
    label: "Clear by Event IDs",
    description:
      "Force-success failed V2 events. Deletes the SQS message and sets forceStatus=true.",
    inputLabel: "Event IDs",
    inputPlaceholder: "45635815, 28156150, 28120800",
    inputHint: "Comma-separated numeric event IDs.",
    danger: true,
  },
  {
    key: "refire-by-event-ids",
    label: "Refire by Event IDs",
    description:
      "Change SQS visibility so failed V2 events are re-processed by the consumer.",
    inputLabel: "Event IDs",
    inputPlaceholder: "28156150, 28120800",
    inputHint: "Comma-separated numeric event IDs.",
  },
  {
    key: "clear-by-stream-ids",
    label: "Clear by Stream IDs",
    description:
      "Force-success every failed V2 event currently on the given stream(s).",
    inputLabel: "Stream IDs",
    inputPlaceholder: "counter_200746, order_375159",
    inputHint: "Comma-separated stream IDs (domain_primaryKey).",
    danger: true,
  },
  {
    key: "clear-batch",
    label: "Clear Batch Events",
    description:
      "Delete the EventBridge scheduler for failed batch_event_status rows and mark them ForceSuccess.",
    inputLabel: "Batch IDs",
    inputPlaceholder: "batch_20250908101020465, batch_20250911113445795",
    inputHint: "Comma-separated batch IDs (from batch_event_status.batch_id).",
    danger: true,
  },
  {
    key: "status",
    label: "Check Status",
    description:
      "Look up current event_consumer_status rows for the given event IDs or stream IDs.",
    inputLabel: "Event IDs or Stream IDs",
    inputPlaceholder: "45635815  •or•  counter_200746",
    inputHint:
      "Comma-separated. Numeric tokens are treated as event IDs; non-numeric as stream IDs.",
  },
];

export type EventStatusRow = {
  id: number;
  eventid: string;
  streamid: string;
  consumer_name: string;
  event_status: string;
  forceStatus: boolean;
  receipthandle: string | null;
  approximatereceivecount: number | null;
  sentry_issue_id: string | null;
  sentry_issue_status: string | null;
  error_message: string | null;
  modified_date: string | null;
  event_type: string | null;
};

export type BatchStatusRow = {
  id: number;
  batch_id: string;
  batch_sequence: number | string;
  event_type: string;
  event_status: string;
  force_status: boolean;
  data: unknown;
  modified_date: string | null;
};

export type OperationResult = {
  ok: boolean;
  message: string;
  attempted: number;
  cleared: number;
  errors: { id: string | number; reason: string }[];
  events?: EventStatusRow[];
  batch?: BatchStatusRow[];
  /** When true, no mutations were performed; rows shown are candidates. */
  preview?: boolean;
  /** Number of rows that would be mutated if executed (preview only). */
  candidates?: number;
  /**
   * Subset of `cleared` where the SQS message was already gone (receipt
   * handle expired after 15 days, or absent). The DB row was still updated.
   * Always 0 for refire / changeVisibility, which never updates the DB.
   */
  gone?: number;
};
