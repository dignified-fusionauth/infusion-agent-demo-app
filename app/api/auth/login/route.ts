import { NextRequest } from "next/server";
import { startOAuthRedirect } from "@/lib/bff";

/**
 * GET /api/auth/login
 *
 * Starts the Authorization Code + PKCE redirect. A `role` query hint (set by the
 * landing page's "Sign in as …" links) selects which default tool scopes the
 * login requests — an employee's login never even asks for tools:payroll.read.
 */
export async function GET(request: NextRequest) {
  return await startOAuthRedirect(request);
}
