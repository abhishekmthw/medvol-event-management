import {
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  CognitoIdentityProviderServiceException,
  ListUsersCommand,
  type AdminGetUserCommandOutput,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import type { CognitoUserInfo, Environment } from "./types";

/**
 * Cognito access for the "Auth Details Comparison" tab. Looks field-force
 * users up by mobile number and by cognito id (sub) so the stored `cognito_id`
 * in the auth/corp DBs can be cross-checked against the live Cognito identity.
 * Mirrors the per-env client/credential pattern in `lib/sqs.ts`: credentials
 * and region come from the existing `{ENV}_AWS_*` vars (shared with the SQS
 * actions); only the user-pool id is Cognito-specific
 * (`{ENV}_COGNITO_USERPOOL_ID`).
 *
 * Reads: `lookupByMobile` / `lookupBySub` (`ListUsers`, attribute filters) and
 * `lookupByReservedMobile` (`AdminGetUser`) — the last one is the only read
 * that can see which account a mobile is RESERVED for as a sign-in identifier,
 * which is a different question from which account carries it as an attribute.
 * See its doc comment; the difference is why a number can be unusable while
 * appearing free in every search.
 *
 * Writes: `updateUserPhone` (AdminUpdateUserAttributes: phone_number +
 * phone_number_verified) and `releaseUserPhone` (randomize → update → disable,
 * then verify), both mirroring auth-backend's own release sequence.
 *
 * IAM needs `cognito-idp:ListUsers`, `AdminGetUser`,
 * `AdminUpdateUserAttributes` and `AdminDisableUser`.
 */

const DEFAULT_REGION = "ap-south-1";

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function requireEnv(name: string): string {
  const v = readEnv(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

type CognitoConfig = {
  userPoolId: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  cacheKey: string;
};

function resolveConfig(environment: Environment): CognitoConfig {
  const envUpper = environment.toUpperCase();
  return {
    userPoolId: requireEnv(`${envUpper}_COGNITO_USERPOOL_ID`),
    region: readEnv(`${envUpper}_AWS_REGION`) ?? DEFAULT_REGION,
    credentials: {
      accessKeyId: requireEnv(`${envUpper}_AWS_ACCESS_KEY_ID`),
      secretAccessKey: requireEnv(`${envUpper}_AWS_SECRET_ACCESS_KEY`),
    },
    cacheKey: `cognito:${environment}`,
  };
}

const clientCache = new Map<string, CognitoIdentityProviderClient>();

function getClient(cfg: CognitoConfig): CognitoIdentityProviderClient {
  const cached = clientCache.get(cfg.cacheKey);
  if (cached) return cached;
  const client = new CognitoIdentityProviderClient({
    region: cfg.region,
    credentials: cfg.credentials,
  });
  clientCache.set(cfg.cacheKey, client);
  return client;
}

function parseUser(u: UserType | AdminGetUserCommandOutput): CognitoUserInfo {
  // ListUsers returns `Attributes`; AdminGetUser returns the same list as
  // `UserAttributes` — otherwise the two shapes carry identical fields.
  const attrList =
    "Attributes" in u && u.Attributes
      ? u.Attributes
      : ((u as AdminGetUserCommandOutput).UserAttributes ?? []);
  const attrs = new Map(attrList.map((a) => [a.Name ?? "", a.Value ?? ""]));
  return {
    sub: attrs.get("sub") || null,
    name: attrs.get("name") || null,
    phone_number: attrs.get("phone_number") || null,
    emp_short_code: attrs.get("custom:emp_short_code") || null,
    ucode: attrs.get("custom:ucode") || null,
    username: u.Username ?? null,
    status: u.UserStatus ?? null,
    enabled: u.Enabled ?? null,
  };
}

/**
 * ListUsers filter values are wrapped in double quotes; escape any embedded
 * quote/backslash. Inputs here are E.164 phone numbers and Cognito subs, so this
 * is defensive — they never legitimately contain quotes.
 */
function escapeFilterValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Field-force users whose `phone_number` equals `+91<mobile10>`. */
export async function lookupByMobile(
  environment: Environment,
  mobile10: string,
): Promise<CognitoUserInfo[]> {
  const cfg = resolveConfig(environment);
  const client = getClient(cfg);
  const phone = `+91${mobile10}`;
  const res = await client.send(
    new ListUsersCommand({
      UserPoolId: cfg.userPoolId,
      Filter: `phone_number = "${escapeFilterValue(phone)}"`,
      Limit: 20,
    }),
  );
  return (res.Users ?? []).map(parseUser);
}

/** Field-force users whose `sub` equals the given stored cognito id. */
export async function lookupBySub(
  environment: Environment,
  sub: string,
): Promise<CognitoUserInfo[]> {
  const cfg = resolveConfig(environment);
  const client = getClient(cfg);
  const res = await client.send(
    new ListUsersCommand({
      UserPoolId: cfg.userPoolId,
      Filter: `sub = "${escapeFilterValue(sub)}"`,
      Limit: 20,
    }),
  );
  return (res.Users ?? []).map(parseUser);
}

/**
 * The user this mobile is RESERVED for as a sign-in identifier — which is not
 * the same question `lookupByMobile` answers.
 *
 * The pool is configured `UsernameAttributes: ['phone_number']`, so the number
 * supplied at sign-up becomes the account's sign-in identifier and is held in
 * an internal index; `Username` itself is an opaque UUID. `ListUsers` can only
 * filter on the `phone_number` ATTRIBUTE, so once that attribute is rewritten
 * (e.g. by auth-backend's randomize-then-disable release) the account becomes
 * invisible to `lookupByMobile` while STILL reserving the number — every
 * `SignUp`/`AdminCreateUser` for it fails with `UsernameExistsException` and no
 * attribute search explains why.
 *
 * `AdminGetUser` resolves that internal index, so this is the only read that
 * can see a reserved holder. Returns `null` when the number is genuinely free.
 */
export async function lookupByReservedMobile(
  environment: Environment,
  mobile10: string,
): Promise<CognitoUserInfo | null> {
  const cfg = resolveConfig(environment);
  const client = getClient(cfg);
  try {
    const res = await client.send(
      new AdminGetUserCommand({
        UserPoolId: cfg.userPoolId,
        Username: `+91${mobile10}`,
      }),
    );
    return parseUser(res);
  } catch (err) {
    if (err instanceof Error && err.name === "UserNotFoundException") return null;
    throw err;
  }
}

/**
 * The placeholder number auth-backend parks on an account that must give up
 * its real mobile — a literal port of `generateRandomPhoneNumber` in
 * `auth-backend/src/utils/aws.ts`, deliberately keeping the same `1` + 9-digit
 * shape so ops recognise a released account on sight.
 */
export function generateRandomPhoneNumber(): string {
  const length = 9;
  const numericPart = Math.floor(Math.random() * Math.pow(10, length))
    .toString()
    .padStart(length, "0");
  return `1${numericPart}`;
}

/** `AdminDisableUser` — mirrors auth-backend's `disableCognitoUser`. */
export async function disableUser(
  environment: Environment,
  username: string,
): Promise<void> {
  const cfg = resolveConfig(environment);
  const client = getClient(cfg);
  await client.send(
    new AdminDisableUserCommand({
      UserPoolId: cfg.userPoolId,
      Username: username,
    }),
  );
}

export type PhoneReleaseOutcome = {
  /** The placeholder parked on the account. */
  placeholder: string;
  /** Whether `AdminDisableUser` succeeded. */
  disabled: boolean;
  /**
   * Whether the number is actually free afterwards, re-probed with
   * `lookupByReservedMobile`. FALSE means the release did not take and the
   * number is still reserved — never report success on this.
   */
  released: boolean;
  /** The account still holding the number when `released` is false. */
  stillHeldBy: CognitoUserInfo | null;
};

/**
 * Release the mobile a Cognito account currently holds, the same way
 * auth-backend does it (`employeeEvents.ts` deactivate / replace-add branches):
 * park a random placeholder on `phone_number`, then disable the account.
 *
 * Two deliberate differences from auth-backend's version, which is what let a
 * silently half-applied release go unnoticed in production:
 *   1. every call is awaited (auth-backend's `updateCognitoUserPhoneNumber`
 *      fires `.then()` and returns `true` regardless of the outcome);
 *   2. it re-probes the number afterwards and REPORTS whether it actually
 *      became free, instead of assuming it did.
 */
export async function releaseUserPhone(
  environment: Environment,
  username: string,
  mobile10: string,
): Promise<PhoneReleaseOutcome> {
  const placeholder = generateRandomPhoneNumber();
  await updateUserPhone(environment, username, placeholder);

  let disabled = false;
  try {
    await disableUser(environment, username);
    disabled = true;
  } catch (err) {
    // The number moving off the account is what frees it; a failed disable is
    // reported, not fatal.
    console.error("releaseUserPhone: disable failed", describeCognitoError(err));
  }

  const stillHeldBy = await lookupByReservedMobile(environment, mobile10);
  return {
    placeholder,
    disabled,
    released: stillHeldBy === null,
    stillHeldBy,
  };
}

/**
 * The app's only Cognito write path: `AdminUpdateUserAttributes` with an
 * explicit attribute map. Called exclusively by the Data Correction card's
 * confirmed actions (phone fix / attribute sync) — never by any read flow.
 */
export async function updateUserAttributes(
  environment: Environment,
  username: string,
  attributes: Record<string, string>,
): Promise<void> {
  const cfg = resolveConfig(environment);
  const client = getClient(cfg);
  await client.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: cfg.userPoolId,
      Username: username,
      UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({
        Name,
        Value,
      })),
    }),
  );
}

/**
 * Set a Cognito user's phone_number to `+91<mobile10>` and mark it verified —
 * the attribute set auth-backend's `updateCognitoUserPhoneNumber` writes
 * (unverified phones can't be used for SMS sign-in).
 *
 * NOTE the value is lowercase `"true"`, which is what Cognito's boolean
 * attribute parser expects. auth-backend and the previous version of this
 * function both wrote `"True"`; a value Cognito does not parse leaves the phone
 * effectively unverified, which is the leading suspect for the releases that
 * left their old number reserved. Do not "tidy" this back to `"True"`.
 */
export function updateUserPhone(
  environment: Environment,
  username: string,
  mobile10: string,
): Promise<void> {
  return updateUserAttributes(environment, username, {
    phone_number: `+91${mobile10}`,
    phone_number_verified: "true",
  });
}

/**
 * Human-readable, single-line description of a Cognito failure. `op` names the
 * failing call; it defaults to `ListUsers` so existing read-path messages are
 * unchanged.
 */
export function describeCognitoError(err: unknown, op = "ListUsers"): string {
  const name = err instanceof Error ? err.name : "Error";
  const msg = err instanceof Error ? err.message : String(err);
  const parts = [`Cognito ${op} failed (${name}): ${msg}`];
  if (err instanceof CognitoIdentityProviderServiceException) {
    const meta = err.$metadata;
    if (meta?.httpStatusCode != null) parts.push(`httpStatus=${meta.httpStatusCode}`);
    if (meta?.requestId) parts.push(`requestId=${meta.requestId}`);
  }
  return parts.join(" ");
}
