/**
 * The canonical scope catalog for InFusion Agent — the ONE source of truth for
 * the tool→scope mapping. It is imported by three places that must never drift
 * apart:
 *
 *   1. Login (lib/bff.ts)      — which custom scopes a role's sign-in requests.
 *   2. The agent sandbox       — the pre-flight check in lib/agent.ts that
 *      (lib/agent.ts)            refuses a tool the user's token can't reach,
 *                                before any MCP call is attempted.
 *   3. The MCP resource server — the INDEPENDENT check inside each tool handler
 *      (lib/mcp-server.ts)       (lib/mcp-auth.ts verifies the token; the tool
 *                                re-checks scope + role). This is the "second,
 *                                real check" — it shares no code path with the sandbox.
 *
 * Enforcement is defense-in-depth: a tool runs only when the verified access
 * token carries the required `scope` (see scopesFromClaims) AND the caller holds
 * an allowed role (`defaultForRoles`, see lib/roles.ts `rolesAllowTool`). Which
 * scopes a role REQUESTS at login is only a UX decision; the scope alone is never
 * sufficient, so a scope FusionAuth mis-issues to the wrong role can't unlock a
 * tool on its own.
 */

/** The FusionAuth Application Roles this app understands, least → most privileged. */
export type AgentRole = "employee" | "manager" | "it-admin";

/**
 * The tools the MCP server exposes: five that reach internal systems on behalf of the
 * signed-in employee, and one — `search_public_docs` — that reaches a third-party MCP
 * server instead. The external one is gated by exactly the same machinery, because
 * "may this agent talk to the outside world" is an authorization question too.
 */
export type ToolName =
  | "search_knowledge_base"
  | "create_it_ticket"
  | "lookup_employee"
  | "view_payroll"
  | "update_pto_balance"
  | "search_public_docs";

export interface ScopeDefinition {
  /**
   * The OAuth scope string, e.g. "tools:payroll.read", or `null` for a tool that needs no
   * dedicated scope and is gated on role alone.
   *
   * `null` exists for a real reason rather than as a loophole: a catalog entry naming a
   * scope the FusionAuth Application doesn't define breaks every login (FusionAuth rejects
   * the whole authorize request — see lib/bff.ts), so a tool must be able to ship without
   * demanding instance configuration. The role gate below still applies, and the MCP
   * server still checks it independently; what's absent is the per-tool consent moment.
   */
  id: string | null;
  /** The MCP tool this scope unlocks. */
  tool: ToolName;
  /** One-line, human-readable summary for the consent preview + /admin catalog. */
  description: string;
  /**
   * Whether FusionAuth is configured to show its hosted consent screen for this
   * scope. The sensitive scopes (payroll / PTO) require the manager to explicitly
   * grant their agent access; the rest are granted silently.
   */
  requiresConsent: boolean;
  /**
   * The roles this scope's tool is for. Two uses: (1) which roles request the
   * scope by default at login, and (2) the enforced role gate — a tool runs only
   * if the caller holds one of these roles (see lib/roles.ts `rolesAllowTool`),
   * defense-in-depth alongside the scope check.
   */
  defaultForRoles: AgentRole[];
}

/** OIDC + refresh scopes every login requests, regardless of role. */
export const OIDC_BASE_SCOPES = ["openid", "offline_access", "email", "profile"];

/**
 * The scope catalog, mirroring the table in the README. Order is the display
 * order in the consent preview and the /admin catalog.
 */
export const SCOPE_CATALOG: ScopeDefinition[] = [
  {
    id: "tools:kb.read",
    tool: "search_knowledge_base",
    description: "Search the internal knowledge base (RAG retrieval).",
    requiresConsent: false,
    defaultForRoles: ["employee", "manager", "it-admin"],
  },
  {
    id: "tools:tickets.write",
    tool: "create_it_ticket",
    description: "Open an IT support ticket on the employee's behalf.",
    requiresConsent: false,
    defaultForRoles: ["employee", "manager", "it-admin"],
  },
  {
    id: "tools:directory.read",
    tool: "lookup_employee",
    description: "Look up a colleague in the employee directory.",
    requiresConsent: false,
    defaultForRoles: ["manager", "it-admin"],
  },
  {
    id: "tools:payroll.read",
    tool: "view_payroll",
    description: "Read payroll figures for the team.",
    requiresConsent: true,
    defaultForRoles: ["manager", "it-admin"],
  },
  {
    id: "tools:pto.write",
    tool: "update_pto_balance",
    description: "Adjust an employee's PTO balance.",
    requiresConsent: true,
    defaultForRoles: ["manager", "it-admin"],
  },
  {
    // Role-gated only, deliberately. The natural design here is a dedicated scope —
    // `tools:docs.read` — because "may this agent send a question outside the company" is
    // an EGRESS decision worth consenting to separately from reading payroll, and it is
    // the one consent prompt in this app that guards no sensitive data at all.
    //
    // It isn't wired that way because a scope in this catalog must exist on the FusionAuth
    // Application or no one can log in, and requiring a config change to make a tool work
    // out of the box is the wrong default for a demo. To restore the egress-consent story:
    // add `tools:docs.read` under Applications → OAuth → Scopes (mark it consent-required),
    // set `id` here to "tools:docs.read", and restart.
    id: null,
    tool: "search_public_docs",
    description:
      "Ask a third-party MCP server about public documentation (leaves the network).",
    requiresConsent: false,
    defaultForRoles: ["employee", "manager", "it-admin"],
  },
];

/** The tools whose execution requires a fresh step-up (two-factor) check. */
export const STEP_UP_TOOLS: ToolName[] = ["view_payroll", "update_pto_balance"];

const BY_TOOL = new Map<ToolName, ScopeDefinition>(
  SCOPE_CATALOG.map((s) => [s.tool, s])
);
const BY_ID = new Map<string, ScopeDefinition>(
  SCOPE_CATALOG.flatMap((s) => (s.id ? [[s.id, s] as const] : []))
);

/**
 * The scope a tool requires — undefined both for an unknown tool name and for a tool that
 * needs no scope at all (see `ScopeDefinition.id`). Callers must treat undefined as "no
 * scope check to run", never as "deny": the role gate is what governs those tools.
 */
export function scopeForTool(tool: ToolName): string | undefined {
  return BY_TOOL.get(tool)?.id ?? undefined;
}

/** The scope definition for a tool, if any. */
export function definitionForTool(tool: ToolName): ScopeDefinition | undefined {
  return BY_TOOL.get(tool);
}

/** The tool a scope unlocks, or undefined for an unknown scope id. */
export function toolForScope(scopeId: string): ToolName | undefined {
  return BY_ID.get(scopeId)?.tool;
}

/** True when a tool needs a step-up (two-factor) check before it runs. */
export function toolRequiresStepUp(tool: ToolName): boolean {
  return STEP_UP_TOOLS.includes(tool);
}

/** The custom tools:* scopes a role requests by default at login (skipping scopeless tools). */
export function defaultToolScopesForRole(role: AgentRole): string[] {
  return SCOPE_CATALOG.flatMap((s) =>
    s.id && s.defaultForRoles.includes(role) ? [s.id] : []
  );
}

/**
 * The full space-delimited scope string a role's login requests: the OIDC base
 * scopes plus that role's default tool scopes. An employee's string never
 * contains `tools:payroll.read`, so FusionAuth's hosted consent screen never even
 * offers it at that role.
 */
export function defaultScopeStringForRole(role: AgentRole): string {
  return [...OIDC_BASE_SCOPES, ...defaultToolScopesForRole(role)].join(" ");
}

/** Case-sensitive membership check against a token's granted scopes. */
export function hasScope(scopes: string[], scopeId: string): boolean {
  return scopes.includes(scopeId);
}

/** The roles this app knows about. */
export const KNOWN_ROLES: AgentRole[] = ["employee", "manager", "it-admin"];

/** Narrows an arbitrary string to a known AgentRole. */
export function isAgentRole(value: string | null | undefined): value is AgentRole {
  return value === "employee" || value === "manager" || value === "it-admin";
}

/**
 * Parses the OAuth `scope` claim off a set of verified token claims. FusionAuth
 * emits it as a single space-delimited string, but we tolerate an array too so a
 * differently-configured tenant still works. Returns [] when absent.
 */
export function scopesFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims.scope ?? claims.scopes;
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s !== "");
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
