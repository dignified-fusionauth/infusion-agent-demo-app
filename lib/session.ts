import { cookies } from "next/headers";
import { createHash } from "crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import type { AccessToken } from "@fusionauth/typescript-client";
import { verifyAccessToken, verifyIdToken } from "@/lib/fusionauth";
import { rolesFromClaims } from "@/lib/roles";
import { scopesFromClaims } from "@/lib/scopes";

/**
 * InFusion Agent keeps ONE encrypted, httpOnly session cookie for the signed-in
 * human. The OAuth tokens are sealed inside it with `jose`'s `EncryptJWT`
 * (dir + A256GCM) using a key derived from SESSION_SECRET, so the cookie is
 * opaque to the browser.
 *
 * Encryption stops tampering/reading of the cookie, but identity is only trusted
 * after the access token inside it is verified against FusionAuth's JWKS on every
 * read (see getSession -> verifyAccessToken). An expired or revoked-key token
 * therefore reads as logged-out even though the cookie decrypts fine. Roles AND
 * the granted `scope` claim both come off that same verified access token — the
 * scopes are what the agent's sandbox pre-check reads (lib/agent.ts).
 *
 * The MCP resource server does NOT read this cookie; it verifies the bearer token
 * independently in lib/mcp-auth.ts. That separation is the whole point.
 */

const SESSION_COOKIE = "ia_session";

// The cookie can live as long as the refresh token; the real expiry gate is the
// access token's own JWT `exp`, re-checked on every getSession().
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

export interface Session {
  userId: string;
  email?: string;
  name?: string;
  roles: string[];
  /**
   * The OAuth scopes FusionAuth actually granted, read off the verified access
   * token's `scope` claim. This — not the user's role, and not any UI state — is
   * what the agent sandbox and the MCP server independently gate tool calls on.
   */
  scopes: string[];
  /** The user's FusionAuth tenant, off the access token's `tid` claim. */
  tenantId?: string;
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
}

/** 32-byte AES key derived from SESSION_SECRET (any length secret works). */
function sessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "Missing SESSION_SECRET. Copy .env.local.example to .env.local and fill it in."
    );
  }
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

function cookieBase() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

/**
 * Seals the token response into the encrypted session cookie. Called by the
 * /api/auth/callback route.
 */
export async function setSession(tokens: AccessToken) {
  const payload: SessionPayload = {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
  };

  const jwe = await new EncryptJWT({ ...payload })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .encrypt(sessionKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, jwe, cookieBase());
}

/**
 * Decrypts the session cookie, then verifies the enclosed access token against
 * JWKS. Returns null (logged-out) for a missing/tampered/expired session.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  let payload: SessionPayload;
  try {
    const decrypted = await jwtDecrypt(raw, sessionKey());
    payload = decrypted.payload as unknown as SessionPayload;
  } catch {
    return null; // tampered, wrong key, or the cookie's own exp elapsed
  }
  if (!payload.accessToken) return null;

  let claims;
  try {
    // The access token is the authoritative credential; verify its signature,
    // issuer, and audience before trusting anything (roles + scopes included).
    claims = await verifyAccessToken(payload.accessToken);
  } catch {
    return null; // expired, tampered, or signed with a rotated key
  }

  const roles = rolesFromClaims(claims);
  const scopes = scopesFromClaims(claims);
  const tenantId = typeof claims.tid === "string" ? claims.tid : undefined;

  // Prefer the id_token for display claims (given_name etc. aren't always on the
  // access token); fall back to whatever the access token carries.
  let email = claims.email;
  let name: string | undefined =
    claims.name || claims.given_name || claims.preferred_username;
  if (payload.idToken) {
    try {
      const idClaims = await verifyIdToken(payload.idToken);
      email = idClaims.email ?? email;
      name =
        idClaims.name ||
        idClaims.given_name ||
        idClaims.preferred_username ||
        idClaims.email ||
        name;
    } catch {
      // Ignore a bad id_token; the access token already authenticated us.
    }
  }

  return {
    userId: claims.sub,
    email,
    name: name ?? email,
    roles,
    scopes,
    tenantId,
    accessToken: payload.accessToken,
    idToken: payload.idToken,
    refreshToken: payload.refreshToken,
  };
}

export async function clearSession() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** The cookie whose presence proxy.ts uses as a cheap signed-in check. */
export const sessionCookieName = SESSION_COOKIE;

// ---------------------------------------------------------------------------
// Step-up grant — a short-lived, encrypted marker that a fresh two-factor check
// was just completed for a given action. Written by /api/two-factor/verify (and
// /status when no challenge is required) and consumed once by /api/chat before a
// sensitive MCP tool executes. Encrypted with the same key as the session so the
// browser can't forge it; the jose `exp` enforces freshness.
// ---------------------------------------------------------------------------

const STEPUP_COOKIE = "ia_stepup";
const STEPUP_TTL_SECONDS = 120;

export async function setStepUpGrant(action: string) {
  const jwe = await new EncryptJWT({ action })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${STEPUP_TTL_SECONDS}s`)
    .encrypt(sessionKey());
  const store = await cookies();
  store.set(STEPUP_COOKIE, jwe, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: STEPUP_TTL_SECONDS,
  });
}

/**
 * Consumes the step-up grant: returns true only if a fresh, valid grant for
 * `action` is present, and deletes it so it can't be replayed.
 */
export async function consumeStepUpGrant(action: string): Promise<boolean> {
  const store = await cookies();
  const raw = store.get(STEPUP_COOKIE)?.value;
  if (!raw) return false;
  store.delete(STEPUP_COOKIE);
  try {
    const { payload } = await jwtDecrypt(raw, sessionKey());
    return payload.action === action; // jwtDecrypt already enforced `exp`
  } catch {
    return false;
  }
}
