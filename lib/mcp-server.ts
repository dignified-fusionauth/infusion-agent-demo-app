import { z } from "zod";
import type { McpServer, AuthInfo } from "@modelcontextprotocol/server";
import { scopeForTool, definitionForTool, type ToolName } from "@/lib/scopes";
import { rolesAllowTool } from "@/lib/roles";
import { searchKnowledgeBase, hiddenArticleCount } from "@/lib/knowledge-base";
import { createTicket } from "@/lib/tickets";
import { searchDirectory } from "@/lib/directory";
import { searchDirectoryUsers } from "@/lib/fusionauth";
import {
  PAYROLL_SUMMARY,
  payrollTotalCents,
  formatCents,
  adjustPtoBalance,
} from "@/lib/payroll";

/**
 * The MCP tool registry + handlers. Registered onto the McpServer that
 * createMcpHandler builds (see app/api/mcp/route.ts). Every handler runs its OWN
 * scope + role check off `ctx.http?.authInfo` — the AuthInfo produced by the
 * independent verifier in lib/mcp-auth.ts. That check is intentionally separate
 * from the agent's sandbox pre-check in lib/agent.ts: this is the resource
 * server's own decision, made even if the sandbox was bypassed.
 *
 * Authorization is defense-in-depth: a tool runs only if the token carries the
 * required scope AND the caller's role is permitted for it. So a scope FusionAuth
 * mis-issues to the wrong role can't unlock a tool by itself.
 *
 * Handlers return a JSON string in a single text block: `{ ok: true, data }` on
 * success, or `{ ok: false, error: "missing_scope" | "role_not_permitted" }`
 * (with isError) — which the agent renders as an MCP-level DENIED in the trace.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  // The SDK's CallToolResult carries an index signature; mirror it so our
  // handlers' return type is assignable.
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): ToolResult {
  const payload = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function denyScope(scope: string): ToolResult {
  return errorResult({
    ok: false,
    error: "missing_scope",
    scope,
    message: `The bearer token is missing the required scope ${scope}.`,
  });
}

function denyRole(tool: ToolName): ToolResult {
  const allowed = definitionForTool(tool)?.defaultForRoles ?? [];
  return errorResult({
    ok: false,
    error: "role_not_permitted",
    message:
      `This tool is restricted to roles: ${allowed.join(", ")}. The token's ` +
      `role isn't permitted, even though the scope is present.`,
  });
}

/**
 * The MCP server's own authorization gate — scope AND role, checked
 * independently of the agent sandbox. Returns a deny result to return directly,
 * or null when the caller may proceed.
 */
function authGate(tool: ToolName, authInfo: AuthInfo | undefined): ToolResult | null {
  const required = scopeForTool(tool);
  const scopes = authInfo?.scopes ?? [];
  if (required && !scopes.includes(required)) return denyScope(required);
  const roles = (authInfo?.extra?.roles as string[] | undefined) ?? [];
  if (!rolesAllowTool(roles, tool)) return denyRole(tool);
  return null;
}

/** Registers all five InFusion Agent tools onto the MCP server. */
export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "search_knowledge_base",
    {
      title: "Search knowledge base",
      description:
        "Search the internal knowledge base and return the most relevant articles. Results are filtered to what the caller's token is allowed to see.",
      inputSchema: z.object({
        query: z.string().describe("What to search the knowledge base for."),
      }),
    },
    async ({ query }, ctx) => {
      const denied = authGate("search_knowledge_base", ctx.http?.authInfo);
      if (denied) return denied;
      const scopes = ctx.http?.authInfo?.scopes ?? [];
      const ranked = searchKnowledgeBase(query, scopes);
      return ok({
        query,
        results: ranked.map((r) => ({
          id: r.article.id,
          title: r.article.title,
          body: r.article.body,
          score: r.score,
        })),
        hiddenByScope: hiddenArticleCount(scopes),
      });
    }
  );

  server.registerTool(
    "create_it_ticket",
    {
      title: "Create IT ticket",
      description:
        "Open an IT support ticket on the employee's behalf and return its reference id.",
      inputSchema: z.object({
        subject: z.string().describe("A short summary of the issue."),
        category: z
          .string()
          .optional()
          .describe("Optional category, e.g. 'hardware' or 'access'."),
      }),
    },
    async ({ subject, category }, ctx) => {
      const denied = authGate("create_it_ticket", ctx.http?.authInfo);
      if (denied) return denied;
      const openedBy =
        (ctx.http?.authInfo?.extra?.email as string | undefined) ||
        (ctx.http?.authInfo?.extra?.sub as string | undefined) ||
        "unknown";
      const ticket = createTicket({
        subject,
        category: category?.trim() || "general",
        openedBy,
        nowIso: new Date().toISOString(),
      });
      return ok({ ticket });
    }
  );

  server.registerTool(
    "lookup_employee",
    {
      title: "Look up employee",
      description:
        "Look up a colleague in the employee directory by name, email, or department.",
      inputSchema: z.object({
        query: z.string().describe("Name, email, or department to search for."),
      }),
    },
    async ({ query }, ctx) => {
      const denied = authGate("lookup_employee", ctx.http?.authInfo);
      if (denied) return denied;

      // Try a real FusionAuth /api/user search first (the tool server acts under
      // its own identity for outbound calls); fall back to the mock directory.
      const live = await searchDirectoryUsers(query);
      if (live) {
        return ok({
          source: "fusionauth",
          matches: live.map((u) => ({
            name: u.name,
            email: u.email,
            roles: u.roles,
          })),
        });
      }
      const mock = searchDirectory(query);
      return ok({
        source: "mock-directory",
        matches: mock.map((e) => ({
          name: e.name,
          email: e.email,
          title: e.title,
          department: e.department,
          location: e.location,
        })),
      });
    }
  );

  server.registerTool(
    "view_payroll",
    {
      title: "View payroll",
      description:
        "Return last month's payroll summary by team. Sensitive: requires payroll scope and a fresh step-up check.",
    },
    async (ctx) => {
      const denied = authGate("view_payroll", ctx.http?.authInfo);
      if (denied) return denied;
      return ok({
        month: "last month",
        totalMonthlyGross: formatCents(payrollTotalCents()),
        teams: PAYROLL_SUMMARY.map((l) => ({
          team: l.team,
          headcount: l.headcount,
          monthlyGross: formatCents(l.monthlyGrossCents),
        })),
      });
    }
  );

  server.registerTool(
    "update_pto_balance",
    {
      title: "Update PTO balance",
      description:
        "Adjust an employee's PTO balance by a number of days (positive or negative). Sensitive: requires PTO scope and a fresh step-up check.",
      inputSchema: z.object({
        employee: z.string().describe("The employee's full name."),
        deltaDays: z
          .number()
          .describe("Days to add (positive) or remove (negative)."),
      }),
    },
    async ({ employee, deltaDays }, ctx) => {
      const denied = authGate("update_pto_balance", ctx.http?.authInfo);
      if (denied) return denied;
      const updated = adjustPtoBalance(employee, deltaDays);
      if (!updated) {
        const payload = {
          ok: false,
          error: "unknown_employee",
          message: `No PTO record for "${employee}".`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }
      return ok({ updated });
    }
  );
}
