import { NextRequest, NextResponse } from "next/server";
import { getSession, consumeStepUpGrant } from "@/lib/session";
import {
  planTurn,
  sandboxCheck,
  callMcpTool,
  formatToolReply,
  requiresStepUp,
  stepUpAction,
  agentMode,
  type TraceStep,
  type PlannedCall,
  type ChatResponse,
} from "@/lib/agent";
import { type ToolName } from "@/lib/scopes";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat  — one agent turn.
 * Body: { message: string, resume?: { tool: ToolName, args } }
 *
 * The orchestration that ties the demo together:
 *   plan → sandbox pre-check → (step-up gate) → MCP call → reply
 * Each phase appends to the authorization trace, which the client accumulates
 * and renders live. On a fresh turn the planner (scripted or Claude) picks the
 * tool; on `resume` the client hands back the tool it already step-up'd for.
 *
 * The trace annotations make the two independent checks visually distinct:
 *   - `sandbox: DENIED (missing …)`  → the agent refused locally, no MCP call
 *   - `mcp: DENIED (missing …)`      → the resource server refused independently
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { message?: unknown; resume?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const trace: TraceStep[] = [];
  const mode = agentMode();

  // 1. Determine the tool call — either resumed after step-up, or freshly planned.
  let call: PlannedCall;
  const resume = body.resume as PlannedCall | undefined;
  if (resume && typeof resume.tool === "string") {
    call = { tool: resume.tool as ToolName, args: resume.args ?? {} };
    trace.push({
      layer: "planner",
      status: "info",
      label: `Resuming ${call.tool}`,
      detail: "Continuing after a completed step-up check",
    });
  } else {
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }
    const plan = await planTurn(message);
    if (!plan.call) {
      trace.push({
        layer: "planner",
        status: "info",
        label: "No tool needed",
        detail: `${mode === "live" ? "Live LLM" : "Scripted"} planner answered directly`,
      });
      const reply: ChatResponse = {
        kind: "reply",
        reply: plan.assistantText ?? "I'm not sure how to help with that.",
        trace,
        mode,
      };
      return NextResponse.json(reply);
    }
    call = plan.call;
    trace.push({
      layer: "planner",
      status: "info",
      label: `Selected ${call.tool}`,
      detail: `${mode === "live" ? "Live LLM" : "Scripted"} planner`,
    });
  }

  // 2. Sandbox pre-check (layer 1) — the agent's own local scope + role check.
  const sandbox = sandboxCheck(call.tool, session.scopes, session.roles);
  if (!sandbox.allowed) {
    if (sandbox.reason === "role_not_permitted") {
      const allowed = (sandbox.allowedRoles ?? []).join(" or ");
      trace.push({
        layer: "sandbox",
        status: "denied",
        label: "sandbox: DENIED (role not permitted)",
        detail:
          `${call.tool} is restricted to ${allowed}. Your token carries ` +
          `${sandbox.requiredScope}, but your role isn't permitted — so the agent ` +
          `refused before attempting any MCP call (defense-in-depth).`,
      });
      const reply: ChatResponse = {
        kind: "reply",
        reply:
          `Your agent can't run \`${call.tool}\` — it's restricted to ${allowed}. ` +
          `Even though your token carries \`${sandbox.requiredScope}\`, your role ` +
          `isn't permitted to use this tool, so it stopped before calling the tool server.`,
        trace,
        mode,
      };
      return NextResponse.json(reply);
    }
    trace.push({
      layer: "sandbox",
      status: "denied",
      label: `sandbox: DENIED (missing ${sandbox.requiredScope})`,
      detail:
        "Your token doesn't carry this scope, so the agent refused before attempting any MCP call.",
    });
    const reply: ChatResponse = {
      kind: "reply",
      reply:
        `Your agent can't run \`${call.tool}\` — your sign-in was never granted ` +
        `\`${sandbox.requiredScope}\`, so it stopped before ever calling the tool server. ` +
        `Sign in with a role that requests that scope (and grant it at the consent screen) to unlock it.`,
      trace,
      mode,
    };
    return NextResponse.json(reply);
  }
  trace.push({
    layer: "sandbox",
    status: "allowed",
    label: `sandbox: ALLOWED (${sandbox.requiredScope})`,
    detail:
      "Token carries the required scope and the role is permitted; proceeding to the MCP server.",
  });

  // 3. Step-up gate for sensitive tools (layer between sandbox and MCP).
  if (requiresStepUp(call.tool)) {
    const action = stepUpAction(call.tool);
    const satisfied = await consumeStepUpGrant(action);
    if (!satisfied) {
      trace.push({
        layer: "stepup",
        status: "required",
        label: "step-up: REQUIRED",
        detail: `${call.tool} is sensitive — a fresh two-factor check is required before it runs.`,
      });
      const pending: ChatResponse = {
        kind: "stepup",
        trace,
        mode,
        pending: {
          tool: call.tool,
          args: call.args,
          action,
          title: `Approve ${call.tool.replace(/_/g, " ")}`,
        },
      };
      return NextResponse.json(pending);
    }
    trace.push({
      layer: "stepup",
      status: "verified",
      label: "step-up: VERIFIED",
      detail: "A fresh two-factor check just completed for this action.",
    });
  }

  // 4. The MCP call (layer 2 — the resource server verifies + re-checks scope).
  const mcp = await callMcpTool(call.tool, call.args, session.accessToken);
  if (!mcp.reached) {
    trace.push({
      layer: "mcp",
      status: "denied",
      label: "mcp: DENIED (unauthenticated)",
      detail:
        mcp.error ??
        "The MCP server rejected the bearer token (401). It never ran the tool.",
    });
  } else if (!mcp.mcpAllowed) {
    trace.push({
      layer: "mcp",
      status: "denied",
      label:
        mcp.deniedReason === "role_not_permitted"
          ? "mcp: DENIED (role not permitted)"
          : `mcp: DENIED (missing ${mcp.missingScope})`,
      detail:
        "The MCP server independently re-checked the token's scopes and role, and refused.",
    });
  } else {
    trace.push({
      layer: "mcp",
      status: "allowed",
      label: "mcp: ALLOWED",
      detail:
        "The MCP server verified the token and its own scope + role check passed.",
    });
    trace.push({
      layer: "result",
      status: "info",
      label: "tool executed",
      detail: `${call.tool} returned a result.`,
    });
  }

  const reply: ChatResponse = {
    kind: "reply",
    reply: formatToolReply(call.tool, mcp),
    trace,
    mode,
  };
  return NextResponse.json(reply);
}
