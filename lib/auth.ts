import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "em_session";
const ALG = "HS256";
const ISSUER = "event-management";
const AUDIENCE = "event-management-ui";

function secretKey(): Uint8Array {
  const raw = process.env.AUTH_JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "AUTH_JWT_SECRET env var must be set and at least 32 characters long.",
    );
  }
  return new TextEncoder().encode(raw);
}

export const SESSION_TTL_SECONDS = 60 * 60 * 24;

export async function createSessionToken(
  subject: string,
  ttlSeconds = SESSION_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub) throw new Error("Missing subject");
  return payload.sub;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function verifyStaticCredentials(
  username: string,
  password: string,
): boolean {
  const expectedUser = process.env.AUTH_USERNAME;
  const expectedPass = process.env.AUTH_PASSWORD;
  if (!expectedUser || !expectedPass) {
    throw new Error(
      "AUTH_USERNAME and AUTH_PASSWORD must be configured on the server.",
    );
  }
  return (
    timingSafeEqual(username, expectedUser) &&
    timingSafeEqual(password, expectedPass)
  );
}
