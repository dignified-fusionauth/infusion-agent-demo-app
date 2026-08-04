import { NextResponse } from "next/server";
import { buildAccountLogoutUrl } from "@/lib/fusionauth";
import { clearSession, getSession } from "@/lib/session";

/**
 * GET /api/auth/logout
 *
 * Clears the local encrypted session cookie, then sends the browser to
 * FusionAuth's /account/logout (which ends the self-service account session and
 * chains into /oauth2/logout — single logout). Reads the session's tenant BEFORE
 * clearing it, because a multi-tenant instance rejects the logout without it.
 */
export async function GET() {
  const session = await getSession();
  await clearSession();
  return NextResponse.redirect(buildAccountLogoutUrl(session?.tenantId));
}
