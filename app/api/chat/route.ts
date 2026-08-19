import { NextRequest, NextResponse } from "next/server";
import { getSession, consumeStepUpGrant } from "@/lib/session";
import {
  planTurn,
  sandboxCheck,
  fgaPreflight,
  callMcpTool,
  formatToolReply,
  answerFromModelKnowledge,
  looksExternal,
  requiresStepUp,
  stepUpAction,
  agentMode,
  INTERNAL_TOOLS,
  type TraceStep,
  type PlannedCall,
  type ChatResponse,
  type McpCallResult,
} from "@/lib/agent";
import { type ToolName } from "@/lib/scopes";
import { syncUserFga } from "@/lib/fga";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat  — one agent turn.
 * Body: { message: string, resume?: { tool: ToolName, args } }
 *
 * The orchestration that ties the demo together, internal tools FIRST:
 *   route → plan → sandbox (scope + role) → FGA pre-check → step-up → MCP call
 *         → MCP's own scope + role check → MCP's own FGA check → reply
 *
 * Nothing internal served the turn? Then a three-rung ladder, in order:
 *   internal tools → the EXTERNAL tool (public docs, still fully authorized)
 *                  → the model's own knowledge (no tool, no network)
 *
 * Each phase appends to the authorization trace, which the client accumulates and
 * renders live. On a fresh turn the planner (scripted or Claude) picks the tool; on
 * `resume` the client hands back the tool it already step-up'd for.
 *
 * The trace annotations keep the layers visually distinct:
 *   - `sandbox: DENIED (missing …)`   → the agent refused locally on scope/role
 *   - `fga: DENIED (…)`               → relations don't reach the specific resource
 *   - `mcp: DENIED (missing …)`       → the resource server refused independently
 *   - `external: …`                   → no internal tool could serve this at all
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

  // Make sure the FGA schema, the company graph, and this user's demo relations are
  // loaded before any resource-level check runs. Idempotent and memoized per process.
  await syncUserFga(session.userId, session.roles);

  // Narrowed once so the helper below doesn't need non-null assertions.
  const active = session;
  const trace: TraceStep[] = [];
  // Starts as the requested mode; downgraded to "scripted" below if a requested
  // live turn actually degraded to the scripted planner (e.g. no API credits).
  let mode = agentMode();

  /**
   * The external stage — reached only when no internal tool served the turn. Two rungs:
   *
   *  1. The external TOOL (`search_public_docs`), when the prompt is a platform question.
   *     It goes through the full authorization path like any other tool — the sandbox and
   *     the resource server's own independent check — and the employee's token stops at
   *     that boundary. It ships role-gated rather than behind its own scope; lib/scopes.ts
   *     explains the trade-off.
   *  2. The model's own knowledge, which reaches nothing at all.
   *
   * Both are logged under the `external` trace layer, distinctly, so a viewer can see
   * which rung answered.
   */
  async function externalStage(
    message: string,
    opts: { prefix?: string; preloaded?: string } = {}
  ): Promise<NextResponse> {
    const asked = message.trim();

    // Rung 1: the external tool, for a platform question only. Anything else never
    // leaves the network — no third-party call is even attempted.
    if (asked && looksExternal(asked)) {
      const sandbox = sandboxCheck(
        "search_public_docs",
        active.scopes,
        active.roles
      );
      if (!sandbox.allowed) {
        trace.push({
          layer: "sandbox",
          status: "denied",
          label: sandbox.requiredScope
            ? `sandbox: DENIED (missing ${sandbox.requiredScope})`
            : "sandbox: DENIED (role not permitted)",
          detail:
            "This agent isn't allowed to leave the network for documentation. Falling " +
            "back to the model's own knowledge, which reaches nothing at all.",
        });
      } else {
        trace.push({
          layer: "sandbox",
          status: "allowed",
          label: sandbox.requiredScope
            ? `sandbox: ALLOWED (${sandbox.requiredScope})`
            : "sandbox: ALLOWED (role-gated)",
          detail:
            "This role may use the external tool; handing the question to it. The " +
            "employee's token stops at that boundary.",
        });
        const external = await callMcpTool(
          "search_public_docs",
          { question: asked },
          active.accessToken
        );
        if (external.reached && external.mcpAllowed && !external.error) {
          trace.push({
            layer: "mcp",
            status: "allowed",
            label: "mcp: ALLOWED",
            detail:
              "The resource server verified the token and its own scope + role check passed.",
          });
          trace.push({
            layer: "external",
            status: "info",
            label: "external: answered from public docs",
            detail:
              "The tool server called a THIRD-PARTY MCP server for public documentation. " +
              "The employee's access token was not forwarded — a third party can't verify " +
              "it — so nothing user-identifying left the network, and what came back is " +
              "treated as untrusted content: displayed and attributed, never acted on.",
          });
          const reply: ChatResponse = {
            kind: "reply",
            reply: formatToolReply("search_public_docs", external),
            trace,
            mode,
          };
          return NextResponse.json(reply);
        }
        trace.push({
          layer: "external",
          status: "error",
          label: "external tool: UNAVAILABLE",
          detail:
            external.error ??
            "The external documentation server didn't answer; falling back to the model's own knowledge.",
        });
      }
    }

    // Rung 2: the model's own knowledge.
    const answer = opts.preloaded
      ? { text: opts.preloaded }
      : await answerFromModelKnowledge(asked);
    if (answer.text === null) {
      trace.push({
        layer: "external",
        status: "error",
        label: "external: UNAVAILABLE",
        detail: answer.reason,
      });
      const reply: ChatResponse = {
        kind: "reply",
        reply:
          "I couldn't find anything for that in the internal systems, and no external " +
          "knowledge source is available to fall back on.",
        trace,
        mode,
      };
      return NextResponse.json(reply);
    }
    trace.push({
      layer: "external",
      status: "info",
      label: "external: answered from model knowledge",
      detail:
        "No internal tool could serve this, so the agent answered outside the company " +
        "systems — with no access to internal data and no authorization decision to make.",
    });
    const reply: ChatResponse = {
      kind: "reply",
      reply: `${opts.prefix ?? ""}${answer.text}`,
      trace,
      mode,
    };
    return NextResponse.json(reply);
  }

  // 1. Determine the tool call — either resumed after step-up, or freshly planned.
  let call: PlannedCall;
  let message = "";
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
    message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    // The routing step makes the ordering visible: the internal tools are always
    // considered before the model's own knowledge is allowed to answer.
    trace.push({
      layer: "planner",
      status: "info",
      label: "routing: internal-first",
      detail:
        `${INTERNAL_TOOLS.length} internal tools considered before the external tool or ` +
        `the model's own knowledge may answer.`,
    });

    const plan = await planTurn(message);
    // If live mode was requested but the Anthropic call failed, `plan.degraded`
    // tells us the scripted planner actually ran — so report the truth for the
    // rest of the turn (trace labels + the response's `mode`).
    if (plan.degraded) mode = "scripted";
    const plannerName = mode === "live" ? "Live LLM planner" : "Scripted planner";
    const degradedDetail = plan.degraded
      ? ` — live LLM unavailable, fell back to scripted (${plan.degraded.reason})`
      : "";
    if (!plan.call) {
      trace.push({
        layer: "planner",
        status: "info",
        label: "No internal tool applies",
        detail: `${plannerName} found no internal tool that could serve this prompt.`,
      });
      // The live planner already answered from its own knowledge while deciding not to
      // call a tool — reuse that text rather than paying for a second round trip.
      return externalStage(message, { preloaded: plan.assistantText });
    }
    call = plan.call;
    trace.push({
      layer: "planner",
      status: plan.degraded ? "error" : "info",
      label: `Selected ${call.tool}`,
      detail: `${plannerName}${degradedDetail}`,
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
    label: sandbox.requiredScope
      ? `sandbox: ALLOWED (${sandbox.requiredScope})`
      : "sandbox: ALLOWED (role-gated)",
    detail: sandbox.requiredScope
      ? "Token carries the required scope and the role is permitted; proceeding to the MCP server."
      : "This tool carries no dedicated scope, so the role gate is the check; the role is " +
        "permitted, and the MCP server will check it again independently.",
  });

  // 3. FGA resource pre-check (layer 1.5) — for a tool whose args name one resource.
  //    Runs BEFORE the step-up gate so nobody completes 2FA for a record FGA refuses.
  const preflight = await fgaPreflight(call.tool, call.args, session.userId);
  if (preflight.applies) {
    if (!preflight.allowed) {
      trace.push({
        layer: "fga",
        status: "denied",
        label: `fga (pre-check): DENIED (${preflight.entity}#${preflight.permission})`,
        detail:
          `Permify refused this resource for you (${preflight.report?.mode ?? "demo"} check). ` +
          `The scope and role both passed — this is a relationship decision, so the agent ` +
          `stopped before the step-up gate and before any MCP call.`,
      });
      const reply: ChatResponse = {
        kind: "reply",
        reply: `${preflight.message} No two-factor check was needed — the resource decision came first.`,
        trace,
        mode,
      };
      return NextResponse.json(reply);
    }
    trace.push({
      layer: "fga",
      status: "allowed",
      label: `fga (pre-check): ALLOWED (${preflight.entity}#${preflight.permission})`,
      detail:
        `Permify resolved this through the relationship graph (${preflight.report?.mode ?? "demo"} ` +
        `check). The resource server will ask again independently.`,
    });
  }

  // 4. Step-up gate for sensitive tools.
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

  // 5. The MCP call (layer 2 — the resource server verifies + re-checks scope, role,
  //    and then FGA for the specific resources involved).
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
    appendFgaTrace(trace, mcp);
    if (!mcp.fgaDenied) {
      // The boundary was crossed, so say so on this path too — the planner can pick the
      // external tool directly, and without this the trace and the diagram would report a
      // third-party call as an ordinary internal one.
      if (call.tool === "search_public_docs" && !mcp.error) {
        trace.push({
          layer: "external",
          status: "info",
          label: "external: answered from public docs",
          detail:
            "The tool server called a THIRD-PARTY MCP server for public documentation. " +
            "The employee's access token was not forwarded — a third party can't verify " +
            "it — so nothing user-identifying left the network, and what came back is " +
            "treated as untrusted content: displayed and attributed, never acted on.",
        });
      }
      trace.push({
        layer: "result",
        status: "info",
        label: "tool executed",
        detail: `${call.tool} returned a result.`,
      });
    }
  }

  // 6. Nothing internal to show? Fall through to the external stage — but only for a
  //    knowledge-base search that genuinely came back empty. A denial is an answer.
  if (
    call.tool === "search_knowledge_base" &&
    mcp.reached &&
    mcp.mcpAllowed &&
    !mcp.fgaDenied &&
    !mcp.error &&
    ((mcp.data as { results?: unknown[] } | undefined)?.results?.length ?? 0) === 0 &&
    message.trim()
  ) {
    return externalStage(message, {
      prefix:
        "Nothing in the internal knowledge base matched, so answering from general knowledge: ",
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

/**
 * Turns the FGA report the tool returned into trace steps. The resource server's FGA
 * check is the THIRD authorization layer, and it reads differently from the scope + role
 * gate above it: allowed outright, narrowed to a subset, or refused for this resource.
 */
function appendFgaTrace(trace: TraceStep[], mcp: McpCallResult): void {
  if (mcp.fgaDenied) {
    trace.push({
      layer: "fga",
      status: "denied",
      label: `fga (resource server): DENIED (${mcp.fgaDenied.entity}#${mcp.fgaDenied.permission})`,
      detail:
        `${mcp.fgaDenied.message} The token's scope and role were fine — the resource ` +
        `server's own Permify check is what refused (${mcp.fga?.mode ?? "demo"}).`,
    });
    return;
  }
  const report = mcp.fga;
  if (!report || report.checks.length === 0) return;

  const filtered = report.filtered;
  if (filtered && filtered.visible < filtered.total) {
    trace.push({
      layer: "fga",
      status: "allowed",
      label: `fga (resource server): FILTERED (${filtered.visible} of ${filtered.total} ${filtered.unit})`,
      detail:
        `Permify answered ${report.checks.length} resource check` +
        `${report.checks.length === 1 ? "" : "s"} (${report.mode}); the ` +
        `${filtered.total - filtered.visible} the caller's relations don't reach were ` +
        `dropped before the result was built.`,
    });
    return;
  }
  const first = report.checks[0];
  trace.push({
    layer: "fga",
    status: "allowed",
    label: `fga (resource server): ALLOWED (${first.entity}#${first.permission}${
      report.checks.length > 1 ? ` +${report.checks.length - 1}` : ""
    })`,
    detail:
      `The resource server asked Permify about ${report.checks.length} resource` +
      `${report.checks.length === 1 ? "" : "s"} (${report.mode} check) and the ` +
      `relationship graph allowed ${report.checks.length === 1 ? "it" : "them all"}.`,
  });
}
