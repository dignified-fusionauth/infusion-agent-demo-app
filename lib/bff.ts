import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl, fusionAuthConfig } from "@/lib/fusionauth";
import { randomUrlSafeString, codeChallengeFromVerifier } from "@/lib/pkce";
import {
  defaultScopeStringForRole,
  isAgentRole,
  OIDC_BASE_SCOPES,
  SCOPE_CATALOG,
  type AgentRole,
} from "@/lib/scopes";

/**
 * Shared helpers for the /api/auth/* routes: the Authorization Code + PKCE round
 * trip and the open-redirect guards around it. InFusion Agent has no browser SDK,
 * so these routes are the entire human-auth surface.
 *
 * The distinctive bit: `startOAuthRedirect` reads a `role` hint off the query
 * (set by the landing page's "Sign in as employee / manager / it-admin" links)
 * and requests only that role's default scopes. An employee's authorize URL never
 * contains `tools:payroll.read`, so FusionAuth's hosted consent screen never even
 * offers payroll access at that role. Unknown/absent role → OIDC base scopes only.
 */

export const STATE_COOKIE = "ia_oauth_state";
export const VERIFIER_COOKIE = "ia_pkce_verifier";
export const RETURN_COOKIE = "ia_return_to";
/** The role hint, kept so a scope-rejected login can be retried as the same role. */
export const ROLE_COOKIE = "ia_role_hint";

// ---------------------------------------------------------------------------
// Unsupported scopes — learned from FusionAuth, so a catalog change can't lock
// everyone out of the app.
// ---------------------------------------------------------------------------

/**
 * FusionAuth rejects the ENTIRE authorize request if any requested scope isn't defined on
 * the Application — `invalid_scope`, no login for anyone, at any role. That makes the
 * scope catalog (lib/scopes.ts) a hard dependency on instance configuration: add a tool
 * here, and every sign-in breaks until someone adds the matching scope in the admin UI.
 *
 * Rather than fail that way, the app learns. The callback reads which scopes FusionAuth
 * said it didn't know, records them here, and retries the login without them. The tool
 * they unlock is then simply never granted, and the sandbox denies it with the same
 * honest `missing tools:…` message it uses for a scope the user declined — which is a
 * legitimate demo state, not a crash.
 *
 * Instance-scoped rather than user-scoped, because it's a property of the FusionAuth
 * Application, so it lives in the process rather than a cookie. A restart forgets it and
 * re-learns on the next sign-in, at the cost of one extra redirect.
 */
const globalForScopes = globalThis as unknown as {
  __infusionAgentUnsupportedScopes?: Set<string>;
};
function unsupportedScopes(): Set<string> {
  if (!globalForScopes.__infusionAgentUnsupportedScopes) {
    globalForScopes.__infusionAgentUnsupportedScopes = new Set();
  }
  return globalForScopes.__infusionAgentUnsupportedScopes;
}

/** The catalog scopes this instance has told us it doesn't define. For /admin. */
export function unsupportedScopeIds(): string[] {
  return [...unsupportedScopes()];
}

/**
 * Records the scopes named in a FusionAuth `invalid_scope` error description, which reads
 * `Invalid scope. The scopes [a, b] are unknown.` Returns only the names that were newly
 * recorded, so the caller can tell whether a retry would actually change anything (and
 * therefore can't loop).
 *
 * Deliberately ignores anything outside our own catalog: an OIDC base scope such as
 * `openid` is never dropped, whatever the error says. Failing to log in is better than
 * silently logging in without the scopes the session's identity depends on.
 */
export function noteUnsupportedScopes(errorDescription: string | null): string[] {
  if (!errorDescription) return [];
  const named = errorDescription.match(/\[([^\]]+)\]/);
  if (!named) return [];

  const catalog = new Set(SCOPE_CATALOG.map((s) => s.id));
  const store = unsupportedScopes();
  const recorded: string[] = [];
  for (const raw of named[1].split(",")) {
    const name = raw.trim();
    if (!name || !catalog.has(name) || store.has(name)) continue;
    store.add(name);
    recorded.push(name);
  }
  return recorded;
}

const TEMP_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 10, // 10 minutes
};

function appOrigin() {
  return new URL(fusionAuthConfig.appBaseUrl).origin;
}

/**
 * Reduces a caller-supplied return target to a safe SAME-ORIGIN relative path,
 * so /api/auth/login can't be turned into an open redirect.
 */
export function safeReturnTo(raw: string | null): string {
  const fallback = "/chat";
  if (!raw) return fallback;
  try {
    const url = new URL(raw, fusionAuthConfig.appBaseUrl);
    if (url.origin !== appOrigin()) return fallback;
    return `${url.pathname}${url.search}` || fallback;
  } catch {
    return fallback;
  }
}

/**
 * The scope string a login requests for the given (possibly absent) role hint, minus any
 * scope this instance has already told us it doesn't define.
 */
export function scopeStringForRoleHint(role: string | null): string {
  const requested = isAgentRole(role)
    ? defaultScopeStringForRole(role as AgentRole).split(" ")
    // No / unknown role → only the OIDC base scopes; no tool scopes requested.
    : [...OIDC_BASE_SCOPES];

  const unsupported = unsupportedScopes();
  return requested.filter((s) => !unsupported.has(s)).join(" ");
}

/**
 * Starts the Authorization Code + PKCE redirect. Maps the `role` hint to the
 * scope string, stashes state/verifier/return in short-lived cookies for the
 * callback to validate, and redirects to FusionAuth's hosted login.
 */
export async function startOAuthRedirect(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const state = randomUrlSafeString(16);
  const codeVerifier = randomUrlSafeString(32);
  const codeChallenge = codeChallengeFromVerifier(codeVerifier);
  const returnTo = safeReturnTo(q.get("redirect_uri"));
  const scope = scopeStringForRoleHint(q.get("role"));

  const authorizeUrl = buildAuthorizeUrl({ state, codeChallenge, scope });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, TEMP_COOKIE_OPTS);
  response.cookies.set(VERIFIER_COOKIE, codeVerifier, TEMP_COOKIE_OPTS);
  response.cookies.set(RETURN_COOKIE, returnTo, TEMP_COOKIE_OPTS);
  response.cookies.set(ROLE_COOKIE, q.get("role") ?? "", TEMP_COOKIE_OPTS);
  return response;
}
