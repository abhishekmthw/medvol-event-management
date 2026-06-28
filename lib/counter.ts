import { getPool } from "./db";
import type {
  CounterColumn,
  CounterFilters,
  CounterOption,
  CounterQueryResult,
  CounterView,
  Target,
} from "./types";

/**
 * Counter Events — read-only browser over `public.events` (the V2 event store)
 * in the Corp DB. Reconstructs the data shape of the counter master change
 * events (division / products / stockist) per stream, optionally narrowed by
 * company / division / location / date range.
 *
 * Everything here is READ-ONLY and Corp-only. All queries are parameterized.
 * The mandatory stream-id predicate is the only selective filter — keep it.
 */

/** Hard cap on rows returned to the UI (guards against runaway result sets / statement_timeout). */
const ROW_LIMIT = 1000;

/** Corp target for a given environment — Counter Events is Corp-only, shared instance. */
function corpTarget(environment: Target["environment"]): Target {
  return { environment, service: "corp", instance: null };
}

/**
 * Column definitions per view. The `key` matches the SELECT alias in the SQL
 * below and the row key returned by `pg`; the UI renders headers/order from this.
 */
export const COUNTER_COLUMNS: Record<CounterView, CounterColumn[]> = {
  products: [
    { key: "streamid", label: "Stream ID" },
    { key: "item_code", label: "Item Code" },
    { key: "product_name", label: "Product Name" },
    { key: "schemeqty_cp", label: "Scheme Qty" },
    { key: "quantity_cp", label: "Free Qty" },
    { key: "min_order_qty", label: "Min Order Qty" },
    { key: "max_order_qty", label: "Max Order Qty" },
    { key: "period_limit", label: "Period Limit" },
    { key: "reference_number", label: "Reference No." },
    { key: "location_code", label: "Location Code" },
    { key: "company_code", label: "Company Code" },
    { key: "company_divisioncode", label: "Division Code" },
    { key: "division_name", label: "Division Name" },
    { key: "event_type", label: "Event Type" },
    { key: "timestamp", label: "Timestamp", isDate: true },
  ],
  division: [
    { key: "uin_code", label: "UIN Code" },
    { key: "location_name", label: "Location Name" },
    { key: "ewaybill_applicable", label: "Ewaybill" },
    { key: "is_enabledmanualorder", label: "Manual Order" },
    { key: "associated_counter_code", label: "Assoc. Counter" },
    { key: "associated_location_code", label: "Assoc. Location" },
    { key: "company_division_name", label: "Division Name" },
    { key: "company_division_code", label: "Division Code" },
    { key: "emp_name", label: "Employee" },
    { key: "event_type", label: "Event Type" },
    { key: "timestamp", label: "Timestamp", isDate: true },
  ],
  stockist: [
    { key: "cluster_name", label: "Cluster Name" },
    { key: "event_id", label: "Event ID" },
    { key: "is_default", label: "Is Default" },
    { key: "comp_stockist_code", label: "Stockist Code" },
    { key: "active_status", label: "Active" },
    { key: "timestamp", label: "Timestamp", isDate: true },
  ],
};

/** Builds and tracks positional params for a query. $1 is reserved for streamIds. */
type ParamAdder = (value: unknown) => string;

/** Common optional predicates shared across all three views (operate on alias `e`). */
function commonPredicates(filters: CounterFilters, add: ParamAdder): string[] {
  const where: string[] = [];
  if (filters.companyCode) {
    where.push(`e.data->>'company_code' = ${add(filters.companyCode)}`);
  }
  if (filters.locationCode) {
    where.push(`e.data->>'location_code' = ${add(filters.locationCode)}`);
  }
  if (filters.fromDate) {
    where.push(`e.timestamp >= ${add(filters.fromDate)}::date`);
  }
  if (filters.toDate) {
    where.push(`e.timestamp < (${add(filters.toDate)}::date + interval '1 day')`);
  }
  return where;
}

/**
 * Counter Products. Restructured from the user's "query 2": the master-table
 * joins (companyproduct_hdr → item_divisiondtl → companydivision_dtl) run ONCE
 * PER EVENT inside the CTE, and the per-slab `jsonb_array_elements` unnest runs
 * last — so the join chain is not recomputed for every slab row. This yields
 * query 2's exact field set at roughly query 1's cost.
 *
 * Note: an item mapped to multiple divisions multiplies output rows (one per
 * slab × division) — expected when filtering by a division.
 */
function buildProductsSql(filters: CounterFilters, add: ParamAdder): string {
  const where: string[] = [
    `e."eventStreamStreamId" = ANY($1::text[])`,
    `e.event_type LIKE '%COUNTER_PRODUCT%'`,
    ...commonPredicates(filters, add),
  ];
  if (filters.divisionCode) {
    where.push(`idd.company_divisioncode = ${add(filters.divisionCode)}::integer`);
  }
  return `
    WITH ev AS (
      SELECT e."eventStreamStreamId" AS streamid, e.data, e.event_type, e.timestamp,
             idd.company_divisioncode, cdd.division_name
      FROM public.events e
      LEFT JOIN public.companyproduct_hdr cph ON cph.item_code = e.data->>'item_code'
      LEFT JOIN public.item_divisiondtl idd   ON idd.item_code = cph.company_productcode
      LEFT JOIN public.companydivision_dtl cdd ON cdd.company_divisioncode = idd.company_divisioncode
      WHERE ${where.join("\n        AND ")}
    )
    SELECT ev.streamid,
           ev.data->>'item_code' AS item_code,
           ev.data->>'product_name' AS product_name,
           cps->>'schemeqty_cp' AS schemeqty_cp,
           cps->>'quantity_cp' AS quantity_cp,
           cps->>'min_order_qty' AS min_order_qty,
           cps->>'max_order_qty' AS max_order_qty,
           ev.data->>'periodlimit' AS period_limit,
           ev.data->>'reference_number' AS reference_number,
           ev.data->>'location_code' AS location_code,
           ev.data->>'company_code' AS company_code,
           ev.event_type, ev.timestamp,
           ev.company_divisioncode, ev.division_name
    FROM ev
    CROSS JOIN LATERAL jsonb_array_elements(ev.data->'counter_product_slab') AS cps
    ORDER BY ev.streamid, ev.timestamp DESC
    LIMIT ${ROW_LIMIT + 1}
  `;
}

/**
 * Counter Division. Division name AND code come from the `company_division_code`
 * jsonb array element (`cdc`), not a join. Employee name is resolved via the
 * position → empmaster join. One output row per division element of each event.
 */
function buildDivisionSql(filters: CounterFilters, add: ParamAdder): string {
  const where: string[] = [
    `e."eventStreamStreamId" = ANY($1::text[])`,
    `e.event_type LIKE '%COUNTER_DIVISION%'`,
    ...commonPredicates(filters, add),
  ];
  if (filters.divisionCode) {
    // The code key inside each array element is `company_division_code` (text-compared).
    where.push(`cdc->>'company_division_code' = ${add(filters.divisionCode)}`);
  }
  return `
    SELECT e.data->>'uin_code' AS uin_code,
           e.data->>'location_name' AS location_name,
           e.data->>'ewaybill_applicable' AS ewaybill_applicable,
           e.data->>'is_enabledmanualorder' AS is_enabledmanualorder,
           e.data->>'Associated_Counter_Code' AS associated_counter_code,
           e.data->>'Associated_Location_Code' AS associated_location_code,
           cdc->>'company_division_name' AS company_division_name,
           cdc->>'company_division_code' AS company_division_code,
           em.emp_name AS emp_name,
           e.event_type, e.timestamp
    FROM public.events e
    CROSS JOIN LATERAL jsonb_array_elements(e.data->'company_division_code') AS cdc
    LEFT JOIN public.emp_position_hdr eph ON eph.position_code_name = e.data->>'position_code_name'
    LEFT JOIN public.empmaster_hdr em     ON em.empmaster_id = eph."empMasterHdrEmpmasterId"
    WHERE ${where.join("\n      AND ")}
    ORDER BY e.timestamp DESC
    LIMIT ${ROW_LIMIT + 1}
  `;
}

/**
 * Counter Stockist. No division concept. The `::integer` casts on jsonb values
 * are regex-guarded so a single non-numeric value can't abort the whole query.
 */
function buildStockistSql(filters: CounterFilters, add: ParamAdder): string {
  const where: string[] = [
    `e."eventStreamStreamId" = ANY($1::text[])`,
    `e.event_type LIKE '%COUNTER_STOCKIST%'`,
    ...commonPredicates(filters, add),
  ];
  return `
    SELECT ch.cluster_name AS cluster_name,
           e."eventId" AS event_id,
           e.data->>'is_default' AS is_default,
           sc."compStockistCode" AS comp_stockist_code,
           e.timestamp AS timestamp,
           e.data->>'active_status' AS active_status
    FROM public.events e
    LEFT JOIN public."StockistCluster_Lnk" scl
      ON scl.id = CASE WHEN e.data->>'stockist_cluster' ~ '^[0-9]+$'
                       THEN (e.data->>'stockist_cluster')::integer END
    LEFT JOIN public."StockistCompany_Lnk" sc ON sc.id = scl."StockistCompany_Lnk_Id"
    LEFT JOIN public.cluster_hdr ch
      ON ch.cluster_code = CASE WHEN e.data->>'cluster_code' ~ '^[0-9]+$'
                                THEN (e.data->>'cluster_code')::integer END
    WHERE ${where.join("\n      AND ")}
    ORDER BY e.timestamp DESC
    LIMIT ${ROW_LIMIT + 1}
  `;
}

const SQL_BUILDERS: Record<
  CounterView,
  (filters: CounterFilters, add: ParamAdder) => string
> = {
  products: buildProductsSql,
  division: buildDivisionSql,
  stockist: buildStockistSql,
};

/** Runs the selected counter view's query against the Corp DB for the target env. */
export async function queryCounterEvents(
  target: Target,
  view: CounterView,
  filters: CounterFilters,
): Promise<CounterQueryResult> {
  const columns = COUNTER_COLUMNS[view];
  if (!filters.streamIds.length) {
    return {
      ok: false,
      columns,
      rows: [],
      count: 0,
      truncated: false,
      message: "At least one stream ID is required.",
    };
  }

  const pool = getPool(target);
  const params: unknown[] = [filters.streamIds];
  const add: ParamAdder = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const sql = SQL_BUILDERS[view](filters, add);
  const { rows } = await pool.query(sql, params);

  const truncated = rows.length > ROW_LIMIT;
  const out = (truncated ? rows.slice(0, ROW_LIMIT) : rows) as Record<
    string,
    unknown
  >[];

  return {
    ok: true,
    columns,
    rows: out,
    count: out.length,
    truncated,
    message: out.length
      ? `Found ${out.length}${truncated ? "+" : ""} row${out.length === 1 ? "" : "s"}.`
      : "No matching rows for the supplied stream ID(s).",
  };
}

/** Active companies for the company dropdown (name shown, numeric `code` submitted). */
export async function fetchCompanies(
  environment: Target["environment"],
): Promise<CounterOption[]> {
  const pool = getPool(corpTarget(environment));
  const { rows } = await pool.query(
    `SELECT code, company_name
     FROM public.company_hdr
     WHERE active_status = true
     ORDER BY company_name`,
  );
  return (rows as { code: number | string; company_name: string }[]).map((r) => ({
    code: String(r.code),
    name: r.company_name,
  }));
}

/** Divisions for the cascaded division dropdown, scoped to the selected company. */
export async function fetchDivisions(
  environment: Target["environment"],
  companyCode: string,
): Promise<CounterOption[]> {
  const pool = getPool(corpTarget(environment));
  const { rows } = await pool.query(
    `SELECT company_divisioncode, division_name
     FROM public.companydivision_dtl
     WHERE company_code = $1::integer
     ORDER BY division_name`,
    [companyCode],
  );
  return (
    rows as { company_divisioncode: number | string; division_name: string }[]
  ).map((r) => ({
    code: String(r.company_divisioncode),
    name: r.division_name,
  }));
}
