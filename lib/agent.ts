import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  scopeForTool,
  definitionForTool,
  toolRequiresStepUp,
  type ToolName,
} from "@/lib/scopes";
import { rolesAllowTool, rolesForTool } from "@/lib/roles";
import { canAdjustPto, type FgaReport } from "@/lib/fga";
import { employeeIdForName, findEmployeeInText } from "@/lib/org-graph";
import { corpusMatches } from "@/lib/knowledge-base";

/**
 * The agent loop. Two planners, one orchestration path:
 *
 *  - SCRIPTED (default, zero external dependency): a deterministic keyword→tool
 *    planner. Still makes real MCP calls, real scope checks, real step-up.
 *  - LIVE LLM (optional, when ANTHROPIC_API_KEY is set): a real Claude
 *    tool-calling turn picks the tool instead. See planTurn.
 *
 * The AUTHORIZATION behavior is identical in both modes — the sandbox pre-check
 * (sandboxCheck), the FGA resource pre-check (fgaPreflight), and the MCP call
 * (callMcpTool) don't care who or what chose the tool. That's the whole point: the auth
 * layer never trusts the planner.
 *
 * Both planners route INTERNAL-FIRST, down a three-rung ladder: one of the five internal
 * tools whenever one could plausibly serve the prompt; then `search_public_docs`, which
 * leaves the network for public platform documentation and is authorized exactly like the
 * others; and only then the model's own general knowledge
 * (answerFromModelKnowledge), which reaches nothing at all. Every rung is a visible stage
 * in the trace, not a silent default — see the `external` trace layer.
 */

// ---------------------------------------------------------------------------
// The live authorization trace — the signature UI's data model
// ---------------------------------------------------------------------------

export type TraceLayer =
  | "planner"
  | "sandbox"
  | "fga"
  | "stepup"
  | "mcp"
  | "external"
  | "result";
export type TraceStatus =
  | "info"
  | "allowed"
  | "denied"
  | "required"
  | "verified"
  | "error";

export interface TraceStep {
  layer: TraceLayer;
  label: string;
  status: TraceStatus;
  detail?: string;
}

export interface PlannedCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface AgentPlan {
  /** A tool call the planner selected, or undefined for a plain chat reply. */
  call?: PlannedCall;
  /** Text reply when no tool is needed. */
  assistantText?: string;
  /**
   * Set only when live (LLM) mode was requested but the Anthropic call failed
   * and we fell back to the scripted planner. Carries the reason so the trace
   * can be honest instead of claiming a live turn that never happened.
   */
  degraded?: { reason: string };
}

/** What the client must resolve (via the two-factor routes) before resuming. */
export interface PendingStepUp {
  tool: ToolName;
  args: Record<string, unknown>;
  /** The step-up action label (e.g. "agent:view_payroll"). */
  action: string;
  /** A friendly title for the step-up slip. */
  title: string;
}

/** The /api/chat turn response. `import type` this from client components. */
export type ChatResponse =
  | {
      kind: "reply";
      reply: string;
      trace: TraceStep[];
      mode: "live" | "scripted";
    }
  | {
      kind: "stepup";
      trace: TraceStep[];
      mode: "live" | "scripted";
      pending: PendingStepUp;
    };

// ---------------------------------------------------------------------------
// Mode + model
// ---------------------------------------------------------------------------

/** ALWAYS use claude-opus-4-8 unless overridden; the skill's default. */
const LLM_MODEL = process.env.INFUSIONAGENT_LLM_MODEL || "claude-opus-4-8";

export function agentMode(): "live" | "scripted" {
  return process.env.ANTHROPIC_API_KEY ? "live" : "scripted";
}

/**
 * Wall-clock ceiling for a whole MCP round trip to our own server. `Client.connect()`
 * carries no timeout of its own, so without this a wedged transport hangs the turn.
 *
 * It must stay ABOVE EXTERNAL_MCP_TIMEOUT_MS: one of the tools behind this call
 * (`search_public_docs`) proxies out to a third party and is allowed ~32s of its own, so
 * a tighter ceiling here would cut off the very call it is waiting for.
 */
function mcpCallDeadlineMs(): number {
  return Number(process.env.MCP_CALL_TIMEOUT_MS) || 55_000;
}

/** A hard bound around a promise — see lib/external-docs.ts for why connect needs one. */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return (Promise.race([work, guard]) as Promise<T>).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Tool schemas (shared by the scripted planner's catalog display and the LLM)
// ---------------------------------------------------------------------------

interface ToolSchema {
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const AGENT_TOOLS: ToolSchema[] = [
  {
    name: "search_knowledge_base",
    description:
      "Search the internal knowledge base for policies, guides, and reference docs.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
    },
  },
  {
    name: "create_it_ticket",
    description: "Open an IT support ticket on the employee's behalf.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "A short summary of the issue." },
        category: { type: "string", description: "Optional category." },
      },
      required: ["subject"],
    },
  },
  {
    name: "lookup_employee",
    description: "Look up a colleague in the employee directory.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Name, email, or department." } },
      required: ["query"],
    },
  },
  {
    name: "view_payroll",
    description: "View last month's payroll figures by team. Sensitive.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_pto_balance",
    description: "Adjust an employee's PTO balance by a number of days. Sensitive.",
    input_schema: {
      type: "object",
      properties: {
        employee: { type: "string", description: "The employee's full name." },
        deltaDays: { type: "number", description: "Days to add (+) or remove (-)." },
      },
      required: ["employee", "deltaDays"],
    },
  },
  {
    name: "search_public_docs",
    description:
      "Ask about the PUBLIC documentation for the platform this assistant runs on: " +
      "FusionAuth (product docs and deployment), the Model Context Protocol, and " +
      "Permify. This is the only tool that " +
      "leaves the company network. It knows nothing about this company, its people, or " +
      "its data — use an internal tool for anything of that kind.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the public documentation.",
        },
      },
      required: ["question"],
    },
  },
];

/**
 * The tools that reach INTERNAL systems — everything except the one that leaves the
 * network. The routing trace step counts these, so adding an external tool can't quietly
 * inflate the "internal tools considered" claim.
 */
export const INTERNAL_TOOLS = AGENT_TOOLS.filter(
  (t) => t.name !== "search_public_docs"
);

/**
 * The platform topics the EXTERNAL tool has a remit for: the stack this app is built on.
 * A deliberately narrow keyword gate, and the reason the agent doesn't ship every
 * unmatched prompt off to a third party — "what's the capital of Norway" is not a
 * documentation question, so it never leaves the network at all.
 */
const EXTERNAL_TOPICS =
  /fusion\s?auth|permify|zanzibar|rebac|\bfga\b|model context protocol|\bmcp\b|\boauth\b|\boidc\b|\bjwks?\b|\bjwt\b|openid|client credentials|relation tuple|authorization server|identity provider|\bsso\b|\bscim\b/i;

/** True when a prompt is about the platform rather than about company data. */
export function looksExternal(message: string): boolean {
  return EXTERNAL_TOPICS.test(message);
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * Pull the employee out of a message. Tries the DIRECTORY first (see
 * `findEmployeeInText`), because the capitalisation heuristics below capture the leading
 * verb on the most natural phrasing there is — "Adjust Chen Li's PTO" yields "Adjust
 * Chen". The heuristics remain as the fallback so a name that isn't in the directory
 * still reaches the tool and gets an honest "no PTO record for …".
 */
function extractEmployee(message: string): string {
  const known = findEmployeeInText(message);
  if (known) return known.name;

  const forMatch = message.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (forMatch) return forMatch[1];
  const caps = message.match(/[A-Z][a-z]+\s+[A-Z][a-z]+/);
  return caps ? caps[0] : "";
}

/**
 * Pull a signed day-count out of a message ("add 3 days", "by -2 days", "3 PTO days").
 * The number and the unit aren't always adjacent, so a couple of intervening words are
 * tolerated — otherwise "give Bruno Vega 3 PTO days" parses as a zero-day adjustment and
 * the turn quietly does nothing.
 */
function extractDeltaDays(message: string): number {
  const m =
    message.match(/(-?\d+)\s*days?\b/i) ??
    message.match(/(-?\d+)\s+(?:\w+\s+){1,2}days?\b/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return /\b(remove|deduct|subtract|take)\b/i.test(message) ? -Math.abs(n) : n;
}

/**
 * The deterministic, rule-based planner. Priority-ordered so the most specific
 * intents win. Real, ungated code — only the tool-choice decision is scripted.
 */
export function scriptedPlan(message: string): AgentPlan {
  const m = message.toLowerCase();

  if (/\bpto\b|paid time off|vacation balance/.test(m) &&
      /\b(update|adjust|add|remove|deduct|set|give|grant|subtract|take)\b/.test(m)) {
    return {
      call: {
        tool: "update_pto_balance",
        args: {
          employee: extractEmployee(message),
          deltaDays: extractDeltaDays(message),
        },
      },
    };
  }

  if (/payroll|salary numbers|compensation numbers|last month'?s pay/.test(m)) {
    return { call: { tool: "view_payroll", args: {} } };
  }

  if (/\bticket\b|not working|broken|can'?t (log|access)|reset my|it help|help desk/.test(m)) {
    return {
      call: {
        tool: "create_it_ticket",
        args: { subject: message.trim(), category: "general" },
      },
    };
  }

  if (/look up|who is|find (me )?|directory|contact for|email for|reach/.test(m)) {
    const q = message.replace(/.*(look up|who is|find|contact for|email for|reach)\s*/i, "").trim();
    return { call: { tool: "lookup_employee", args: { query: q || message.trim() } } };
  }

  // Internal-first, but not blindly: route to the knowledge base only when the corpus
  // plausibly covers the topic. Anything else falls through with NO tool call, and
  // /api/chat answers it from the model's own knowledge as an explicit `external`
  // stage. Previously every unmatched prompt became a knowledge-base search, which made
  // "the internal KB has nothing on Norway" look like a retrieval failure.
  if (corpusMatches(message)) {
    return { call: { tool: "search_knowledge_base", args: { query: message.trim() } } };
  }

  // Internal corpus has nothing, but the platform docs might — the middle rung of the
  // ladder. Anything that isn't a platform question falls through with no tool at all.
  if (looksExternal(message)) {
    return { call: { tool: "search_public_docs", args: { question: message.trim() } } };
  }
  return {};
}

/**
 * The live planner: a real Claude tool-calling turn. Claude sees the same tool
 * schemas and picks one (or answers directly). We only take its tool SELECTION —
 * the authorization + execution that follows is identical to scripted mode.
 * Falls back to the scripted planner on any API failure (honest degrade).
 */
async function llmPlan(message: string): Promise<AgentPlan> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 1024,
      system:
        "You are Ask Fusion, an internal employee assistant. You have tools that " +
        "reach INTERNAL company systems: the internal knowledge base (HR/IT policies " +
        "and internal guides), the employee directory, payroll, IT ticketing, and PTO " +
        "balances.\n\n" +
        "CHECK THE INTERNAL TOOLS FIRST. If any tool above could plausibly serve the " +
        "request — anything about this company's policies, people, pay, time off, or IT " +
        "— call it. Prefer calling a tool over answering yourself whenever it's a close " +
        "call: the tool's answer is authoritative company data, yours isn't, and every " +
        "call is authorized per-user (an unauthorized one is refused safely, so " +
        "attempting it costs nothing).\n\n" +
        "One tool is different: search_public_docs is EXTERNAL. It answers questions " +
        "about FusionAuth, the Model Context Protocol, and Permify from public " +
        "documentation, and knows nothing about this company. Reach for it only for a " +
        "question about that platform that the internal systems wouldn't hold — never as " +
        "a substitute for an internal tool.\n\n" +
        "Only when NO tool could serve the request — general knowledge, facts about the " +
        "outside world, math, coding — answer directly from your own knowledge, briefly. " +
        "Do not call search_knowledge_base for topics the internal knowledge base plainly " +
        "wouldn't contain.",
      tools: AGENT_TOOLS as unknown as Parameters<
        typeof client.messages.create
      >[0]["tools"],
      messages: [{ role: "user", content: message }],
    });

    if (response.stop_reason === "tool_use") {
      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (toolBlock && toolBlock.type === "tool_use") {
        return {
          call: {
            tool: toolBlock.name as ToolName,
            args: (toolBlock.input as Record<string, unknown>) ?? {},
          },
        };
      }
    }
    const textBlock = response.content.find((b) => b.type === "text");
    return {
      assistantText:
        textBlock && textBlock.type === "text"
          ? textBlock.text
          : "I'm not sure how to help with that yet.",
    };
  } catch (err) {
    // Anthropic unreachable / key invalid / no credits → degrade to the scripted
    // planner, but record WHY so the trace stays honest (no fake "Live" label).
    const reason =
      err instanceof Error ? err.message : "Anthropic API was unavailable.";
    console.error(
      "[agent] Live LLM planner failed; degrading to scripted planner:",
      reason
    );
    return { ...scriptedPlan(message), degraded: { reason } };
  }
}

/** Plans one turn using the active planner. */
export async function planTurn(message: string): Promise<AgentPlan> {
  return agentMode() === "live" ? llmPlan(message) : scriptedPlan(message);
}

// ---------------------------------------------------------------------------
// The sandbox pre-check — layer 1 of the two independent checks
// ---------------------------------------------------------------------------

export interface SandboxDecision {
  allowed: boolean;
  /** The scope this tool needs, or undefined when it is gated on role alone. */
  requiredScope?: string;
  /** Why the sandbox denied, when it did. */
  reason?: "missing_scope" | "role_not_permitted";
  /** Roles permitted to use the tool (populated on a role denial). */
  allowedRoles?: string[];
}

/**
 * The agent's own, local pre-flight check. A tool is allowed only when BOTH hold:
 *   1. the signed-in user's token carries the tool's required scope, if it has one, AND
 *   2. the user holds a role permitted for the tool (defense-in-depth — see
 *      rolesAllowTool).
 * The scope alone is not enough: a scope FusionAuth mis-issues to the wrong role
 * still can't unlock the tool. Either failure means the agent refuses before
 * attempting any MCP call — annotated `sandbox: DENIED` in the trace, visibly
 * distinct from an MCP-level denial.
 */
export function sandboxCheck(
  tool: ToolName,
  scopes: string[],
  roles: string[]
): SandboxDecision {
  // A scopeless tool (see ScopeDefinition.id) skips this check rather than failing it —
  // treating "no scope required" as "scope missing" would deny it to everyone.
  const requiredScope = scopeForTool(tool);
  if (requiredScope && !scopes.includes(requiredScope)) {
    return { allowed: false, requiredScope, reason: "missing_scope" };
  }
  if (!rolesAllowTool(roles, tool)) {
    return {
      allowed: false,
      requiredScope,
      reason: "role_not_permitted",
      allowedRoles: rolesForTool(tool),
    };
  }
  return { allowed: true, requiredScope };
}

// ---------------------------------------------------------------------------
// The FGA resource pre-check — layer 1.5, still inside the agent
// ---------------------------------------------------------------------------

export interface FgaPreflight {
  /** False when this tool call names no specific resource to check. */
  applies: boolean;
  allowed: boolean;
  /** The entity checked, e.g. "employee:chen-li". */
  entity?: string;
  /** The permission checked, e.g. "adjust_pto". */
  permission?: string;
  /** Live vs. in-memory-fallback, for an honest trace line. */
  report?: FgaReport;
  /** A human-readable reason when the pre-check denied. */
  message?: string;
}

/**
 * The agent's own resource-level pre-check, run AFTER the scope + role sandbox check
 * and BEFORE the step-up gate. It only applies to tools whose arguments name one
 * specific resource — today `update_pto_balance`, whose `employee` argument identifies
 * exactly one FGA entity.
 *
 * Two reasons it exists rather than leaving this to the MCP server (which checks again
 * regardless — see lib/mcp-server.ts):
 *   1. Defense-in-depth, the same shape the scope + role checks already use.
 *   2. It spares the user a pointless two-factor challenge for a record FGA is going to
 *      refuse anyway. Denying before the step-up gate is the honest ordering.
 *
 * A name we can't resolve to an entity is NOT a denial — there's nothing to check, so
 * the call proceeds and the tool reports the unknown employee itself.
 */
export async function fgaPreflight(
  tool: ToolName,
  args: Record<string, unknown>,
  userId: string
): Promise<FgaPreflight> {
  if (tool !== "update_pto_balance") return { applies: false, allowed: true };

  const employee = typeof args.employee === "string" ? args.employee : "";
  const employeeId = employeeIdForName(employee);
  if (!employeeId) return { applies: false, allowed: true };

  const { allowed, report } = await canAdjustPto(userId, employeeId);
  return {
    applies: true,
    allowed,
    entity: `employee:${employeeId}`,
    permission: "adjust_pto",
    report,
    message: allowed
      ? undefined
      : `Your relations don't reach ${employee || employeeId}'s PTO. Adjusting it needs ` +
        `\`manager\` on their team, or \`hr\` on the organization.`,
  };
}

// ---------------------------------------------------------------------------
// The MCP call — layer 2 runs INSIDE the resource server (lib/mcp-server.ts)
// ---------------------------------------------------------------------------

export interface McpCallResult {
  /** Did the request reach the MCP server and pass its bearer-token auth? */
  reached: boolean;
  /** Did the MCP server's own per-tool scope + role check pass? */
  mcpAllowed: boolean;
  /** Why the MCP server denied, when it did. */
  deniedReason?: "missing_scope" | "role_not_permitted";
  /** The scope the MCP server said was missing, if it denied on scope. */
  missingScope?: string;
  /**
   * Set when the scope + role gate PASSED but the resource-level FGA check refused.
   * Kept separate from `mcpAllowed` on purpose: "your token may not use this tool" and
   * "your relations don't reach this resource" are different failures, and the trace
   * renders them as different layers.
   */
  fgaDenied?: { entity: string; permission: string; message: string };
  /** The FGA decisions behind the call — present on success and on an FGA denial. */
  fga?: FgaReport;
  /** The tool's structured data on success. */
  data?: unknown;
  /** A human-readable error when the call failed or was denied. */
  error?: string;
}

/**
 * Calls a tool on the MCP server as a genuine MCP client over Streamable HTTP,
 * passing the signed-in user's access token as the bearer. The MCP server
 * verifies that token INDEPENDENTLY (lib/mcp-auth.ts) and each tool re-checks the
 * scope — so this exercises the real, second authorization layer.
 */
export async function callMcpTool(
  tool: ToolName,
  args: Record<string, unknown>,
  accessToken: string
): Promise<McpCallResult> {
  const url = new URL(`${appBaseUrl()}/api/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({
    name: "infusion-agent-orchestrator",
    version: "0.1.0",
  });

  const deadline = Date.now() + mcpCallDeadlineMs();
  const remaining = () => Math.max(1_000, deadline - Date.now());

  try {
    await withDeadline(
      client.connect(transport),
      Math.min(10_000, remaining()),
      "MCP handshake"
    );
    const res = await withDeadline(
      client.callTool({ name: tool, arguments: args }, { timeout: remaining() }),
      remaining(),
      `${tool} call`
    );

    // The first text block carries our JSON envelope: {ok, data} | {ok:false,...}.
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const textBlock = content.find((b) => b.type === "text");
    let payload: {
      ok?: boolean;
      error?: string;
      scope?: string;
      message?: string;
      entity?: string;
      permission?: string;
      fga?: FgaReport;
      data?: unknown;
    } = {};
    if (textBlock?.text) {
      try {
        payload = JSON.parse(textBlock.text);
      } catch {
        payload = { ok: false, message: textBlock.text };
      }
    }

    if (
      payload.ok === false &&
      (payload.error === "missing_scope" ||
        payload.error === "role_not_permitted")
    ) {
      return {
        reached: true,
        mcpAllowed: false,
        deniedReason: payload.error,
        missingScope: payload.scope,
        error: payload.message,
      };
    }
    // The resource server verified the token and passed its scope + role gate, then
    // the FGA layer refused the specific resource.
    if (payload.ok === false && payload.error === "fga_denied") {
      return {
        reached: true,
        mcpAllowed: true,
        fgaDenied: {
          entity: payload.entity ?? "",
          permission: payload.permission ?? "",
          message: payload.message ?? "Your relations don't reach that resource.",
        },
        fga: payload.fga,
        error: payload.message,
      };
    }
    if (res.isError || payload.ok === false) {
      return {
        reached: true,
        mcpAllowed: true,
        error: payload.message || "The tool reported an error.",
      };
    }
    const data = payload.data as { fga?: FgaReport } | undefined;
    return { reached: true, mcpAllowed: true, data: payload.data, fga: data?.fga };
  } catch (err) {
    // connect() throws on a 401 (token couldn't be verified) or transport error.
    return {
      reached: false,
      mcpAllowed: false,
      error:
        err instanceof Error
          ? `MCP server rejected the request: ${err.message}`
          : "Could not reach the MCP server.",
    };
  } finally {
    try {
      await withDeadline(client.close(), 3_000, "MCP close");
    } catch {
      // ignore close errors
    }
  }
}

// ---------------------------------------------------------------------------
// Reply formatting — deterministic in BOTH modes (the data is what matters)
// ---------------------------------------------------------------------------

/** Turns a tool's structured result into a short natural-language reply. */
export function formatToolReply(
  tool: ToolName,
  result: McpCallResult
): string {
  if (!result.reached) {
    return "I couldn't reach the tool server — it rejected the request before running the tool.";
  }
  if (!result.mcpAllowed) {
    return (
      result.error ??
      (result.deniedReason === "role_not_permitted"
        ? "The tool server refused the call: your role isn't permitted to use this tool."
        : `The tool server refused the call: your token is missing ${result.missingScope}.`)
    );
  }
  if (result.fgaDenied) {
    return (
      `${result.fgaDenied.message} Your token and role were both fine — this is a ` +
      `resource-level decision (\`${result.fgaDenied.entity}#${result.fgaDenied.permission}\`).`
    );
  }
  if (result.error) return result.error;

  const data = result.data as Record<string, unknown> | undefined;
  switch (tool) {
    case "search_knowledge_base": {
      const results = (data?.results as Array<{ title: string; body: string }>) ?? [];
      if (results.length === 0) {
        return "I searched the knowledge base but didn't find a matching article you can access.";
      }
      const top = results[0];
      const hiddenByFga = (data?.hiddenByFga as number | undefined) ?? 0;
      const note =
        hiddenByFga > 0
          ? ` (${hiddenByFga} matching document${hiddenByFga === 1 ? "" : "s"} withheld — ` +
            `your relations don't reach ${hiddenByFga === 1 ? "its" : "their"} knowledge-base space.)`
          : "";
      return `From the knowledge base — **${top.title}**: ${top.body}${note}`;
    }
    case "create_it_ticket": {
      const ticket = data?.ticket as { id: string; subject: string } | undefined;
      return ticket
        ? `I opened ticket ${ticket.id}: "${ticket.subject}". IT will follow up.`
        : "I opened your ticket.";
    }
    case "lookup_employee": {
      const matches = (data?.matches as Array<{ name: string; email?: string }>) ?? [];
      if (matches.length === 0) return "No matching colleague found.";
      return `Found ${matches.length}: ${matches
        .map((m) => `${m.name}${m.email ? ` (${m.email})` : ""}`)
        .join(", ")}.`;
    }
    case "view_payroll": {
      const total = data?.totalMonthlyGross as string | undefined;
      const teams = (data?.teams as Array<{ team: string }> | undefined) ?? [];
      const names = teams.map((t) => t.team).join(", ");
      const filtered = result.fga?.filtered;
      const scope =
        teams.length === 0
          ? "across all teams"
          : filtered && filtered.visible < filtered.total
            ? `for the ${teams.length === 1 ? "one team" : `${teams.length} teams`} your relations reach (${names})`
            : `across all ${teams.length} teams (${names})`;
      const note =
        filtered && filtered.visible < filtered.total
          ? ` FGA withheld ${filtered.total - filtered.visible} other team` +
            `${filtered.total - filtered.visible === 1 ? "" : "s"}.`
          : "";
      return `Last month's payroll ${scope} totalled ${total ?? "unavailable"}.${note}`;
    }
    case "search_public_docs": {
      const answer = data?.answer as string | undefined;
      const server = (data?.server as string | undefined) ?? "an external server";
      if (!answer) return "The external documentation server didn't return an answer.";
      // Attribution is not decoration here: the reader needs to know this text came from
      // outside the company and is not authoritative about company data.
      return `From public documentation via ${server} (external — not company data): ${answer}`;
    }
    case "update_pto_balance": {
      const updated = data?.updated as { employee: string; remainingDays: number } | undefined;
      return updated
        ? `${updated.employee} now has ${updated.remainingDays} PTO days remaining.`
        : "PTO balance updated.";
    }
    default:
      return "Done.";
  }
}

// ---------------------------------------------------------------------------
// The external stage — only reached when nothing internal could serve the turn
// ---------------------------------------------------------------------------

export interface ExternalAnswer {
  /** The answer text, or null when no external source is configured/reachable. */
  text: string | null;
  /** Why there's no text — surfaced honestly instead of a canned reply. */
  reason?: string;
}

/**
 * Answers from the model's own general knowledge — the LAST resort, run only after the
 * internal tools have been considered and none could serve the prompt (or a search came
 * back empty). It gets NO tools and no company data, and `/api/chat` logs it as its own
 * `external` trace step, so a viewer can see that internal systems were tried first.
 *
 * With no ANTHROPIC_API_KEY there is no external source at all — we say so rather than
 * inventing an answer, the same honest-degrade the rest of the app uses.
 */
export async function answerFromModelKnowledge(
  message: string
): Promise<ExternalAnswer> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      text: null,
      reason:
        "No external knowledge source is configured (ANTHROPIC_API_KEY is unset), so " +
        "the agent can only answer from internal systems.",
    };
  }
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 1024,
      system:
        "You are Ask Fusion, an internal employee assistant. The internal tools were " +
        "checked first and none of them can serve this request — you have NO access to " +
        "company data in this reply. Answer briefly from your own general knowledge. " +
        "Never imply you looked anything up in an internal system, and if the question " +
        "actually needs internal company data, say plainly that you couldn't find it " +
        "internally rather than guessing at it.",
      messages: [{ role: "user", content: message }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return {
      text:
        textBlock && textBlock.type === "text"
          ? textBlock.text
          : "I'm not sure how to help with that.",
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "The external model was unavailable.";
    console.error("[agent] External answer failed:", reason);
    return { text: null, reason };
  }
}

/** True when a tool needs a fresh step-up before it may execute. */
export function requiresStepUp(tool: ToolName): boolean {
  return toolRequiresStepUp(tool);
}

/** The step-up "action" label sent to FusionAuth for a given tool. */
export function stepUpAction(tool: ToolName): string {
  return `agent:${tool}`;
}

/** A friendly label for a tool, from the scope catalog. */
export function toolLabel(tool: ToolName): string {
  return definitionForTool(tool)?.description ?? tool;
}
