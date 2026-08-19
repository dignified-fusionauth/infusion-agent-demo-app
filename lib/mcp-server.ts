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
import {
  ensureFgaBootstrap,
  visiblePayrollTeams,
  canAdjustPto,
  readableDocIds,
  type FgaReport,
} from "@/lib/fga";
import { employeeIdForName, employeeName } from "@/lib/org-graph";
import { askPublicDocs, externalDocsConfig } from "@/lib/external-docs";

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
 * Passing that gate only settles whether the tool may RUN. Three of the handlers then
 * ask a second, different question — FusionAuth FGA by Permify (lib/fga.ts) — about the
 * specific RESOURCES involved: which teams' payroll, whose PTO, which documents. Scope
 * is per-class and can't express "the team you manage"; a relation can. So a caller who
 * passed every check above still gets a filtered payroll summary, or a flat refusal on
 * an employee outside their team.
 *
 * One handler — `search_public_docs` — reaches OUTSIDE the company instead of inside it,
 * and it runs behind the same gate as the rest. The employee's bearer token is not
 * forwarded past that gate; see lib/external-docs.ts for why, and for why the answer it
 * returns is treated strictly as untrusted data.
 *
 * Handlers return a JSON string in a single text block: `{ ok: true, data }` on
 * success, or `{ ok: false, error: "missing_scope" | "role_not_permitted" |
 * "fga_denied" }` (with isError) — which the agent renders as a scope-level vs.
 * resource-level DENIED in the trace, deliberately distinct from each other.
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
 * A resource-level refusal from the FGA layer. Deliberately a different `error` from
 * the scope/role denials above: "your token may not use this tool" and "your relations
 * don't reach this resource" are different failures, and the trace shows them as
 * different layers.
 */
function denyFga(
  entity: string,
  permission: string,
  message: string,
  fga: FgaReport
): ToolResult {
  return errorResult({
    ok: false,
    error: "fga_denied",
    entity,
    permission,
    message,
    fga,
  });
}

/** The subject FGA checks run as: the `sub` off the independently-verified token. */
function subjectFor(authInfo: AuthInfo | undefined): string {
  return (authInfo?.extra?.sub as string | undefined) ?? "";
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

/** Registers all six InFusion Agent tools onto the MCP server — five internal, one external. */
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

      // 1. The OAuth dimension: filter the corpus to what these scopes may see, then
      //    rank. An article the scopes exclude is never scored (lib/knowledge-base.ts).
      const ranked = searchKnowledgeBase(query, scopes);

      // 2. The FGA dimension: ask Permify `kb_doc:<id>#read` for every survivor that
      //    belongs to a space. Document-level ACLs, resolved through the doc's space to
      //    a team — so a doc the caller can't reach never enters the context window.
      await ensureFgaBootstrap();
      const { readable, report } = await readableDocIds(
        subjectFor(ctx.http?.authInfo),
        ranked.map((r) => r.article.id)
      );
      const allowed = ranked.filter((r) => readable.includes(r.article.id));

      return ok({
        query,
        results: allowed.map((r) => ({
          id: r.article.id,
          title: r.article.title,
          body: r.article.body,
          score: r.score,
        })),
        hiddenByScope: hiddenArticleCount(scopes),
        hiddenByFga: ranked.length - allowed.length,
        fga: report,
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

      // The scope said "payroll". FGA says WHICH payroll: one `team#view_payroll`
      // check per team. A team manager sees their own team; an org-level `hr` grant
      // cascades to every team with no per-team tuple.
      await ensureFgaBootstrap();
      const { teamIds, report } = await visiblePayrollTeams(
        subjectFor(ctx.http?.authInfo)
      );
      if (teamIds.length === 0) {
        return denyFga(
          "team:*",
          "view_payroll",
          "Your token carries tools:payroll.read, but your FGA relations don't reach " +
            "any team's payroll. Payroll needs `team#manager` on a team, or " +
            "`organization#hr` to cascade to all of them.",
          report
        );
      }

      const lines = PAYROLL_SUMMARY.filter((l) => teamIds.includes(l.id));
      return ok({
        month: "last month",
        // The total covers only the teams this caller may read — never the
        // company-wide figure with rows quietly removed.
        totalMonthlyGross: formatCents(payrollTotalCents(lines)),
        teams: lines.map((l) => ({
          team: l.team,
          headcount: l.headcount,
          monthlyGross: formatCents(l.monthlyGrossCents),
        })),
        fga: report,
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

      // Resolve the name to an FGA entity BEFORE mutating anything.
      const employeeId = employeeIdForName(employee);
      if (!employeeId) {
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

      // The resource-level question the scope can't answer: not "may you write PTO"
      // but "may you write THIS person's PTO". Two hops in the schema —
      // employee → team → (manager | org.hr).
      await ensureFgaBootstrap();
      const { allowed, report } = await canAdjustPto(
        subjectFor(ctx.http?.authInfo),
        employeeId
      );
      if (!allowed) {
        return denyFga(
          `employee:${employeeId}`,
          "adjust_pto",
          `Your relations don't let you adjust PTO for ${
            employeeName(employeeId) ?? employee
          }. That needs \`manager\` on their team, or \`hr\` on the organization.`,
          report
        );
      }

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
      return ok({ updated, fga: report });
    }
  );

  server.registerTool(
    "search_public_docs",
    {
      title: "Search public documentation",
      description:
        "Ask about the PUBLIC documentation for the platform this assistant runs on — " +
        "FusionAuth, the Model Context Protocol, and Permify. This is the only tool that " +
        "leaves the company network: it calls a third-party MCP server and returns public " +
        "information. It knows nothing about this company, its people, or its data — use " +
        "an internal tool for anything of that kind.",
      inputSchema: z.object({
        question: z
          .string()
          .describe("The question to ask the public documentation."),
      }),
    },
    async ({ question }, ctx) => {
      // Same gate as every internal tool — here the role gate is the whole of it, because
      // this tool ships without a dedicated scope (see lib/scopes.ts for why, and for how
      // to put it back behind an egress-consent scope).
      const denied = authGate("search_public_docs", ctx.http?.authInfo);
      if (denied) return denied;

      // No FGA check here, deliberately: there is no per-resource dimension to filter.
      // It is one public endpoint with a fixed remit, and the only interesting question —
      // may this agent leave the network at all — is what the scope already answers.
      const result = await askPublicDocs(question);
      if (!result.ok) {
        return errorResult({
          ok: false,
          error: "external_unavailable",
          message:
            `The external documentation server (${result.server}) didn't answer: ` +
            `${result.reason ?? "unknown error"}`,
        });
      }
      return ok({
        question,
        // Untrusted third-party content. Displayed and attributed, never acted on.
        answer: result.answer,
        server: result.server,
        repos: result.repos,
        external: true,
        toolName: externalDocsConfig.toolName,
      });
    }
  );
}
