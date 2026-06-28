import { authSchema, getAuthPool } from "./db";
import { parseList } from "./events";
import type {
  Environment,
  OtpBlockResult,
  OtpBlockRow,
  OtpUserType,
} from "./types";

/**
 * Where the 24h OTP block lives per user type. All five tables store the block
 * in the same two columns (`otp_retry_count`, `lockup_date`) keyed by
 * `mobile_no`; only the table differs. Names are case-sensitive (TypeORM
 * created them quoted) and are fixed internal constants — never user input.
 */
type UserTypeConfig = {
  table: string;
  /** Whether the table has a `name` column (Counter link table does not). */
  hasName: boolean;
};

const USER_TYPES: Record<OtpUserType, UserTypeConfig> = {
  stockist: { table: "Stockists", hasName: true },
  fieldforce: { table: "Field_Force_Users", hasName: true },
  counter: { table: "Counter_Company_Lnk", hasName: false },
  delegate: { table: "Delegate_Users", hasName: true },
  admin: { table: "Admin_Users", hasName: true },
};

export function isOtpUserType(v: unknown): v is OtpUserType {
  return (
    typeof v === "string" &&
    Object.prototype.hasOwnProperty.call(USER_TYPES, v)
  );
}

function labelFor(userType: OtpUserType): string {
  return userType === "fieldforce" ? "field force" : userType;
}

async function fetchRows(
  environment: Environment,
  userType: OtpUserType,
  mobiles: string[],
): Promise<OtpBlockRow[]> {
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  const cfg = USER_TYPES[userType];
  const nameSel = cfg.hasName ? `"name"` : `NULL AS "name"`;

  // Schema + table are validated/fixed constants; mobiles are parameterized.
  const sql = `
    SELECT
      id::text AS id,
      mobile_no,
      ${nameSel},
      otp_retry_count,
      lockup_date
    FROM "${schema}"."${cfg.table}"
    WHERE mobile_no = ANY($1::text[])
    ORDER BY id`;
  const { rows } = await pool.query(sql, [mobiles]);
  return rows as OtpBlockRow[];
}

export async function clearOtpBlock(
  environment: Environment,
  userType: OtpUserType,
  input: string,
  options: { preview?: boolean } = {},
): Promise<OtpBlockResult> {
  const mobiles = parseList(input);
  if (!mobiles.length) {
    return {
      ok: false,
      message: "Provide at least one mobile number.",
      attempted: 0,
      cleared: 0,
      errors: [],
      rows: [],
    };
  }

  const typeLabel = labelFor(userType);
  const before = await fetchRows(environment, userType, mobiles);
  const matchedMobiles = new Set(before.map((r) => r.mobile_no));
  const notFound = mobiles.filter((m) => !matchedMobiles.has(m));
  const notFoundErrors = notFound.map((m) => ({
    mobile: m,
    reason: `No matching ${typeLabel} found.`,
  }));

  if (options.preview) {
    return {
      ok: true,
      preview: true,
      candidates: before.length,
      message: before.length
        ? `${before.length} ${typeLabel} row${before.length === 1 ? "" : "s"} across ${matchedMobiles.size} mobile number${matchedMobiles.size === 1 ? "" : "s"} will have the 24h OTP block cleared.`
        : `No ${typeLabel} found for the supplied mobile number${mobiles.length === 1 ? "" : "s"}. Nothing would change.`,
      attempted: 0,
      cleared: 0,
      errors: notFoundErrors,
      rows: before,
    };
  }

  let cleared = 0;
  if (before.length) {
    const pool = getAuthPool(environment);
    const schema = authSchema(environment);
    const cfg = USER_TYPES[userType];
    const res = await pool.query(
      `UPDATE "${schema}"."${cfg.table}"
       SET otp_retry_count = NULL, lockup_date = NULL
       WHERE mobile_no = ANY($1::text[])`,
      [mobiles],
    );
    cleared = res.rowCount ?? 0;
  }

  const after = await fetchRows(environment, userType, mobiles);

  return {
    ok: notFoundErrors.length === 0,
    message: before.length
      ? `Cleared the 24h OTP block on ${cleared} ${typeLabel} row${cleared === 1 ? "" : "s"} (${matchedMobiles.size} mobile number${matchedMobiles.size === 1 ? "" : "s"}).${notFound.length ? ` ${notFound.length} mobile number${notFound.length === 1 ? "" : "s"} had no matching ${typeLabel}.` : ""}`
      : `No ${typeLabel} found for the supplied mobile number${mobiles.length === 1 ? "" : "s"}. Nothing changed.`,
    attempted: before.length,
    cleared,
    errors: notFoundErrors,
    rows: after,
  };
}
