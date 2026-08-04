import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl, fusionAuthConfig } from "@/lib/fusionauth";
import { randomUrlSafeString, codeChallengeFromVerifier } from "@/lib/pkce";
import {
  defaultScopeStringForRole,
  isAgentRole,
  OIDC_BASE_SCOPES,
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

/** The scope string a login requests for the given (possibly absent) role hint. */
export function scopeStringForRoleHint(role: string | null): string {
  if (isAgentRole(role)) {
    return defaultScopeStringForRole(role as AgentRole);
  }
  // No / unknown role → only the OIDC base scopes; no tool scopes requested.
  return OIDC_BASE_SCOPES.join(" ");
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
  return response;
}
