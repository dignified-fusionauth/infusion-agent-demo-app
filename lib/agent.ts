import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  scopeForTool,
  definitionForTool,
  toolRequiresStepUp,
  type ToolName,
} from "@/lib/scopes";
import { rolesAllowTool, rolesForTool } from "@/lib/roles";

/**
 * The agent loop. Two planners, one orchestration path:
 *
 *  - SCRIPTED (default, zero external dependency): a deterministic keyword→tool
 *    planner. Still makes real MCP calls, real scope checks, real step-up.
 *  - LIVE LLM (optional, when ANTHROPIC_API_KEY is set): a real Claude
 *    tool-calling turn picks the tool instead. See planTurn.
 *
 * The AUTHORIZATION behavior is identical in both modes — the sandbox pre-check
 * (sandboxCheck) and the MCP call (callMcpTool) don't care who or what chose the
 * tool. That's the whole point: the auth layer never trusts the planner.
 */

// ---------------------------------------------------------------------------
// The live authorization trace — the signature UI's data model
// ---------------------------------------------------------------------------

export type TraceLayer = "planner" | "sandbox" | "stepup" | "mcp" | "result";
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
];

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/** Pull a `for <Name>` / trailing capitalized name out of a message. */
function extractEmployee(message: string): string {
  const forMatch = message.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (forMatch) return forMatch[1];
  const caps = message.match(/[A-Z][a-z]+\s+[A-Z][a-z]+/);
  return caps ? caps[0] : "";
}

/** Pull a signed day-count out of a message (e.g. "add 3 days"). */
function extractDeltaDays(message: string): number {
  const m = message.match(/(-?\d+)\s*(day|days)/i);
  if (m) {
    const n = Number(m[1]);
    if (/\b(remove|deduct|subtract|take)\b/i.test(message)) return -Math.abs(n);
    return n;
  }
  return 0;
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

  // Default: treat any other question as a knowledge-base search.
  return { call: { tool: "search_knowledge_base", args: { query: message.trim() } } };
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
        "You are Ask Fusion, an internal employee assistant. Decide whether a tool " +
        "is needed to answer the user, and if so call exactly one tool. If no tool " +
        "is needed, answer directly and briefly.",
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
  } catch {
    // Anthropic unreachable / key invalid → degrade to the scripted planner.
    return scriptedPlan(message);
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
  requiredScope: string;
  /** Why the sandbox denied, when it did. */
  reason?: "missing_scope" | "role_not_permitted";
  /** Roles permitted to use the tool (populated on a role denial). */
  allowedRoles?: string[];
}

/**
 * The agent's own, local pre-flight check. A tool is allowed only when BOTH hold:
 *   1. the signed-in user's token carries the tool's required scope, AND
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
  const requiredScope = scopeForTool(tool) ?? "";
  if (!scopes.includes(requiredScope)) {
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

  try {
    await client.connect(transport);
    const res = await client.callTool({ name: tool, arguments: args });

    // The first text block carries our JSON envelope: {ok, data} | {ok:false,...}.
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const textBlock = content.find((b) => b.type === "text");
    let payload: {
      ok?: boolean;
      error?: string;
      scope?: string;
      message?: string;
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
    if (res.isError || payload.ok === false) {
      return {
        reached: true,
        mcpAllowed: true,
        error: payload.message || "The tool reported an error.",
      };
    }
    return { reached: true, mcpAllowed: true, data: payload.data };
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
      await client.close();
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
  if (result.error) return result.error;

  const data = result.data as Record<string, unknown> | undefined;
  switch (tool) {
    case "search_knowledge_base": {
      const results = (data?.results as Array<{ title: string; body: string }>) ?? [];
      if (results.length === 0) {
        return "I searched the knowledge base but didn't find a matching article you can access.";
      }
      const top = results[0];
      return `From the knowledge base — **${top.title}**: ${top.body}`;
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
      return `Last month's total payroll was ${total ?? "unavailable"} across all teams.`;
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
