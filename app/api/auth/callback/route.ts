import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCodeForTokens, verifyIdToken } from "@/lib/fusionauth";
import { setSession } from "@/lib/session";
import {
  STATE_COOKIE,
  VERIFIER_COOKIE,
  RETURN_COOKIE,
  ROLE_COOKIE,
  noteUnsupportedScopes,
} from "@/lib/bff";

/**
 * GET /api/auth/callback
 *
 * FusionAuth redirects here after the employee authenticates and grants (or
 * declines) the requested tool scopes on the hosted consent screen. We validate
 * `state`, exchange the code for tokens (PKCE), verify the id_token against JWKS,
 * seal the tokens into the encrypted session cookie, then return the browser to
 * the path it started from.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const error = searchParams.get("error");
  if (error) {
    // `invalid_scope` means this Application doesn't define one of the scopes our catalog
    // asked for, and FusionAuth refuses the whole authorize call over it — so nobody can
    // log in at any role until it's added. Learn which one, drop it, and retry once.
    // `noteUnsupportedScopes` returns only NEWLY recorded names, so a scope we've already
    // dropped can't trigger a second retry: no loop.
    if (error === "invalid_scope") {
      const dropped = noteUnsupportedScopes(searchParams.get("error_description"));
      if (dropped.length > 0) {
        console.warn(
          `[auth] This FusionAuth Application doesn't define ${dropped.join(", ")}. ` +
            `Retrying the login without it — the tool it unlocks will be denied at the ` +
            `sandbox until you add the scope (FusionAuth → Applications → OAuth → Scopes).`
        );
        const retry = new URL("/api/auth/login", request.url);
        const role = request.cookies.get(ROLE_COOKIE)?.value;
        if (role) retry.searchParams.set("role", role);
        retry.searchParams.set(
          "redirect_uri",
          request.cookies.get(RETURN_COOKIE)?.value || "/chat"
        );
        return NextResponse.redirect(retry);
      }
    }
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(error)}`, request.url)
    );
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  const codeVerifier = request.cookies.get(VERIFIER_COOKIE)?.value;
  const returnTo = request.cookies.get(RETURN_COOKIE)?.value || "/chat";

  if (
    !code ||
    !state ||
    !expectedState ||
    state !== expectedState ||
    !codeVerifier
  ) {
    return NextResponse.redirect(new URL("/?error=invalid_state", request.url));
  }

  try {
    const tokens = await exchangeCodeForTokens(code, codeVerifier);
    // Fail fast if the id_token doesn't verify — don't trust unchecked claims.
    if (tokens.id_token) {
      await verifyIdToken(tokens.id_token);
    }
    await setSession(tokens);
  } catch {
    return NextResponse.redirect(
      new URL("/?error=exchange_failed", request.url)
    );
  }

  const store = await cookies();
  store.delete(STATE_COOKIE);
  store.delete(VERIFIER_COOKIE);
  store.delete(RETURN_COOKIE);
  store.delete(ROLE_COOKIE);

  return NextResponse.redirect(new URL(returnTo, request.url));
}
