import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
import { lookupUserByEmail } from "@/lib/fusionauth";
import {
  assignRelation,
  unassignRelation,
  isValidRelation,
  entityLabel,
  ensureFgaBootstrap,
  lastFgaMode,
} from "@/lib/fga";

export const dynamic = "force-dynamic";

/**
 * Admin relationship management — grant or revoke ANY grantable FGA relation on any
 * organization, team, knowledge-base space, or document, for any user.
 *
 * Two different kinds of authorization meet here, on purpose:
 *   - This endpoint is gated by the FusionAuth ADMIN ROLE, read off the verified access
 *     token (coarse, app-level): only an admin may call it at all.
 *   - What it writes are Permify RELATIONS (fine-grained, per-resource): the tuples that
 *     then drive every resource decision in the chat turns.
 * AuthN decides who's an admin; AuthZ relations decide what everyone can reach.
 *
 * POST   { email, entityType, entityId, relation }  -> grant  (write tuple)
 * DELETE { userId, entityType, entityId, relation } -> revoke (delete tuple)
 */

interface Body {
  email?: unknown;
  userId?: unknown;
  entityType?: unknown;
  entityId?: unknown;
  relation?: unknown;
}

/** Shared guard: authenticated + admin role, then a parsed body. */
async function guard(
  request: NextRequest
): Promise<{ error: NextResponse } | { body: Body }> {
  const session = await getSession();
  if (!session) {
    return {
      error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
    };
  }
  if (!isAdmin(session.roles)) {
    return {
      error: NextResponse.json({ error: "Admin role required." }, { status: 403 }),
    };
  }
  try {
    return { body: (await request.json()) as Body };
  } catch {
    return {
      error: NextResponse.json({ error: "Invalid request" }, { status: 400 }),
    };
  }
}

/** Validates the entity + relation pair against the schema's grantable relations. */
function validateTarget(body: Body):
  | { error: NextResponse }
  | { entityType: "organization" | "team" | "kb_space" | "kb_doc"; entityId: string; relation: string } {
  const { entityType, entityId, relation } = body;
  if (
    typeof entityType !== "string" ||
    typeof entityId !== "string" ||
    typeof relation !== "string" ||
    !isValidRelation(entityType, relation)
  ) {
    return {
      error: NextResponse.json(
        { error: "Invalid entity or relation." },
        { status: 400 }
      ),
    };
  }
  if (!entityLabel(entityType, entityId)) {
    return { error: NextResponse.json({ error: "Unknown entity." }, { status: 400 }) };
  }
  return { entityType, entityId, relation };
}

export async function POST(request: NextRequest) {
  const guarded = await guard(request);
  if ("error" in guarded) return guarded.error;
  const target = validateTarget(guarded.body);
  if ("error" in target) return target.error;

  const email = guarded.body.email;
  if (typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  }

  const user = await lookupUserByEmail(email);
  if (!user) {
    return NextResponse.json(
      {
        error:
          "No FusionAuth user with that email — they need an account before relations can be granted.",
      },
      { status: 404 }
    );
  }

  // Bootstrap WITHOUT seeding: granting a relation to a user must never also hand them
  // the demo seed tuples for their role.
  await ensureFgaBootstrap();
  await assignRelation(target.entityType, target.entityId, target.relation, user.id);

  return NextResponse.json({
    ok: true,
    mode: lastFgaMode(),
    member: { userId: user.id, email: user.email, name: user.name },
  });
}

export async function DELETE(request: NextRequest) {
  const guarded = await guard(request);
  if ("error" in guarded) return guarded.error;
  const target = validateTarget(guarded.body);
  if ("error" in target) return target.error;

  const userId = guarded.body.userId;
  if (typeof userId !== "string" || !userId) {
    return NextResponse.json({ error: "Missing user." }, { status: 400 });
  }

  await ensureFgaBootstrap();
  await unassignRelation(target.entityType, target.entityId, target.relation, userId);

  return NextResponse.json({ ok: true, mode: lastFgaMode() });
}
