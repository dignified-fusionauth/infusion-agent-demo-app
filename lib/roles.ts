import { isAgentRole, definitionForTool, type AgentRole, type ToolName } from "@/lib/scopes";

/**
 * Application Role helpers, the same "no lambda" pattern the sibling apps use:
 * FusionAuth stamps the user's InFusion Agent Application Roles onto the ACCESS
 * token's `roles` claim automatically once they're registered for the app, so
 * every authorization decision keys off the verified access-token claim (see
 * lib/session.ts), never off UI state.
 *
 * The role also decides which default tool scopes a sign-in requests (see
 * lib/scopes.ts + lib/bff.ts): an employee's login never even asks for
 * `tools:payroll.read`. That request-time choice is UX only. Enforcement is
 * defense-in-depth: a tool runs only when the verified token carries the
 * required scope AND the role is permitted (see rolesAllowTool), checked
 * independently by the sandbox (lib/agent.ts) and the MCP server (lib/mcp-server.ts).
 */

/** The roles InFusion Agent understands, least → most privileged. */
export const ROLE_EMPLOYEE = "employee";
export const ROLE_MANAGER = "manager";
export const ROLE_IT_ADMIN = "it-admin";

/**
 * The admin role name that unlocks /admin is configurable so it can match
 * whatever the customer's FusionAuth application calls it. Defaults to "admin".
 */
export function adminRoleName(): string {
  return (process.env.INFUSIONAGENT_ADMIN_ROLE || "admin").trim();
}

/** Privilege order for picking a "primary" role to show on a badge. */
function roleRank(role: string): number {
  if (role === adminRoleName()) return 4;
  if (role === ROLE_IT_ADMIN) return 3;
  if (role === ROLE_MANAGER) return 2;
  if (role === ROLE_EMPLOYEE) return 1;
  return 0;
}

/**
 * Extracts roles from a set of verified token claims. FusionAuth emits `roles`
 * as a string array, but we tolerate a single string or comma-separated list
 * too, so a differently-configured tenant still works.
 */
export function rolesFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims.roles;
  if (Array.isArray(raw)) {
    return raw.filter((r): r is string => typeof r === "string" && r !== "");
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return [];
}

export function hasRole(roles: string[], role: string): boolean {
  const target = role.toLowerCase();
  return roles.some((r) => r.toLowerCase() === target);
}

/** True when the user holds the (configurable) admin role. */
export function isAdmin(roles: string[]): boolean {
  return hasRole(roles, adminRoleName());
}

/**
 * The most-privileged AgentRole the user holds, for choosing default scopes and
 * a badge. Returns undefined when the token carries no recognized agent role
 * (e.g. the user isn't registered for the app). An admin-only user maps to
 * "it-admin" for scope purposes (the widest default tool set).
 */
export function primaryAgentRole(roles: string[]): AgentRole | undefined {
  if (isAdmin(roles)) return ROLE_IT_ADMIN;
  const known = roles.filter((r) => isAgentRole(r.toLowerCase()));
  const top = known.sort((a, b) => roleRank(b) - roleRank(a))[0];
  return top ? (top.toLowerCase() as AgentRole) : undefined;
}

export interface RoleBadgeStyle {
  label: string;
  /** Text color for the role chip. */
  color: string;
  /** Background for the role chip. */
  background: string;
}

/**
 * The single most-privileged role to feature on a badge, with a display label
 * and chip colors. Falls back to a neutral "Guest" when the token carries no
 * recognized role.
 */
export function primaryRoleBadge(roles: string[]): RoleBadgeStyle {
  const top = [...roles].sort((a, b) => roleRank(b) - roleRank(a))[0];
  if (top && top === adminRoleName()) {
    return { label: "Administrator", color: "#9a4e0a", background: "#fdecd8" };
  }
  if (top && top.toLowerCase() === ROLE_IT_ADMIN) {
    return { label: "IT Admin", color: "#0e4f4a", background: "#cdeeea" };
  }
  if (top && top.toLowerCase() === ROLE_MANAGER) {
    return { label: "Manager", color: "#1e3a8a", background: "#e0e7ff" };
  }
  if (top && top.toLowerCase() === ROLE_EMPLOYEE) {
    return { label: "Employee", color: "#0f5132", background: "#d7f0e2" };
  }
  return { label: "Guest", color: "#5a6478", background: "#eceef4" };
}

/**
 * Defense-in-depth role gate for a tool. A tool is role-permitted when the caller
 * holds one of the roles the scope catalog lists in `defaultForRoles` (the admin
 * role is treated as a superuser). This is enforced ALONGSIDE the scope check —
 * both the agent sandbox and the MCP server call it — so that a scope FusionAuth
 * mis-issues to the wrong role (e.g. an employee somehow carrying
 * `tools:payroll.read`) still can't unlock the tool. The scope alone is not
 * sufficient; the role must also allow it.
 */
export function rolesAllowTool(roles: string[], tool: ToolName): boolean {
  if (isAdmin(roles)) return true; // admin is the superuser
  const allowed = definitionForTool(tool)?.defaultForRoles ?? [];
  return allowed.some((r) => hasRole(roles, r));
}

/** The roles permitted to use a tool — for trace/reply messaging. */
export function rolesForTool(tool: ToolName): string[] {
  return definitionForTool(tool)?.defaultForRoles ?? [];
}
