import { NextRequest, NextResponse } from "next/server";
import { getSession, setStepUpGrant } from "@/lib/session";
import { completeTwoFactorLogin } from "@/lib/fusionauth";

/**
 * POST /api/two-factor/verify
 * Body: { twoFactorId: string, code: string, action: string }
 *
 * Completes the step-up challenge with the code the user entered. On success it
 * writes the short-lived step-up grant for `action`; the client then re-submits
 * the chat turn, which consumes the grant and lets the sensitive MCP tool run.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { twoFactorId?: unknown; code?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { twoFactorId, code, action } = body;
  if (
    typeof twoFactorId !== "string" ||
    typeof code !== "string" ||
    !code ||
    typeof action !== "string" ||
    !action
  ) {
    return NextResponse.json(
      { verified: false, error: "Missing twoFactorId, code, or action." },
      { status: 400 }
    );
  }

  const result = await completeTwoFactorLogin({ twoFactorId, code });
  if (!result.success) {
    return NextResponse.json(
      { verified: false, error: result.error },
      { status: 400 }
    );
  }

  await setStepUpGrant(action);
  return NextResponse.json({ verified: true });
}
