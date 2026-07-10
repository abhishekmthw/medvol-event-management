> **BRANCH PROTECTION — EXEMPT**
> This repo has no protected branches. Direct commits and pushes to `main` are
> permitted (user-confirmed exemption, mirroring `event-store-sdk`). Use
> conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`). A Jira
> ticket prefix is not required for this repo — this is an internal utility,
> not ticket-driven product work.

# event-management

**Type:** Internal Web App (Next.js 14, App Router)
**Status:** Production
**Entry point:** `app/page.tsx` (Event Ops dashboard) — protected by `middleware.ts`; auth lives in `app/login/page.tsx`. Three more tabs are reachable from the shared header nav: `app/counter/page.tsx` (**Counter Events**, read-only), `app/otp-block/page.tsx` (**24h OTP Block**, clears OTP lockouts in the auth DB), and `app/auth-comparison/page.tsx` (**Auth Details Comparison**, read-only — reconciles field-force employees across the auth DB, corp DB and Cognito).
**Hosting:** GitHub repo `abhishekmthw/medvol-event-management`. No CI config in-tree (no `.github/`, no `Dockerfile`, no Pulumi). `.gitignore` lists `.vercel/`, suggesting Vercel deployment.

## Purpose

Internal ops tool used by Medvol engineers to inspect, clear (force-success), and refire failed **V2 events** sitting in PostgreSQL `event_consumer_status` / `batch_event_status` across Corp and OMS environments (stage + prod), including separately-deployed private instances (Lupin today). It replaces the ad-hoc `events.js` scratch script (kept locally for reference, gitignored) with a real authenticated UI, a preview-before-mutate flow, and per-environment / per-service / per-instance targeting.

Mutations are performed by:
- Direct `pg` writes to the database (set `event_status = 'Success'`, `forceStatus = true`).
- Direct **AWS SQS SDK** calls (`DeleteMessage`, `ChangeMessageVisibility`) against the V2 consumer queues — one queue per `(service, environment)` for the shared accounts, plus per-(env) queues for each private instance (each private instance lives in its own AWS account).
- Outbound calls to the external **Playground batch scheduler API** to delete EventBridge schedulers for batch retry rows.

A second, **read-only** tab — **Counter Events** (`app/counter/page.tsx`) — browses the raw `public.events` event store in the **Corp DB** (stage/prod) to reconstruct historical counter master changes (division / products / stockist) per stream. It performs **no writes** (no SQS, no Playground); it only `SELECT`s from `public.events` (joined to Corp master tables for enrichment). See "Counter Events" below.

A third tab — **24h OTP Block** (`app/otp-block/page.tsx`) — clears the 24-hour OTP lockout for a user by setting `otp_retry_count` and `lockup_date` to `NULL` on the relevant V1 auth table. It connects to a dedicated **auth DB** target (stage/prod), supports a user-type selector (stockist / field force / counter / delegate / admin) and batch mobile-number input, and uses the same preview-before-mutate + confirm flow as the Event Ops actions. See "24h OTP Block" below.

A fourth, **read-only** tab — **Auth Details Comparison** (`app/auth-comparison/page.tsx`) — reconciles **field-force employees**, **driven by corp**: corp `empmaster_hdr` (via the `corp` service pool) is the base list and the source of truth for short code / company code / name / mobile; each corp employee is checked against the **auth DB** (`Field_Force_Users`, via `getAuthPool`, matched by short code + company code) and **AWS Cognito** (`ListUsers` only; the source of truth for `cognito_id`). With a mobile number it looks up the corp employee(s) for that mobile then checks auth + Cognito; with the field blank it scans the first 100 corp employees that don't match auth and validates those against Cognito. Auth records with no corp match are not reported. The tab also hosts an **Employee ↔ Cognito Check** card — an auth-driven, chunked full scan of every `Field_Force_Users` row with a `cognito_id`, comparing mobile number + short code against the live Cognito user (`phone_number` / `custom:emp_short_code`) — and an **Employee Data Correction** card (the tab's only writing surface): corp-first, mobile-keyed analysis with two preview-confirm corrections — replay the `employee_<empmaster_id>` corp event stream onto the V1 auth SQS queue when the user is missing in auth, and write the live Cognito sub into corp + auth `cognito_id`. See "Auth Details Comparison" below.

## Tech Stack

- **Runtime:** Node.js (Next.js 14 App Router, `runtime = "nodejs"` on every API route — required because `pg` is not edge-compatible).
- **Language:** TypeScript (strict, ES2022 target, bundler module resolution).
- **UI:** React 18, Tailwind CSS, `lucide-react` icons, `next-themes` for dark mode, custom `card` / `btn-primary` / `btn-danger` / `btn-ghost` / `pill` / `input-base` component classes in `app/globals.css`.
- **DB:** PostgreSQL via `pg` (`Pool`, port 5432, max 5, 30s idle, 10s connect timeout). One pool per `(env, service, instance)` cached in-memory.
- **AWS:** `@aws-sdk/client-sqs` v3 for `DeleteMessage` / `ChangeMessageVisibility`. One `SQSClient` per `(env, instance)` cached in-memory; credentials passed explicitly per target. `@aws-sdk/client-cognito-identity-provider` v3 for read-only `ListUsers` (Auth Details Comparison tab); one client per env, same explicit-credential pattern.
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
| `app/counter/page.tsx` | **Counter Events** tab. View selector (division / products / stockist) + Environment (stage/prod, Corp-only), required Stream IDs textarea (+ Format IDs helper), cascading Company→Division dropdowns, Location free-text, From/To date pickers. Read-only — runs a query and renders `CounterTable`. |
| `app/api/counter/companies/route.ts` | `GET ?environment=` — active companies from `company_hdr` (name shown, `code` submitted). |
| `app/api/counter/divisions/route.ts` | `GET ?environment=&company=` — divisions from `companydivision_dtl` scoped to the company (cascaded dropdown). |
| `app/api/counter/query/route.ts` | `POST {environment, view, streamIds, companyCode?, divisionCode?, locationCode?, fromDate?, toDate?}` — validates, parses stream IDs (`parseList`), forces Corp target, dispatches to `lib/counter.ts`, returns `CounterQueryResult`. |
| `lib/counter.ts` | Counter Events queries (READ-ONLY, Corp-only). `COUNTER_COLUMNS` (per-view column defs), `queryCounterEvents` (per-view parameterized SQL builders with optional filters + `LIMIT 1000`), `fetchCompanies`, `fetchDivisions`. |
| `app/otp-block/page.tsx` | **24h OTP Block** tab. Environment (stage/prod) + User Type (stockist / field force / counter / delegate / admin) selectors, batch mobile-number textarea, preview-before-mutate + confirm flow, results via `OtpBlockTable`. |
| `app/api/otp-block/run/route.ts` | `POST {environment, userType, input, preview}` — validates env + user type (`isOtpUserType`) + non-empty input, dispatches to `clearOtpBlock`, returns `OtpBlockResult`. |
| `lib/otp-block.ts` | 24h OTP Block logic. `USER_TYPES` (user type → case-sensitive table + `hasName`), `isOtpUserType` guard, `clearOtpBlock` (preview = SELECT only; run = `UPDATE … SET otp_retry_count = NULL, lockup_date = NULL WHERE mobile_no = ANY($1::text[])` then re-SELECT). Schema-qualified, parameterized. |
| `components/otp-block-table.tsx` | Results/candidates table for the OTP Block tab (id, mobile, name, otp_retry_count, lockup_date, blocked/clear state). |
| `app/auth-comparison/page.tsx` | **Auth Details Comparison** tab. Environment (stage/prod) + Scope (Active only / All employees) selectors, optional mobile-number input. Read-only — empty mobile runs the bulk top-100 inconsistency scan; a mobile runs a single lookup. Renders `AuthComparisonTable` inline (no preview/confirm). Also hosts the **Employee ↔ Cognito Check** card — a chunked full scan of auth `Field_Force_Users` vs Cognito (client loops `offset` requests, live progress + Stop button, mismatches accumulated into `EmployeeCognitoTable` + CSV). |
| `app/api/auth-comparison/fetch/route.ts` | `POST {environment, mobile?, scope}` — validates env + scope (`isEmployeeScope`); dispatches to `compareByMobile` (mobile present) or `scanInconsistent` (blank). Returns `AuthComparisonResult`. |
| `app/api/auth-comparison/employee-cognito/route.ts` | `POST {environment, scope, offset}` — validates env + scope + non-negative integer offset; dispatches to `checkEmployeesAgainstCognito`. Returns one `EmployeeCognitoChunk` (200 employees per call; `nextOffset` drives the client loop). |
| `lib/auth-comparison.ts` | Corp-driven Auth/Corp/Cognito reconciliation (READ-ONLY). `empmaster_hdr` (corp pool) is the base/truth; each corp employee is matched to `Field_Force_Users` (auth pool) by (short code, company code) and validated against Cognito (the truth for `cognito_id`). Corp `active_status='Y'` scope filter; auth fetched unfiltered. `normalizeMobile`, `compareByMobile`, `scanInconsistent`, `isEmployeeScope`. Also `checkEmployeesAgainstCognito` — the auth-driven Employee ↔ Cognito chunked scan (LIMIT/OFFSET over `Field_Force_Users` rows with a `cognito_id`, per-distinct-sub `lookupBySub`, compares mobile + short code vs the live Cognito user, then matches corp `empmaster_hdr` by (short code, company code) and compares name / mobile / cognito_id vs corp). |
| `lib/cognito.ts` | Read-only Cognito client (`@aws-sdk/client-cognito-identity-provider`), cached per env. `lookupByMobile` (filter `phone_number = "+91…"`) and `lookupBySub` (filter `sub = "…"`); reuses `{ENV}_AWS_*` creds + `{ENV}_COGNITO_USERPOOL_ID`. Parses `sub`, `name`, `phone_number`, `custom:emp_short_code`, username/status/enabled. Only `ListUsers` — never any write. |
| `components/auth-comparison-table.tsx` | Results table — one row per corp employee with corp/auth/cognito values stacked per field (corp first = truth); cells deviating from their source of truth tinted red; status chips per row. |
| `components/employee-cognito-table.tsx` | Results table for the Employee ↔ Cognito Check card — one row per mismatched auth employee; short code / name / mobile / cognito_id stack auth/cognito/corp values (mismatches tinted red); Cognito account state (username / status / enabled) shown for context. |
| `lib/comparison-csv.ts` | Client-safe (type-only imports) CSV builder. `toComparisonCsv(result)` flattens each record to corp/auth/cognito columns per field (corp first) + deviation flags + status, with a UTF-8 BOM for Excel. Used by the "Download CSV" button on the results card. Also `toEmployeeCognitoCsv(rows)` for the Employee ↔ Cognito Check mismatch export. |
| `lib/correction.ts` | **Employee Data Correction** logic (the tab's only writing module). `analyzeByMobile` (corp-first read-only analysis), `replayEmployeeStream` (replays corp `employee_<id>` events onto the V1 auth SQS FIFO queue; preview lists events; live run refused when the employee already exists in auth), `fixCognitoId` (resolves the live Cognito sub by corp mobile + short-code guard, then UPDATEs `empmaster_hdr.cognito_id` + `Field_Force_Users.cognito_id`), `syncAuthFromCorp` (UPDATEs drifted `name` / `mobile_no` / `ucode` on the existing auth record from corp values; shares `computeAuthSyncChanges` with analyze). All inputs re-derived server-side from `empmaster_id`. |
| `app/api/auth-comparison/correction/analyze/route.ts` | `POST {environment, mobile}` — corp-first analysis, returns `CorrectionAnalyzeResult`. Read-only. |
| `app/api/auth-comparison/correction/replay/route.ts` | `POST {environment, empmasterId, preview}` — event replay to the auth queue (`preview: true` = list only). |
| `app/api/auth-comparison/correction/fix-cognito/route.ts` | `POST {environment, empmasterId, preview}` — cognito_id fix in corp + auth (`preview: true` = report only). |
| `app/api/auth-comparison/correction/sync-auth/route.ts` | `POST {environment, empmasterId, preview}` — syncs drifted name / mobile / ucode on the existing auth record from corp (`preview: true` = before/after per column only). |
| `app/api/auth-comparison/correction/release-cognito/route.ts` | `POST {environment, empmasterId, preview}` — NULLs the employee's live sub on every OTHER corp/auth record storing it (`preview: true` = list the records only). |
| `app/api/auth-comparison/correction/clear-cognito/route.ts` | `POST {environment, empmasterId, preview}` — NULLs a confirmed-wrong stored cognito_id (stale / different owner) on THIS employee's corp/auth rows when no rightful Cognito user resolves (`preview: true` = list the sides + reasons only). |
| `components/data-correction-card.tsx` | Employee Data Correction card — mobile input, per-employee corp/auth/cognito field table, action buttons with preview-confirm modals, post-replay polling until the user appears in auth. |
| `lib/auth.ts` | `createSessionToken`, `verifySessionToken`, `verifyStaticCredentials` (timing-safe). Requires `AUTH_JWT_SECRET` ≥ 32 chars. |
| `lib/db.ts` | `getPool(target)` — resolves env prefix `{SERVICE}_{ENV}` or `PRIVATE_INSTANCE_{ID}_{ENV}`, builds and caches a `pg.Pool`, validates required vars at first use. Also `getAuthPool(env)` (auth DB, prefix `AUTH_{ENV}`) and `authSchema(env)` (`AUTH_{ENV}_DB_SCHEMA`, default `public`, validated identifier) for the 24h OTP Block tab. |
| `lib/instances.ts` | Reads `PRIVATE_INSTANCES` (comma-sep ids) and per-instance `_LABEL` / `_SERVICE` env vars. |
| `lib/events.ts` | All event-store DB queries + action orchestration. Helpers: `parseList`, `partitionIdentifiers` (numeric → eventIds, non-numeric → streamIds). Actions: `checkStatus`, `clearByEventIds`, `refireByEventIds`, `clearByStreamIds`, `clearBatchEvents`. Each destructive action supports a `preview` mode that returns candidates without writes. |
| `lib/sqs.ts` | Direct AWS SDK SQS client — `deleteSqsMessage` and `refireSqsMessage`. Resolves queue URL + region + credentials per target: shared uses per-env vars (`{ENV}_AWS_*`, `{SERVICE}_{ENV}_SQS_QUEUE_URL`); each private instance uses per-instance creds (`PRIVATE_INSTANCE_{ID}_AWS_*`, shared across stage and prod since the instance lives in one AWS account) with per-env queue URLs (`PRIVATE_INSTANCE_{ID}_{ENV}_SQS_QUEUE_URL`). Maps known "receipt invalid" errors (`ReceiptHandleIsInvalid`, `InvalidParameterValue`, `MessageNotInflight`, `InvalidIdFormat`) to a `gone` outcome; other AWS errors surface with `queueUrl`, `region`, `httpStatus`, `requestId` in the reason. |
| `lib/playground.ts` | HTTPS client for the Playground batch scheduler API only (`DELETE {scheduler_name}` with `Authorization: {"apiKey":"…"}`). Honors `PLAYGROUND_FETCH_TIMEOUT_MS` (default 10s) with `AbortController`. Returns the request as a reproducible curl on error. The SQS half of this file was migrated to direct AWS SDK calls — see `lib/sqs.ts`. |
| `lib/rate-limit.ts` | IP-bucket failure counter + lockout state. Keys by `x-forwarded-for[0]` → `x-real-ip` → `"unknown"`. |
| `lib/types.ts` | Action keys + `ACTIONS` metadata (labels, placeholders, hints, `danger` flag), row types (`EventStatusRow`, `BatchStatusRow`), `OperationResult`, `Target`, and Counter Events types (`CounterView`, `CounterColumn`, `CounterFilters`, `CounterQueryResult`, `CounterOption`). |
| `components/app-header.tsx` | Shared sticky header with the section nav tabs (`Event Ops` → `/`, `Counter Events` → `/counter`, `24h OTP Block` → `/otp-block`), theme toggle and logout. Used by all pages. |
| `components/segmented.tsx` | Shared `Segmented<T>` tab-style single-select control (lifted out of `page.tsx`). |
| `components/format-ids-modal.tsx` | Shared `FormatIdsModal` paste-to-CSV helper (lifted out of `page.tsx`). |
| `components/counter-table.tsx` | Generic, column-driven results table for Counter Events (columns vary per view, unlike the fixed `EventTable`/`BatchTable`). |
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

## Counter Events (read-only)

A second tab (`app/counter/page.tsx`, `lib/counter.ts`) for **auditing historical counter master changes** straight from the `public.events` event store in the **Corp DB** (stage/prod). It does **no writes** — no SQS, no Playground, no preview/confirm flow.

- **Three views**, each filtering `events.event_type LIKE '%COUNTER_{DIVISION|PRODUCT|STOCKIST}%'` (the view drives the pattern — it is not a user input):
  - **Counter Products** — unnests `data->'counter_product_slab'`, enriched with division (`company_divisioncode`, `division_name`) via `companyproduct_hdr → item_divisiondtl → companydivision_dtl`. The join chain runs **once per event inside a CTE**, then the slab unnest runs last (avoids recomputing the joins per slab — the inefficiency of the original ad-hoc query).
  - **Counter Division** — unnests `data->'company_division_code'` (division name + code live in each array element under `company_division_name` / `company_division_code`); employee name via `emp_position_hdr → empmaster_hdr`.
  - **Counter Stockist** — joins `StockistCluster_Lnk → StockistCompany_Lnk` and `cluster_hdr`. The `::integer` casts on jsonb values are **regex-guarded** (`~ '^[0-9]+$'`) so one bad value can't abort the query. No division concept.
- **Filters:** Stream ID(s) **mandatory** (`= ANY($1::text[])`, `parseList`); Company (`data->>'company_code'`, all views), Division (products via `idd.company_divisioncode`, division via the array element's `company_division_code`; **hidden for stockist**), Location (`data->>'location_code'`), and From/To date (`timestamp >= from::date` / `< to::date + 1 day`) — all optional.
- **Dropdowns:** Company list from `company_hdr` (active only, name shown / `code` submitted); Division cascades from `companydivision_dtl WHERE company_code = …`. Codes are compared as text against the jsonb values.
- **Safeguards:** every query is parameterized (no interpolation) and capped at `LIMIT 1000` (`truncated` flag surfaces a "showing first 1000" badge). The mandatory, most-selective predicate is the stream id — performance assumes an index on `events."eventStreamStreamId"` (verify on prod; the same table already caused a documented seq-scan 504 for the `event_type` lookup in `lib/events.ts`).
- **Caveat:** an item mapped to multiple divisions multiplies product rows (one per slab × division).

## 24h OTP Block (auth DB write)

A third tab (`app/otp-block/page.tsx`, `lib/otp-block.ts`) that **clears the 24-hour OTP lockout** for a user. When a user fails OTP login 5 times, the auth-backend (`PUT /updateOTPAttempts`) sets `otp_retry_count = 5` and `lockup_date = now + 1 day` on that user's table. This tab NULLs both columns so the user can log in again.

- **Target:** dedicated **auth DB** (the V1 auth-backend / Corp DB), selected by **environment** (stage / prod). Separate from the `corp`/`oms` service pools — uses `getAuthPool(env)` with `AUTH_{ENV}_DB_*` creds, and `authSchema(env)` (`AUTH_{ENV}_DB_SCHEMA`, default `public`) because the auth-backend's tables may live in a non-public `POSTGRES_SCHEMA`.
- **User type** selector maps to the table holding that type's OTP state (all share `otp_retry_count`, `lockup_date`, `mobile_no`):

  | User Type | Table |
  |---|---|
  | Stockist | `Stockists` (NOT `Stockist_Dtl`) |
  | Field Force | `Field_Force_Users` |
  | Counter | `Counter_Company_Lnk` (one mobile can match several rows — one per company) |
  | Delegate | `Delegate_Users` |
  | Admin | `Admin_Users` |

- **Input:** one or more mobile numbers (comma/space/newline separated via `parseList`), matched exactly against `mobile_no`.
- **Flow:** preview runs a SELECT and shows the matched rows + their current block state; on confirm, a single `UPDATE … SET otp_retry_count = NULL, lockup_date = NULL WHERE mobile_no = ANY($1::text[])` runs, then a re-SELECT shows the post-state. Prod renders the confirm button in danger red, same as the Event Ops destructive actions.
- **Safety:** table names are fixed internal constants and the schema is a validated bare identifier; only mobile numbers are interpolated, and always as a parameterized `text[]`. Mobiles with no matching row are surfaced as informational notes, not failures.

## Auth Details Comparison (comparison cards read-only; Data Correction card writes on confirm)

A fourth tab (`app/auth-comparison/page.tsx`, `lib/auth-comparison.ts`, `lib/cognito.ts`) that **reconciles field-force employees**, **driven by corp**: corp `empmaster_hdr` is the base list AND the source of truth for short code / company code / name / mobile; each corp employee is then checked against the auth DB and against AWS Cognito (the source of truth for `cognito_id`). It does **no writes** — only `SELECT`s and Cognito `ListUsers`.

- **Direction (corp-driven):** iterate corp employees; for each, look up the matching auth record by the **(short code, company code)** pair. Auth records with **no** corp match are **not** reported (there is no "auth-only"/"missing in corp" category). A short code is only unique *within a company*, so company code is part of the match key.
- **Sources & pools:**
  - **corp** (base) — `empmaster_hdr` via the existing `corp` service pool (`getPool({env, service:"corp", instance:null})`). Scope filters this set.
  - **auth** (lookup) — `Field_Force_Users` via `getAuthPool(env)` + `authSchema(env)`. Fetched **without** an active filter (so a corp employee that exists in auth but is inactive there is still detected, not falsely "Missing in auth"). In single-mobile mode only the corp matches' short codes are fetched (`short_code = ANY(...)`); in bulk the whole table is fetched and mapped in Node.
  - **cognito** (truth for cognito_id) — `lib/cognito.ts`, `ListUsers` against the field-force user pool (`{ENV}_COGNITO_USERPOOL_ID`), reusing the SQS section's `{ENV}_AWS_*` credentials.
- **Why join in Node, not SQL:** auth and corp are separately-configured pools that may point at different databases, so a cross-DB join is unsafe; fetch each and join in app code. Both `company_code` columns hold the same human company code (auth `Companies.id` is a `@PrimaryColumn` = the code, stored on the `Field_Force_Users.company_code` FK; corp `empmaster_hdr.company_code` = `company_hdr.code`), so they compare directly with no Companies lookup. Volume is small enough for an internal tool.
- **Compared fields (vs source of truth):** **name** and **mobile** — auth vs corp (corp = truth; normalized to last 10 digits for mobile). **cognito id** — corp `cognito_id` and auth `cognito_id` are each validated against the **live Cognito sub** (Cognito = truth), plus a cheap auth-vs-corp `cognito_id` proxy. **Short code** + **company code** are the identity/match key (shown, not flagged).
- **Scope selector:** `Active only` / `All employees` filters the **corp** base set on `active_status = 'Y'` ('Y'/'N' in both DBs). Auth is always fetched unfiltered (it's a lookup target).
- **Two modes:**
  - **Mobile entered** → single lookup: corp `WHERE mobile_no = X` (corp = truth for mobile), then resolve each match in auth by (short code, company code) and validate against Cognito. A mobile present only in auth returns "no corp employee".
  - **Mobile blank** → bulk scan: fetch corp (scoped) + auth, pair corp→auth, flag a corp employee inconsistent if it is missing in auth **or** name / mobile / `cognito_id` (auth vs corp) differs, take the **first 100** (corp order), then validate each against Cognito.
- **Cognito validation (always, for shown records):** look the user up by the corp mobile (`phone_number = "+91<mobile>"`) to get the live sub, and by each distinct stored sub (`sub = "<cognito_id>"`). Flag `corp.cognito_id` / `auth.cognito_id` that disagree with the live sub (incl. "missing — Cognito has it" and "stale — not in Cognito"); "no Cognito user for corp mobile" when none exists. Note: bulk validates only the selected first-100; a corp employee fully consistent with auth but wrong vs Cognito is caught via single-mobile lookup.
- **Safety:** the auth schema is a validated identifier and table names are fixed constants; values are parameterized; Cognito `ListUsers` filter values are quote-escaped. Cognito calls run in bounded-concurrency batches (6) and a per-record failure is captured on that record, never aborting the scan.
- **CSV export:** the results card has a **Download CSV** button. The CSV is built client-side from the already-loaded result (`lib/comparison-csv.ts`, no extra request); columns put the corp (truth) value first per field, then auth and cognito, plus the deviation flags and status notes. Filename encodes env / scope / mode / mobile / timestamp.

### Employee ↔ Cognito Check (card on the same tab)

A separate card below the corp-driven comparison that scans **every** auth employee against Cognito **and corp** (this one is **auth-driven** — auth `Field_Force_Users` is the base set). For each `Field_Force_Users` row (honoring the Active/All scope on `active_status`) that has a non-empty `cognito_id`, the stored sub is looked up in Cognito (`ListUsers`, `sub = "<cognito_id>"`) and the **mobile number** (auth `mobile_no` vs Cognito `phone_number`, both normalized to the last 10 digits) and **short code** (auth `short_code` vs Cognito `custom:emp_short_code`, trimmed + case-insensitive) are compared. The employee is then also matched to corp `empmaster_hdr` by the **(short code, company code)** pair (single `= ANY` query per chunk on the corp pool, run concurrently with the Cognito batches; no active filter) and its **name**, **mobile** and **cognito_id** are compared against corp too. Read-only.

- **Chunked to survive serverless timeouts:** checking "all employees" can mean thousands of `ListUsers` calls, so `POST /api/auth-comparison/employee-cognito` processes only **200** employees per request (`EMP_COGNITO_CHUNK`, ordered by `id`, `LIMIT/OFFSET`) and returns `nextOffset`; the client (`runEmployeeScan`) loops until `nextOffset` is null, showing live progress ("Checked X of Y…") with a **Stop** button (finishes the in-flight chunk, then halts; results are marked "Stopped early"). A stale in-flight loop is invalidated by a generation counter when env/scope changes.
- **Per chunk:** Cognito lookups run once per **distinct** sub (two auth rows can share a `cognito_id`), in bounded-concurrency batches of 6; a per-sub failure is recorded on the affected rows ("Cognito lookup error"), never aborting the scan. Totals (`totalEmployees`, `totalWithCognitoId`) are recomputed per chunk from cheap `count(*) FILTER` queries.
- **Only mismatches are returned/rendered:** flags are `notFoundInCognito` (stale sub — no Cognito user), `mobileMismatch` / `shortCodeMismatch` (vs Cognito), and `missingInCorp` / `corpNameMismatch` / `corpMobileMismatch` / `corpCognitoIdMismatch` (vs corp; plus a "Multiple corp matches" note when the pair matches >1 corp row); consistent employees are counted but not listed. Results table (`components/employee-cognito-table.tsx`) stacks auth/cognito/corp values per field and shows the Cognito account state (username / status / enabled) for context; **Download CSV** exports the mismatches via `toEmployeeCognitoCsv` — similar columns are kept together, always in **auth / cognito / corp** order per field (short code, name, mobile, cognito id).
- **Employees with no `cognito_id` are excluded** from the scan base (there is nothing to look up); `totalEmployees` vs `totalWithCognitoId` in the summary shows how many were skipped.

### Employee Data Correction (card on the same tab — WRITES on confirm)

The tab's only non-read-only surface (`components/data-correction-card.tsx`, `lib/correction.ts`, routes under `app/api/auth-comparison/correction/`). **Corp-driven and mobile-keyed**: enter a mobile → `POST correction/analyze` fetches the corp employee(s) holding it from `empmaster_hdr` **first** (corp = source of truth for **short code / mobile / name / ucode**; Cognito = truth for **cognito_id**), matches auth by (short code, company code) and resolves the live Cognito user, then renders a per-field corp/auth/cognito comparison (short code, name, mobile, ucode — corp **`uid`** (NOT `u_code`) / auth `ucode` / Cognito `custom:ucode` — and cognito_id) with per-cell deviation flags. Names compare on a canonical form (`normalizeName` in `lib/format.ts`: lowercase + all non-alphanumerics stripped) so encoding damage like a trailing `�` doesn't flag a diff; ucodes are compared case-insensitively and displayed lowercased (Cognito stores them uppercase); Cognito mobiles are displayed without the `+91` prefix (`displayMobile10`). **Stored-sub audit:** every stored cognito_id that differs from the resolved target is looked up in Cognito BY SUB (`resolveStoredSubOwners`) — the panel shows who actually owns it (short code, name, mobile, with a hint to analyze the owner's mobile) or that it is stale, with per-side status chips; a matching-owner-but-different-Cognito-mobile case is called out as "update the phone in Cognito manually" (not clearable). Five corrective actions, each **preview → confirm modal → run** (danger-styled on prod), with every input re-derived server-side from `empmaster_id`:

1. **Create in auth (event replay)** — offered only when the employee is **missing in auth**. `POST correction/replay` reads the whole `employee_<empmaster_id>` stream from corp `public.events` (ordered by timestamp, `eventId` tiebreak) and sends each row **verbatim** (`JSON.stringify` of the `SELECT *` row) to the V1 auth consumer FIFO queue via `sendAuthQueueMessage` (`lib/sqs.ts`), `MessageGroupId = streamId` (mirrors the SDK's SNS publishing), sequential sends for FIFO order — the same mechanism as the proven manual recovery script. Works because the auth consumer only unwraps `body.Message` when `event_type` is absent, and events rows have no `signature` column so signature verification is skipped. Preview lists the events without sending; a live run is **refused if the employee already exists in auth** (re-playing EMPLOYEE_ADD onto an existing user risks duplicates). After a run the card polls the analysis every 3s (up to 10×) until the user appears in auth.
2. **Sync auth with corp** — offered when the employee **exists in auth** but its name / mobile / ucode drifted from corp. One parameterized `UPDATE "Field_Force_Users"` writing only the columns that actually differ (fixed allow-list: `name`, `mobile_no`, `ucode`), values taken from corp (`emp_name`, last-10 `mobile_no`, `uid` lowercased). Uses the SAME tolerant comparisons as the display (`computeAuthSyncChanges` is shared by analyze + apply), so a canonically-equal name (e.g. corp with a trailing `�`) is never "synced" over a clean auth value. Blocked when >1 auth records match the pair. **Cognito attribute drift (name/ucode) is never auto-corrected** — the tool doesn't write to Cognito; a note tells the operator to fix it manually.
3. **Fix cognito_id in corp + auth** — resolves the live Cognito user by the **corp mobile** and requires its `custom:emp_short_code` to equal the **corp short code** (a shared mobile can never pick the wrong account; 0 or >1 candidates block the fix), then `UPDATE public.empmaster_hdr SET cognito_id` (corp pool) and `UPDATE "Field_Force_Users" SET cognito_id` (auth pool) — only the sides that differ. Blocked while the employee is missing in auth (create first, per the intended sequence) or when >1 auth records match the pair. Preview reports the live sub + before values without writing. **Duplicate guard:** the sub is never written if any OTHER `empmaster_hdr` or `Field_Force_Users` row already stores it (`findCorrectionConflicts`, checked at analyze time — blocker chip + disabled button naming the conflicting records — AND hard-refused inside `fixCognitoId` on both preview and run; a prod incident once left one cognito_id on two auth rows).
4. **Release duplicate cognito_id** — offered whenever the analyze post-pass finds the employee's live sub stored on OTHER corp/auth records. The preview modal lists each conflicting record (source table, id, short code, company, name); on confirm their `cognito_id` is set to **NULL** (`UPDATE … WHERE id = ANY(...) AND cognito_id = <sub>` — the sub-equality predicate means a concurrently-corrected row is never clobbered). The analyzed employee is the sub's verified owner (Cognito user resolved by corp mobile + short-code guard) and its own rows are never touched. While duplicates exist the cognito_id fix stays blocked ("release the duplicate first"); after the release the card re-analyzes and the fix becomes available if still needed. Cleared records are left with a NULL cognito_id — correct them via their own mobile afterwards if they should have one.
5. **Clear wrong cognito_id** — offered when NO rightful Cognito user resolves for the employee (mobile lookup empty / short-code mismatch) but a cognito_id IS stored on its corp/auth row(s) and the stored-sub audit confirms it wrong (stale, or owned by a different user). The preview lists each side (source, record id, stored sub, why wrong); on confirm the wrong side(s) are NULLed with an `AND cognito_id = <sub>` predicate. Refused when a live target exists (use the fix instead), when the sub's owner matches the short code (Cognito phone drift → manual), or on any Cognito lookup error (never clear on uncertainty). The "holistic" two-user repair: clear the foreign sub here, then analyze the owner's mobile to fix THEIR records.

Env/IAM: needs `AUTH_{ENV}_SQS_QUEUE_URL` (the V1 auth consumer FIFO queue, e.g. `MVPD-AUTH.fifo`); AWS creds/region reuse `{ENV}_AWS_*`, which must additionally hold `sqs:SendMessage` on that queue. DB writes go through the existing corp service pool and `getAuthPool` — no new DB vars.

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
| `AUTH_PROD_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | Auth DB (V1 auth-backend / Corp DB) production — used only by the 24h OTP Block tab. |
| `AUTH_STAGE_DB_HOST` / `_USER` / `_PASSWORD` / `_NAME` | Auth DB stage. |
| `AUTH_PROD_DB_SCHEMA` / `AUTH_STAGE_DB_SCHEMA` | Optional Postgres schema for the auth tables (default `public`). Set if auth-backend uses a non-public `POSTGRES_SCHEMA` for that env. |
| `PROD_COGNITO_USERPOOL_ID` / `STAGE_COGNITO_USERPOOL_ID` | Field-force Cognito user pool id per env — used by the Auth Details Comparison tab's `ListUsers` lookups. AWS creds/region are reused from `{ENV}_AWS_*` (above); those IAM creds must also have `cognito-idp:ListUsers` on the pool. |
| `AUTH_PROD_SQS_QUEUE_URL` / `AUTH_STAGE_SQS_QUEUE_URL` | V1 auth-backend consumer FIFO queue per env (e.g. `MVPD-AUTH.fifo`) — used by the Employee Data Correction card to replay corp employee events (`SendMessage`). AWS creds/region are reused from `{ENV}_AWS_*`; those IAM creds must also have `sqs:SendMessage` on this queue. |
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
  - `public.events` — **(Event Ops)** joined left for `event_type` only (lookup via `events."eventId" = event_consumer_status.eventid`). **(Counter Events)** read in full per stream: `data` (jsonb), `event_type`, `timestamp`, `"eventId"`, `"eventStreamStreamId"` — never written.
  - `public.batch_event_status` — V2 batch tracking. Reads `id, batch_id, batch_sequence, event_type, event_status, force_status, data, modified_date`. Updates `event_status = 'Success'`, `"force_status" = true` on `clear-batch`.
  - **Counter Events read-only joins (Corp DB):** `company_hdr`, `companydivision_dtl` (dropdowns); `companyproduct_hdr`, `item_divisiondtl`, `companydivision_dtl` (products enrichment); `emp_position_hdr`, `empmaster_hdr` (division employee); `StockistCluster_Lnk`, `StockistCompany_Lnk`, `cluster_hdr` (stockist). Never written.
  - **24h OTP Block (auth DB):** `"Stockists"`, `"Field_Force_Users"`, `"Counter_Company_Lnk"`, `"Delegate_Users"`, `"Admin_Users"` (case-sensitive, schema-qualified). Reads `id, mobile_no, name, otp_retry_count, lockup_date`; updates `otp_retry_count = NULL, lockup_date = NULL` on clear. Separate `getAuthPool(env)` connection.
  - **Auth Details Comparison (read-only):** `public.empmaster_hdr` (corp DB via the `corp` service pool — the **base/driving** set; reads `empmaster_id, emp_shortcode, company_code, emp_name, mobile_no, cognito_id, active_status`) and `"Field_Force_Users"` (auth DB via `getAuthPool` — **looked up** per corp employee; reads `id, short_code, company_code, name, mobile_no, cognito_id, active_status`). Never written by the comparison/scan cards. Corp-driven: joined in Node by the (short code, company code) pair (auth-only rows dropped); not via SQL.
  - **Employee Data Correction (writes on confirm):** additionally reads `uid` (corp — this is where corp's ucode lives, NOT `u_code`) / `ucode` (auth) and corp `public.events` by `"eventStreamStreamId" = 'employee_<empmaster_id>'` (for replay). On confirmed fixes it UPDATEs `public.empmaster_hdr.cognito_id` (corp DB) and `"Field_Force_Users".cognito_id` / `name` / `mobile_no` / `ucode` (auth DB — the last three via the corp-sync action, fixed column allow-list) — single-row, parameterized.
- **Pool config:** `max: 5`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`. One pool per `(env, service, instance)` cached for process lifetime.

## External Integrations

- **AWS SQS** (direct, via `@aws-sdk/client-sqs`). `DeleteMessage` for clear actions and `ChangeMessageVisibility` (5s timeout) for refire actions. Credentials are taken from the env per-target (see "AWS Resources"). Replaces the previous Playground SQS HTTP API hop, which was IP-blocked from Vercel egress.
- **Playground batch scheduler API** — `DELETE {scheduler_name}` with `Authorization: {"apiKey":"…"}` (note the JSON-encoded value). Removes the EventBridge Scheduler that would have re-fired the batch. Still HTTP-based; on error the returned `reason` includes a reproducible curl with the exact URL/headers/body.
- **AWS Cognito** (direct, via `@aws-sdk/client-cognito-identity-provider`) — **read-only** `ListUsers` on the field-force user pool (`{ENV}_COGNITO_USERPOOL_ID`), filtered by `phone_number` or `sub`. Used only by the Auth Details Comparison tab. Credentials/region reuse the per-env `{ENV}_AWS_*` vars; those IAM creds need `cognito-idp:ListUsers`.

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

This service does **not** create new events and does not call any other Medvol backend — side effects are scoped to direct DB writes against the listed tables, direct AWS SQS calls against the V2 consumer queues (plus `SendMessage` of **existing** corp event rows to the V1 auth consumer queue for the Employee Data Correction replay), and HTTP calls to the Playground batch-scheduler API. The Auth Details Comparison tab performs AWS Cognito `ListUsers` lookups but never mutates Cognito — the cognito_id fix writes only to the corp/auth databases.
