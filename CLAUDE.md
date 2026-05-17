> **BRANCH PROTECTION — EXEMPT**
> This repo has no protected branches. Direct commits and pushes to `main` are
> permitted (user-confirmed exemption, mirroring `event-store-sdk`). Use
> conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`). A Jira
> ticket prefix is not required for this repo — this is an internal utility,
> not ticket-driven product work.

# event-management

**Type:** Internal Web App (Next.js 14, App Router)
**Status:** Production
**Entry point:** `app/page.tsx` (dashboard) — protected by `middleware.ts`; auth lives in `app/login/page.tsx`
**Hosting:** GitHub repo `abhishekmthw/medvol-event-management`. No CI config in-tree (no `.github/`, no `Dockerfile`, no Pulumi). `.gitignore` lists `.vercel/`, suggesting Vercel deployment.

## Purpose

Internal ops tool used by Medvol engineers to inspect, clear (force-success), and refire failed **V2 events** sitting in PostgreSQL `event_consumer_status` / `batch_event_status` across Corp and OMS environments (stage + prod), including separately-deployed private instances (Lupin today). It replaces the ad-hoc `events.js` scratch script (kept locally for reference, gitignored) with a real authenticated UI, a preview-before-mutate flow, and per-environment / per-service / per-instance targeting.

Mutations are performed by:
- Direct `pg` writes to the database (set `event_status = 'Success'`, `forceStatus = true`).
- Direct **AWS SQS SDK** calls (`DeleteMessage`, `ChangeMessageVisibility`) against the V2 consumer queues — one queue per `(service, environment)` for the shared accounts, plus per-(env) queues for each private instance (each private instance lives in its own AWS account).
- Outbound calls to the external **Playground batch scheduler API** to delete EventBridge schedulers for batch retry rows.

## Tech Stack

- **Runtime:** Node.js (Next.js 14 App Router, `runtime = "nodejs"` on every API route — required because `pg` is not edge-compatible).
- **Language:** TypeScript (strict, ES2022 target, bundler module resolution).
- **UI:** React 18, Tailwind CSS, `lucide-react` icons, `next-themes` for dark mode, custom `card` / `btn-primary` / `btn-danger` / `btn-ghost` / `pill` / `input-base` component classes in `app/globals.css`.
- **DB:** PostgreSQL via `pg` (`Pool`, port 5432, max 5, 30s idle, 10s connect timeout). One pool per `(env, service, instance)` cached in-memory.
- **AWS:** `@aws-sdk/client-sqs` v3 for `DeleteMessage` / `ChangeMessageVisibility`. One `SQSClient` per `(env, instance)` cached in-memory; credentials passed explicitly per target.
- **Auth:** `jose` HS256 JWT in an httpOnly `em_session` cookie (24h TTL), gated by a single static username/password pair stored in env vars. Verification uses timing-safe equality.
- **Rate limit:** In-memory IP bucket (5 failures / 15 min window → 5 min lockout). Lives in process memory only — restarts reset.

## Key Files

| File | Role |
|------|------|
| `middleware.ts` | Edge middleware. Enforces a valid `em_session` JWT on every request except `/login`, `/api/auth/login`, `/api/auth/logout`, `/_next/*`, `/favicon`, `/logo.png`. Unauthenticated UI requests redirect to `/login?next=…`; unauthenticated API requests return `401 {error:"Unauthorized"}`. |
| `app/layout.tsx` | Root layout — Jost font, dark/light theme, metadata. |
| `app/page.tsx` | Main dashboard. Target picker (env / service / instance), operation tile selector (5 actions), input textarea with the **Format IDs** modal helper, preview-before-mutate flow, results card with `EventTable` / `BatchTable`. |
| `app/login/page.tsx` | Static-creds login form (username + password, show/hide password toggle). |
| `app/api/auth/login/route.ts` | `POST /api/auth/login` — checks IP lockout, verifies creds, signs JWT, sets `em_session` cookie (httpOnly, sameSite=lax, secure in prod). |
| `app/api/auth/logout/route.ts` | `POST /api/auth/logout` — clears `em_session`. |
| `app/api/instances/route.ts` | `GET /api/instances` — returns the list of `PRIVATE_INSTANCES` registered via env (Lupin today). The UI uses this to render the per-service instance picker. |
| `app/api/events/run/route.ts` | `POST /api/events/run` — validates `{action, environment, service, instance, input, preview}`, dispatches to `lib/events.ts` action handlers, returns `OperationResult`. |
| `lib/auth.ts` | `createSessionToken`, `verifySessionToken`, `verifyStaticCredentials` (timing-safe). Requires `AUTH_JWT_SECRET` ≥ 32 chars. |
| `lib/db.ts` | `getPool(target)` — resolves env prefix `{SERVICE}_{ENV}` or `PRIVATE_INSTANCE_{ID}_{ENV}`, builds and caches a `pg.Pool`, validates required vars at first use. |
| `lib/instances.ts` | Reads `PRIVATE_INSTANCES` (comma-sep ids) and per-instance `_LABEL` / `_SERVICE` env vars. |
| `lib/events.ts` | All event-store DB queries + action orchestration. Helpers: `parseList`, `partitionIdentifiers` (numeric → eventIds, non-numeric → streamIds). Actions: `checkStatus`, `clearByEventIds`, `refireByEventIds`, `clearByStreamIds`, `clearBatchEvents`. Each destructive action supports a `preview` mode that returns candidates without writes. |
| `lib/sqs.ts` | Direct AWS SDK SQS client — `deleteSqsMessage` and `refireSqsMessage`. Resolves queue URL + region + credentials per target: shared uses per-env vars (`{ENV}_AWS_*`, `{SERVICE}_{ENV}_SQS_QUEUE_URL`); each private instance uses per-instance creds (`PRIVATE_INSTANCE_{ID}_AWS_*`, shared across stage and prod since the instance lives in one AWS account) with per-env queue URLs (`PRIVATE_INSTANCE_{ID}_{ENV}_SQS_QUEUE_URL`). Maps known "receipt invalid" errors (`ReceiptHandleIsInvalid`, `InvalidParameterValue`, `MessageNotInflight`, `InvalidIdFormat`) to a `gone` outcome; other AWS errors surface with `queueUrl`, `region`, `httpStatus`, `requestId` in the reason. |
| `lib/playground.ts` | HTTPS client for the Playground batch scheduler API only (`DELETE {scheduler_name}` with `Authorization: {"apiKey":"…"}`). Honors `PLAYGROUND_FETCH_TIMEOUT_MS` (default 10s) with `AbortController`. Returns the request as a reproducible curl on error. The SQS half of this file was migrated to direct AWS SDK calls — see `lib/sqs.ts`. |
| `lib/rate-limit.ts` | IP-bucket failure counter + lockout state. Keys by `x-forwarded-for[0]` → `x-real-ip` → `"unknown"`. |
| `lib/types.ts` | Action keys + `ACTIONS` metadata (labels, placeholders, hints, `danger` flag), row types (`EventStatusRow`, `BatchStatusRow`), `OperationResult`, `Target`. |
| `components/logo.tsx` | MedVol logo SVG component. |
| `components/theme-provider.tsx` | `next-themes` wrapper. |
| `components/theme-toggle.tsx` | Light/dark toggle button. |
| `events.js` (root) | Legacy scratch script. Listed in `.gitignore` ("Original scratch script — kept locally for reference, not checked in"). Not loaded by anything; safe to ignore for behavior. |
| `next.config.mjs` | `reactStrictMode: true`, `experimental.serverComponentsExternalPackages: ["pg"]`. |

## Authentication & Business Logic

**Authentication.** A single global `AUTH_USERNAME` / `AUTH_PASSWORD` pair is shared across all engineers who need access. `POST /api/auth/login` validates with `timingSafeEqual`, mints a `jose` HS256 JWT (`iss=event-management`, `aud=event-management-ui`, `sub=username`, 24h `exp`), and sets it as the `em_session` cookie. `middleware.ts` verifies the JWT on every non-public request. There is no user table, no MFA, and no SSO — this is an internal tool guarded by a shared secret and IP rate-limiting; production-secret rotation is a manual operation.

**Targeting.** Each request specifies `{environment ∈ {stage, prod}, service ∈ {corp, oms}, instance: string | null}`. The pool factory resolves `(env, service, instance)` to an env-var prefix:
- Shared:  `{SERVICE}_{ENV}` → `CORP_PROD`, `OMS_STAGE`, …
- Private: `PRIVATE_INSTANCE_{ID}_{ENV}` → `PRIVATE_INSTANCE_LUPIN_PROD`, …

The UI's instance picker is rendered dynamically from `/api/instances` (which reads `PRIVATE_INSTANCES`), so adding a new private instance requires only env changes — no code edits.

**Actions** (`lib/events.ts`, all scoped to `consumer_name = 'V2'`):

| Action | Reads | Mutates | Notes |
|--------|-------|---------|-------|
| `status` | `event_consumer_status` (joined with `events` for `event_type`) | none | Accepts numeric event IDs or string stream IDs in the same input — `partitionIdentifiers` splits them. |
| `clear-by-event-ids` | failed `event_consumer_status` rows for the given IDs | `event_status = 'Success'`, `"forceStatus" = true`; calls AWS SQS `DeleteMessage` on each receipt handle | If a row has no receipt handle, DB is still force-succeeded ("gone"). A 15-day-old receipt also returns "gone". |
| `refire-by-event-ids` | failed `event_consumer_status` rows for the given IDs | none in DB (by spec); calls AWS SQS `ChangeMessageVisibility` (5s timeout) to re-deliver | If the receipt is "gone" (>15 day SQS retention) the row reports an error suggesting `clear-by-event-ids` instead. **Never touches the DB.** |
| `clear-by-stream-ids` | every failed `event_consumer_status` row on the given stream IDs | same as `clear-by-event-ids` | Useful when you want to nuke every failure on a stream regardless of event id. |
| `clear-batch` | failed `batch_event_status` rows for the given batch IDs | `event_status = 'Success'`, `"force_status" = true`; calls Playground batch scheduler `DELETE` with `scheduler_name = "{batch_sequence}-{batch_id}"` before the DB update | If the scheduler DELETE fails the DB is **not** updated for that row. |

**Preview vs run.** All destructive actions accept `{preview: true}` in the request. Preview executes only the SELECT (no DB writes, no SQS calls, no Playground calls) and returns the candidate rows + count. The UI requires explicit confirmation in a modal before sending `{preview: false}`. Production targets render the confirm button in danger red.

**Input parsing.** `parseList()` splits on **whitespace OR commas** and trims/filters empties — so users can paste comma-separated, space-separated, or newline-separated IDs. `partitionIdentifiers()` treats purely-digit tokens as event IDs (cast to `numeric[]` for `event_consumer_status.eventid`) and everything else as stream IDs (cast to `text[]` for `streamid`). All DB calls use parameterized queries — no string interpolation.

**Format IDs helper (UI).** The dashboard exposes a `Wand2` button next to the input area that opens a modal for assembling comma-separated strings from a multi-line paste. Options: strip arbitrary characters (e.g. `"`), prefix and/or suffix each item (e.g. wrap with `'…'` for raw SQL elsewhere). Output has a clipboard copy button. Purely client-side; does not touch the API.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AUTH_USERNAME` | Static login username. |
| `AUTH_PASSWORD` | Static login password. |
| `AUTH_JWT_SECRET` | HS256 signing secret for `em_session` JWTs. **Must be ≥ 32 characters** (enforced at runtime). Generate with `openssl rand -base64 48`. |
| `LOGIN_MAX_FAILURES` | Failures in `LOGIN_WINDOW_MINUTES` before lockout. Default `5`. |
| `LOGIN_WINDOW_MINUTES` | Rolling window for failure count. Default `15`. |
| `LOGIN_LOCKOUT_MINUTES` | Lockout duration after threshold hit. Default `5`. |
| `PLAYGROUND_FETCH_TIMEOUT_MS` | Timeout for outbound Playground batch-scheduler HTTP calls. Default `10000`. |
| `PLAYGROUND_SQS_BATCH_API_URL` | Playground batch scheduler endpoint (DELETE). |
| `PLAYGROUND_SQS_BATCH_API_KEY` | API key sent as `Authorization: {"apiKey":"…"}` to the scheduler endpoint. |
| `PROD_AWS_ACCESS_KEY_ID` / `PROD_AWS_SECRET_ACCESS_KEY` | AWS credentials for the prod account — used for `CORP_PROD` + `OMS_PROD` SQS queues. |
| `PROD_AWS_REGION` | Region for prod AWS calls. Optional; defaults to `ap-south-1`. |
| `STAGE_AWS_ACCESS_KEY_ID` / `STAGE_AWS_SECRET_ACCESS_KEY` | AWS credentials for the stage account — used for `CORP_STAGE` + `OMS_STAGE` SQS queues. |
| `STAGE_AWS_REGION` | Region for stage AWS calls. Optional; defaults to `ap-south-1`. |
| `CORP_PROD_SQS_QUEUE_URL` / `CORP_STAGE_SQS_QUEUE_URL` | V2 consumer SQS queue URL for Corp (prod / stage). |
| `OMS_PROD_SQS_QUEUE_URL` / `OMS_STAGE_SQS_QUEUE_URL` | V2 consumer SQS queue URL for shared OMS (prod / stage). |
| `CORP_PROD_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | Corp production DB. |
| `CORP_STAGE_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | Corp stage DB. |
| `OMS_PROD_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | OMS production (shared instance) DB. |
| `OMS_STAGE_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | OMS stage (shared instance) DB. |
| `PRIVATE_INSTANCES` | Comma-separated lowercase ids of private instances to register (e.g. `lupin` or `lupin,alpha`). |
| `PRIVATE_INSTANCE_{ID}_LABEL` | Human-readable instance name shown in the UI (e.g. `Lupin`). |
| `PRIVATE_INSTANCE_{ID}_SERVICE` | `corp` or `oms`. |
| `PRIVATE_INSTANCE_{ID}_PROD_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | Per-instance prod DB. |
| `PRIVATE_INSTANCE_{ID}_STAGE_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | Per-instance stage DB. |
| `PRIVATE_INSTANCE_{ID}_PROD_SQS_QUEUE_URL` / `_STAGE_SQS_QUEUE_URL` | Per-instance V2 consumer SQS queue URL (one per env). |
| `PRIVATE_INSTANCE_{ID}_AWS_ACCESS_KEY_ID` / `_AWS_SECRET_ACCESS_KEY` | AWS credentials for the instance's AWS account. **Shared across both environments** — the instance lives in a single AWS account that hosts both stage and prod queues. |
| `PRIVATE_INSTANCE_{ID}_AWS_REGION` | Optional region override per instance. Defaults to `ap-south-1`. |
| `NODE_ENV` | Standard Next.js. `production` makes the session cookie `secure: true`. |

`.env.example` at the repo root mirrors every variable above and is the authoritative source for new env additions.

## AWS Resources

- **SQS — direct AWS SDK calls.** `lib/sqs.ts` uses `@aws-sdk/client-sqs` v3 to call `DeleteMessage` and `ChangeMessageVisibility` against the V2 consumer queues. Region defaults to `ap-south-1`.
- **Credential scoping:**
  - Shared queues (`CORP_PROD`, `OMS_PROD`, `CORP_STAGE`, `OMS_STAGE`) are reached using per-env credentials (`PROD_AWS_*` / `STAGE_AWS_*`). The Corp and shared OMS queues live in the same AWS account *per environment*, so one credential set per environment is sufficient.
  - Each private instance lives in its own AWS account (e.g., Lupin) hosting **both** its stage and prod queues. Credentials are scoped per-instance (`PRIVATE_INSTANCE_{ID}_AWS_*`), and only the queue URL varies per environment (`PRIVATE_INSTANCE_{ID}_{ENV}_SQS_QUEUE_URL`).
- **Clients are cached** per `(env)` for the shared accounts and per `(instance)` for private accounts. Credentials are passed explicitly (no reliance on the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` fallback, so prod creds cannot leak into a stage call).

## Database

- **Engine:** PostgreSQL (port 5432).
- **Tables read/written:**
  - `public.event_consumer_status` — V2 consumer tracking. Reads `id, eventid, streamid, consumer_name, event_status, "forceStatus", receipthandle, approximatereceivecount, sentry_issue_id, sentry_issue_status, error_message, modified_date`. Updates `event_status = 'Success'`, `"forceStatus" = true` on clear actions. All queries filter `consumer_name = 'V2'`.
  - `public.events` — joined left for `event_type` only (lookup via `events."eventId" = event_consumer_status.eventid`). Never written.
  - `public.batch_event_status` — V2 batch tracking. Reads `id, batch_id, batch_sequence, event_type, event_status, force_status, data, modified_date`. Updates `event_status = 'Success'`, `"force_status" = true` on `clear-batch`.
- **Pool config:** `max: 5`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`. One pool per `(env, service, instance)` cached for process lifetime.

## External Integrations

- **AWS SQS** (direct, via `@aws-sdk/client-sqs`). `DeleteMessage` for clear actions and `ChangeMessageVisibility` (5s timeout) for refire actions. Credentials are taken from the env per-target (see "AWS Resources"). Replaces the previous Playground SQS HTTP API hop, which was IP-blocked from Vercel egress.
- **Playground batch scheduler API** — `DELETE {scheduler_name}` with `Authorization: {"apiKey":"…"}` (note the JSON-encoded value). Removes the EventBridge Scheduler that would have re-fired the batch. Still HTTP-based; on error the returned `reason` includes a reproducible curl with the exact URL/headers/body.

## Deployment

- No in-repo CI/CD. `.gitignore` lists `.vercel/`, indicating Vercel as the most likely host (Next.js app, no Dockerfile, no Pulumi).
- `npm run build` produces a standard Next.js build. `npm run start` runs the production server. `npm run dev` is the dev server.
- `npm run typecheck` runs `tsc --noEmit` and is the canonical pre-merge gate (no test suite present).

## Relation to Other Services

`event-management` is a **consumer of state produced by every V2 event pipeline** in the platform:

- Reads `event_consumer_status` rows written by **`lambda-corp-consumer`** (Corp V2 events) and **`lambda-oms-consumer`** (OMS V2 events, including per-instance deploys for private companies).
- Reads `batch_event_status` rows written by **`md-batch-lambda`** (`event-api-creation` consumes the batch event SQS and writes status; `mk-delete-batch-schedular` deletes schedulers — the same scheduler-delete operation this tool calls via the Playground API).
- The events being cleared/refired here originate from **`backend_corp_svc`** and **`backend-oms-svc`** `/event/*` endpoints (which sign with `EVENT_SIGNING_SECRET` via `@medvol-v2/event-store` and publish to SNS FIFO).
- Acts directly on the V2 consumer SQS queues (`DeleteMessage` / `ChangeMessageVisibility`) — the same queues that `lambda-corp-consumer` and `lambda-oms-consumer` consume from.
- Force-success or refire here is the **last-resort manual recovery path** when an event has failed beyond the consumer's automatic retry attempts.

This service does **not** publish events and does not call any other Medvol backend — side effects are scoped to direct DB writes against the listed tables, direct AWS SQS calls against the V2 consumer queues, and HTTP calls to the Playground batch-scheduler API.
