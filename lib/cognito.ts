import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  CognitoIdentityProviderServiceException,
  ListUsersCommand,
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
 * Reads are `ListUsers` only. The single write is `updateUserPhone`
 * (AdminUpdateUserAttributes: phone_number + phone_number_verified) used by
 * the Data Correction card's confirmed "Update Cognito mobile from corp"
 * action — it mirrors auth-backend's own `updateCognitoUserPhoneNumber`.
 * The IAM credentials need `cognito-idp:AdminUpdateUserAttributes` for it.
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

function parseUser(u: UserType): CognitoUserInfo {
  const attrs = new Map(
    (u.Attributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]),
  );
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
 * the exact attribute set auth-backend's `updateCognitoUserPhoneNumber` writes
 * (unverified phones can't be used for SMS sign-in).
 */
export function updateUserPhone(
  environment: Environment,
  username: string,
  mobile10: string,
): Promise<void> {
  return updateUserAttributes(environment, username, {
    phone_number: `+91${mobile10}`,
    phone_number_verified: "True",
  });
}

/** Human-readable, single-line description of a Cognito failure. */
export function describeCognitoError(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const msg = err instanceof Error ? err.message : String(err);
  const parts = [`Cognito ListUsers failed (${name}): ${msg}`];
  if (err instanceof CognitoIdentityProviderServiceException) {
    const meta = err.$metadata;
    if (meta?.httpStatusCode != null) parts.push(`httpStatus=${meta.httpStatusCode}`);
    if (meta?.requestId) parts.push(`requestId=${meta.requestId}`);
  }
  return parts.join(" ");
}
