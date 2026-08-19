import {
  ORG_ID,
  ORG_NAME,
  TEAMS,
  EMPLOYEES,
  KB_SPACES,
  KB_DOCS,
  teamName,
  kbSpaceName,
  employeeName,
} from "@/lib/org-graph";
import { isAdmin, primaryAgentRole } from "@/lib/roles";

/**
 * Every FusionAuth FGA (Permify) call for InFusion Agent lives in this one file —
 * the THIRD authorization layer, and the only one that can answer a question about a
 * specific resource.
 *
 * Where the other layers sit:
 *   - lib/scopes.ts + lib/roles.ts — the coarse, per-CLASS question ("may this agent
 *     use the payroll tool at all?"), asked twice: once by the agent's sandbox
 *     (lib/agent.ts) and once, independently, inside the MCP resource server
 *     (lib/mcp-server.ts).
 *   - THIS FILE — the fine-grained, per-RESOURCE question ("whose payroll? whose PTO?
 *     which documents?"). Those answers depend on a RELATIONSHIP, which no scope
 *     string can express, so they're modelled as a Permify ReBAC schema
 *     (permify/schema.perm) and answered by real relation-tuple writes and permission
 *     checks against a running Permify server.
 *
 * The layers are complementary, not redundant: scope decides whether the tool may run,
 * FGA decides what it may touch. A manager passes the scope check, the role check AND
 * the step-up check, and can still be refused PTO access to somebody on another team.
 *
 * Talking to Permify: the REST surface (Permify v1.7.x), against a self-hosted
 * open-source server (Docker for local dev; FGA provisioning hosted inside FusionAuth
 * needs the Enterprise plan). Endpoints used:
 *   POST /v1/tenants/{tenant}/schemas/write            — load the schema
 *   POST /v1/tenants/{tenant}/data/write               — write relation tuples
 *   POST /v1/tenants/{tenant}/data/delete              — delete relation tuples
 *   POST /v1/tenants/{tenant}/data/relationships/read  — list relation tuples
 *   POST /v1/tenants/{tenant}/permissions/check        — cascade-aware check
 *
 * Fallback, the same honest-degrade convention the rest of this app uses for optional
 * services: when the Permify server can't be reached, every function below degrades to
 * an in-memory tuple store with an app-code cascade resolver, and the UI says so
 * (components/FgaModeBanner.tsx). That fallback is the ONLY place a cascade is walked
 * in app code — exactly the thing FGA exists to replace. When Permify is live,
 * `lastFgaMode()` reports "live" and no traversal happens here at all.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const permifyConfig = {
  /** Permify REST base URL. Default is the open-source server's REST port. */
  get baseUrl() {
    return (process.env.PERMIFY_URL || "http://localhost:3476").replace(/\/$/, "");
  },
  /** Tenant id. Permify ships a pre-inserted `t1` for single-tenant use. */
  get tenant() {
    return process.env.PERMIFY_TENANT || "t1";
  },
  /**
   * Optional bearer token. The open-source server runs auth-less by default;
   * FusionAuth-hosted / secured deployments want a pre-shared key here.
   */
  get token() {
    return process.env.PERMIFY_TOKEN || "";
  },
  /** Network timeout — a demo shouldn't hang a chat turn when Permify is down. */
  get timeoutMs() {
    return Number(process.env.PERMIFY_TIMEOUT_MS) || 2500;
  },
};

// Entity types & relations, named once so a typo can't drift between the schema and
// the calls. These MUST match permify/schema.perm.
export const ENTITY = {
  user: "user",
  organization: "organization",
  team: "team",
  employee: "employee",
  kbSpace: "kb_space",
  kbDoc: "kb_doc",
} as const;

export const ORG_RELATION = { hr: "hr", itAdmin: "it_admin" } as const;
export const TEAM_RELATION = { org: "org", manager: "manager", member: "member" } as const;
export const EMPLOYEE_RELATION = { team: "team" } as const;
export const SPACE_RELATION = { team: "team", reader: "reader" } as const;
export const DOC_RELATION = { space: "space", reader: "reader" } as const;

/** The permissions the schema defines, named once for the same reason. */
export const PERMISSION = {
  viewPayroll: "view_payroll",
  managePeople: "manage_people",
  readSpace: "read_space",
  adjustPto: "adjust_pto",
  read: "read",
  allTeams: "all_teams",
} as const;

interface EntityRef {
  type: string;
  id: string;
}
interface SubjectRef {
  type: string;
  id: string;
  relation?: string;
}
export interface RelationTuple {
  entity: EntityRef;
  relation: string;
  subject: SubjectRef;
}

// ---------------------------------------------------------------------------
// The schema — the same declarations as permify/schema.perm, which carries the
// long-form prose comments. Keep the two in sync.
// ---------------------------------------------------------------------------

export const AGENT_SCHEMA = `entity user {}

entity organization {
  relation hr @user
  relation it_admin @user

  permission all_teams = hr or it_admin
}

entity team {
  relation org @organization

  relation manager @user
  relation member @user

  permission view_payroll  = manager or org.hr
  permission manage_people = manager or org.hr
  permission read_space    = member or manager or org.all_teams
}

entity employee {
  relation team @team

  permission adjust_pto = team.manage_people
}

entity kb_space {
  relation team @team
  relation reader @user

  permission read = reader or team.read_space
}

entity kb_doc {
  relation space @kb_space
  relation reader @user

  permission read = reader or space.read
}
`;

// ---------------------------------------------------------------------------
// Mode tracking — "live" (talking to a real Permify server) vs "demo" (the
// in-memory fallback). The chat + admin pages read this for the honest banner.
// ---------------------------------------------------------------------------

export type FgaMode = "live" | "demo";

const globalForMode = globalThis as unknown as { __infusionAgentFgaMode?: FgaMode };

function markMode(mode: FgaMode) {
  globalForMode.__infusionAgentFgaMode = mode;
}

/**
 * The mode the LAST FGA operation resolved in. Defaults to "demo" before any call has
 * run; callers do a real operation (`ensureFgaBootstrap` / `syncUserFga`) first, so by
 * render time this reflects reality.
 */
export function lastFgaMode(): FgaMode {
  return globalForMode.__infusionAgentFgaMode ?? "demo";
}

// ---------------------------------------------------------------------------
// Low-level REST client
// ---------------------------------------------------------------------------

function endpoint(path: string): string {
  return `${permifyConfig.baseUrl}/v1/tenants/${permifyConfig.tenant}/${path}`;
}

/** POSTs to a Permify endpoint. Throws on network failure, timeout, or non-2xx. */
async function permifyPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), permifyConfig.timeoutMs);
  try {
    const res = await fetch(endpoint(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(permifyConfig.token
          ? { Authorization: `Bearer ${permifyConfig.token}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Permify ${path} -> ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a live Permify operation, falling back to the in-memory demo implementation
 * when the server can't be reached (or the schema isn't loaded yet, etc.). Records
 * which path was taken so the UI can be honest about it. Any thrown error routes to
 * demo — appropriate for a demo app whose whole point survives without a live server.
 */
async function withFallback<T>(live: () => Promise<T>, demo: () => T): Promise<T> {
  try {
    const value = await live();
    markMode("live");
    return value;
  } catch {
    markMode("demo");
    return demo();
  }
}

// ---------------------------------------------------------------------------
// In-memory demo tuple store + app-code cascade resolver (the fallback).
// ---------------------------------------------------------------------------

const globalForDemo = globalThis as unknown as {
  __infusionAgentFgaTuples?: Set<string>;
};
function demoTuples(): Set<string> {
  if (!globalForDemo.__infusionAgentFgaTuples) {
    globalForDemo.__infusionAgentFgaTuples = new Set();
  }
  return globalForDemo.__infusionAgentFgaTuples;
}

function tupleKey(t: RelationTuple): string {
  return `${t.entity.type}:${t.entity.id}#${t.relation}@${t.subject.type}:${t.subject.id}`;
}

function demoWrite(tuples: RelationTuple[]): void {
  const store = demoTuples();
  for (const t of tuples) store.add(tupleKey(t));
}

function demoDelete(filter: RelationTuple): void {
  demoTuples().delete(tupleKey(filter));
}

/** Does the demo store hold this exact tuple? */
function demoHas(
  entityType: string,
  entityId: string,
  relation: string,
  subjectType: string,
  subjectId: string
): boolean {
  return demoTuples().has(
    `${entityType}:${entityId}#${relation}@${subjectType}:${subjectId}`
  );
}

/** The id of the single entity `entityType:entityId` points at through `relation`. */
function demoRelated(
  entityType: string,
  entityId: string,
  relation: string,
  subjectType: string
): string | undefined {
  const prefix = `${entityType}:${entityId}#${relation}@${subjectType}:`;
  for (const key of demoTuples()) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return undefined;
}

/**
 * The app-code cascade resolver — the thing Permify replaces, and the only traversal
 * in this codebase. It walks employee → team → organization (and kb_doc → kb_space →
 * team → organization) by hand, mirroring permify/schema.perm exactly. Only ever runs
 * in demo mode; keep it in step with the schema or the fallback will lie.
 */
function demoCheck(
  entityType: string,
  entityId: string,
  permission: string,
  userId: string
): boolean {
  const u = ENTITY.user;

  if (entityType === ENTITY.organization) {
    const hr = demoHas(entityType, entityId, ORG_RELATION.hr, u, userId);
    const itAdmin = demoHas(entityType, entityId, ORG_RELATION.itAdmin, u, userId);
    if (permission === ORG_RELATION.hr) return hr;
    if (permission === ORG_RELATION.itAdmin) return itAdmin;
    if (permission === PERMISSION.allTeams) return hr || itAdmin;
    return false;
  }

  if (entityType === ENTITY.team) {
    const manager = demoHas(entityType, entityId, TEAM_RELATION.manager, u, userId);
    const member = demoHas(entityType, entityId, TEAM_RELATION.member, u, userId);
    const orgId = demoRelated(
      entityType,
      entityId,
      TEAM_RELATION.org,
      ENTITY.organization
    );
    const orgHr = orgId
      ? demoCheck(ENTITY.organization, orgId, ORG_RELATION.hr, userId)
      : false;
    const orgAllTeams = orgId
      ? demoCheck(ENTITY.organization, orgId, PERMISSION.allTeams, userId)
      : false;
    if (permission === PERMISSION.viewPayroll) return manager || orgHr;
    if (permission === PERMISSION.managePeople) return manager || orgHr;
    if (permission === PERMISSION.readSpace) return member || manager || orgAllTeams;
    return false;
  }

  if (entityType === ENTITY.employee) {
    const teamId = demoRelated(
      entityType,
      entityId,
      EMPLOYEE_RELATION.team,
      ENTITY.team
    );
    if (permission === PERMISSION.adjustPto) {
      return teamId
        ? demoCheck(ENTITY.team, teamId, PERMISSION.managePeople, userId)
        : false;
    }
    return false;
  }

  if (entityType === ENTITY.kbSpace) {
    if (permission !== PERMISSION.read) return false;
    if (demoHas(entityType, entityId, SPACE_RELATION.reader, u, userId)) return true;
    const teamId = demoRelated(entityType, entityId, SPACE_RELATION.team, ENTITY.team);
    return teamId
      ? demoCheck(ENTITY.team, teamId, PERMISSION.readSpace, userId)
      : false;
  }

  if (entityType === ENTITY.kbDoc) {
    if (permission !== PERMISSION.read) return false;
    if (demoHas(entityType, entityId, DOC_RELATION.reader, u, userId)) return true;
    const spaceId = demoRelated(
      entityType,
      entityId,
      DOC_RELATION.space,
      ENTITY.kbSpace
    );
    return spaceId
      ? demoCheck(ENTITY.kbSpace, spaceId, PERMISSION.read, userId)
      : false;
  }

  return false;
}

/** Demo equivalent of a relationships read, filtered by entity + relation. */
function demoRead(
  entityType: string,
  entityId: string,
  relation: string
): string[] {
  const prefix = `${entityType}:${entityId}#${relation}@${ENTITY.user}:`;
  const out: string[] = [];
  for (const key of demoTuples()) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Primitive operations (write / delete / read / check) — live + fallback.
// ---------------------------------------------------------------------------

/** Writes relation tuples. Idempotent — re-writing the same tuple is a no-op. */
export async function writeTuples(tuples: RelationTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  await withFallback(
    async () => {
      await permifyPost("data/write", {
        metadata: { schema_version: "" },
        tuples,
      });
    },
    () => demoWrite(tuples)
  );
}

/**
 * Deletes one relation tuple (used by the /admin revoke path).
 *
 * Note the `attribute_filter`: Permify's DataDelete request REQUIRES it even when
 * you're only deleting relation tuples and have no attributes at all. Omit it and the
 * server answers 400 ("invalid DataDeleteRequest.AttributeFilter: value is required"),
 * which withFallback would silently treat as "server unreachable" — the revoke would
 * appear to work while only ever touching the in-memory store.
 */
export async function deleteTuple(tuple: RelationTuple): Promise<void> {
  await withFallback(
    async () => {
      await permifyPost("data/delete", {
        tuple_filter: {
          entity: { type: tuple.entity.type, ids: [tuple.entity.id] },
          relation: tuple.relation,
          subject: {
            type: tuple.subject.type,
            ids: [tuple.subject.id],
            relation: tuple.subject.relation ?? "",
          },
        },
        attribute_filter: {
          entity: { type: tuple.entity.type, ids: [tuple.entity.id] },
          attributes: [],
        },
      });
    },
    () => demoDelete(tuple)
  );
}

/**
 * The cascade-aware permission check — the heart of the FGA layer. `entity` +
 * `permission` + `subject`, answered by Permify's PermissionService. No app-code
 * traversal on the live path: the schema's `org.hr` / `team.manage_people` /
 * `space.read` do the reaching-through.
 */
export async function check(
  entity: EntityRef,
  permission: string,
  subjectUserId: string
): Promise<boolean> {
  if (!subjectUserId) return false;
  return withFallback(
    async () => {
      const res = await permifyPost<{ can?: string }>("permissions/check", {
        metadata: { snap_token: "", schema_version: "", depth: 20 },
        entity,
        permission,
        subject: { type: ENTITY.user, id: subjectUserId },
      });
      // v1.7.x returns "CHECK_RESULT_ALLOWED"; older builds "RESULT_ALLOWED".
      return (res.can ?? "").includes("ALLOWED");
    },
    () => demoCheck(entity.type, entity.id, permission, subjectUserId)
  );
}

/** Lists the user ids holding one relation directly on one entity. */
export async function readEntityRelation(
  entityType: string,
  entityId: string,
  relation: string
): Promise<string[]> {
  return withFallback(
    async () => {
      const res = await permifyPost<{ tuples?: { subject?: SubjectRef }[] }>(
        "data/relationships/read",
        {
          metadata: { snap_token: "" },
          filter: {
            entity: { type: entityType, ids: [entityId] },
            relation,
            subject: { type: ENTITY.user, ids: [], relation: "" },
          },
        }
      );
      return (res.tuples ?? [])
        .map((t) => t.subject?.id ?? "")
        .filter((id) => id !== "");
    },
    () => demoRead(entityType, entityId, relation)
  );
}

// ---------------------------------------------------------------------------
// The decision record — what the authorization trace renders.
// ---------------------------------------------------------------------------

/** One resolved FGA question, named the way the schema names it. */
export interface FgaCheck {
  /** "team:platform", "employee:chen-li", … */
  entity: string;
  /** "view_payroll", "adjust_pto", "read", … */
  permission: string;
  allowed: boolean;
}

/**
 * The FGA decisions behind one tool call. Tools return this alongside their data so
 * `/api/chat` can put the exact tuples that decided the turn into the live trace
 * instead of hand-waving about "permissions".
 */
export interface FgaReport {
  mode: FgaMode;
  checks: FgaCheck[];
  /** Set when FGA narrowed a list rather than allowing or denying outright. */
  filtered?: { visible: number; total: number; unit: string };
}

async function recordedCheck(
  entityType: string,
  entityId: string,
  permission: string,
  userId: string
): Promise<FgaCheck> {
  const allowed = await check({ type: entityType, id: entityId }, permission, userId);
  return { entity: `${entityType}:${entityId}`, permission, allowed };
}

// ---------------------------------------------------------------------------
// Domain helpers — what the MCP tools and the agent sandbox actually call.
// ---------------------------------------------------------------------------

/**
 * Which payroll teams may this user read? One `team#view_payroll` check per team, run
 * concurrently. A team manager gets their own team; an org `hr` grant cascades to all
 * of them with no per-team tuple; an `it_admin` gets none (running IT doesn't make
 * payroll your business — see the schema).
 */
export async function visiblePayrollTeams(
  userId: string
): Promise<{ teamIds: string[]; report: FgaReport }> {
  const checks = await Promise.all(
    TEAMS.map((team) =>
      recordedCheck(ENTITY.team, team.id, PERMISSION.viewPayroll, userId)
    )
  );
  const teamIds = TEAMS.filter((_, i) => checks[i].allowed).map((t) => t.id);
  return {
    teamIds,
    report: {
      mode: lastFgaMode(),
      checks,
      filtered: { visible: teamIds.length, total: TEAMS.length, unit: "teams" },
    },
  };
}

/**
 * May this user adjust that employee's PTO? Two hops in the schema (employee → team →
 * manager | org.hr), one call here. Used BOTH by the agent's sandbox pre-check
 * (lib/agent.ts) and by the MCP tool itself (lib/mcp-server.ts) — the same
 * defense-in-depth shape the scope + role checks already use.
 */
export async function canAdjustPto(
  userId: string,
  employeeId: string
): Promise<{ allowed: boolean; report: FgaReport }> {
  const result = await recordedCheck(
    ENTITY.employee,
    employeeId,
    PERMISSION.adjustPto,
    userId
  );
  return {
    allowed: result.allowed,
    report: { mode: lastFgaMode(), checks: [result] },
  };
}

/**
 * Document-level ACLs for the RAG retriever: given the article ids that survived the
 * scope filter, which may this user actually read? Only FGA-governed docs are checked
 * — a `public` article carries no `kb_doc` entity and is never asked about.
 */
export async function readableDocIds(
  userId: string,
  docIds: string[]
): Promise<{ readable: string[]; report: FgaReport }> {
  const governed = docIds.filter((id) => KB_DOCS.some((d) => d.id === id));
  const checks = await Promise.all(
    governed.map((id) => recordedCheck(ENTITY.kbDoc, id, PERMISSION.read, userId))
  );
  const denied = new Set(
    checks.filter((c) => !c.allowed).map((c) => c.entity.split(":")[1])
  );
  const readable = docIds.filter((id) => !denied.has(id));
  return {
    readable,
    report: {
      mode: lastFgaMode(),
      checks,
      filtered: {
        visible: readable.length,
        total: docIds.length,
        unit: "documents",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap & seeding — makes the demo "just work" the moment Permify is up.
// ---------------------------------------------------------------------------

const globalForBoot = globalThis as unknown as {
  __infusionAgentFgaBootstrapped?: boolean;
  __infusionAgentFgaSeededUsers?: Set<string>;
};

/**
 * The STRUCTURAL tuples: the shape of the company, independent of any user. These are
 * what the cascade reaches through — write `employee:chen-li#team@team:it` once and
 * every manager/HR check for Chen Li flows through it forever.
 */
function structuralTuples(): RelationTuple[] {
  return [
    ...TEAMS.map((team) => ({
      entity: { type: ENTITY.team, id: team.id },
      relation: TEAM_RELATION.org,
      subject: { type: ENTITY.organization, id: ORG_ID },
    })),
    ...EMPLOYEES.map((employee) => ({
      entity: { type: ENTITY.employee, id: employee.id },
      relation: EMPLOYEE_RELATION.team,
      subject: { type: ENTITY.team, id: employee.teamId },
    })),
    ...KB_SPACES.map((space) => ({
      entity: { type: ENTITY.kbSpace, id: space.id },
      relation: SPACE_RELATION.team,
      subject: { type: ENTITY.team, id: space.teamId },
    })),
    ...KB_DOCS.map((doc) => ({
      entity: { type: ENTITY.kbDoc, id: doc.id },
      relation: DOC_RELATION.space,
      subject: { type: ENTITY.kbSpace, id: doc.spaceId },
    })),
  ];
}

/**
 * Loads the schema and writes the structural tuples, once per process. In live mode
 * this POSTs to Permify; in demo mode it seeds the same links into the in-memory store
 * so the fallback resolver has something to reach through. Idempotent.
 */
async function bootstrap(): Promise<void> {
  if (globalForBoot.__infusionAgentFgaBootstrapped) return;

  // The schema write is live-only; the demo store needs no schema. Failure here
  // (server down) just leaves us in demo mode for everything else.
  await withFallback(
    async () => {
      await permifyPost("schemas/write", { schema: AGENT_SCHEMA });
    },
    () => undefined
  );

  await writeTuples(structuralTuples());

  globalForBoot.__infusionAgentFgaBootstrapped = true;
}

/**
 * Whether demo seeding is enabled. Once you're managing relations by hand in /admin,
 * set INFUSIONAGENT_SEED_DEMO=false so nothing competes with your edits.
 */
function demoSeedEnabled(): boolean {
  const raw = (process.env.INFUSIONAGENT_SEED_DEMO ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

/** The four seed personas, chosen from the user's verified FusionAuth roles. */
export type SeedRole = "employee" | "manager" | "it-admin" | "admin";

/** Maps verified token roles to the seed persona whose relations tell the best story. */
export function seedRoleFor(roles: string[]): SeedRole {
  if (isAdmin(roles)) return "admin";
  return primaryAgentRole(roles) ?? "employee";
}

/**
 * The demo relations for each persona. Deliberately NOT "everyone gets everything":
 * each one is a different point on the cascade, so the same question gets a different
 * FGA answer depending on who's asking.
 *
 *   employee  team:platform#member          → public docs only (no space maps to Platform),
 *                                             no payroll, no PTO. The floor of the demo.
 *   manager   team:platform#manager         → Platform payroll + PTO for Platform staff…
 *                                             and a DENIAL for anyone on another team,
 *                                             after scope, role AND step-up all passed.
 *   it-admin  team:it#manager
 *             organization:infusion#it_admin → reads every team's space, still no payroll.
 *   admin     organization:infusion#hr      → one org tuple cascades to every team and
 *                                             every employee. No per-team grants at all.
 */
function seedTuplesFor(userId: string, role: SeedRole): RelationTuple[] {
  const onTeam = (teamId: string, relation: string): RelationTuple => ({
    entity: { type: ENTITY.team, id: teamId },
    relation,
    subject: { type: ENTITY.user, id: userId },
  });
  const onOrg = (relation: string): RelationTuple => ({
    entity: { type: ENTITY.organization, id: ORG_ID },
    relation,
    subject: { type: ENTITY.user, id: userId },
  });

  switch (role) {
    case "manager":
      return [onTeam("platform", TEAM_RELATION.manager)];
    case "it-admin":
      return [onTeam("it", TEAM_RELATION.manager), onOrg(ORG_RELATION.itAdmin)];
    case "admin":
      return [onOrg(ORG_RELATION.hr)];
    case "employee":
    default:
      return [onTeam("platform", TEAM_RELATION.member)];
  }
}

/** Every relation a user could hold, for the "is this user brand new?" test. */
function allUserRelationSlots(): { entityType: string; entityId: string; relation: string }[] {
  return [
    ...Object.values(ORG_RELATION).map((relation) => ({
      entityType: ENTITY.organization,
      entityId: ORG_ID,
      relation,
    })),
    ...TEAMS.flatMap((team) =>
      [TEAM_RELATION.manager, TEAM_RELATION.member].map((relation) => ({
        entityType: ENTITY.team,
        entityId: team.id,
        relation,
      }))
    ),
    ...KB_SPACES.map((space) => ({
      entityType: ENTITY.kbSpace,
      entityId: space.id,
      relation: SPACE_RELATION.reader,
    })),
    ...KB_DOCS.map((doc) => ({
      entityType: ENTITY.kbDoc,
      entityId: doc.id,
      relation: DOC_RELATION.reader,
    })),
  ];
}

/**
 * True when the user already holds ANY relation anywhere. Read live from Permify — it's
 * how we tell a genuinely NEW user (who should get the demo seed) from one whose
 * relations are being managed deliberately (who must NOT be re-seeded). This is what
 * stops a grant revoked in /admin from silently coming back on the next page load.
 */
async function userHasAnyRelation(userId: string): Promise<boolean> {
  const results = await Promise.all(
    allUserRelationSlots().map((slot) =>
      readEntityRelation(slot.entityType, slot.entityId, slot.relation)
    )
  );
  return results.some((ids) => ids.includes(userId));
}

/**
 * Seeds the demo relations for a brand-new signed-in user, so the FGA layer is
 * immediately demonstrable for whoever logs in without hand-writing tuples first.
 *
 * IMPORTANT: seeding only runs for a user who currently has NO relations at all. The
 * moment a user has any relation — including after you edit them in /admin — this is a
 * no-op, so a removed grant will NOT be re-applied on the next page load or after a
 * restart. Disable it entirely with INFUSIONAGENT_SEED_DEMO=false.
 *
 * (Editing the seed does not remove tuples already written to Permify in a prior
 * session — those persist. Remove them from /admin, or reset your Permify instance.)
 */
async function seedDemoGraphForUser(userId: string, role: SeedRole): Promise<void> {
  if (!globalForBoot.__infusionAgentFgaSeededUsers) {
    globalForBoot.__infusionAgentFgaSeededUsers = new Set();
  }
  const seeded = globalForBoot.__infusionAgentFgaSeededUsers;
  if (seeded.has(userId)) return;
  // Mark first so the (relatively expensive) relation scan runs at most once per user
  // per process, even under concurrent requests.
  seeded.add(userId);

  if (!demoSeedEnabled()) return;
  if (await userHasAnyRelation(userId)) return;

  await writeTuples(seedTuplesFor(userId, role));
}

/**
 * Called before a turn or a page render that will make FGA decisions: makes sure the
 * schema + structural tuples are loaded and this user has their demo relations.
 * Returns the resolved mode, for the banner.
 */
export async function syncUserFga(
  userId: string,
  roles: string[]
): Promise<FgaMode> {
  await bootstrap();
  await seedDemoGraphForUser(userId, seedRoleFor(roles));
  return lastFgaMode();
}

/**
 * Ensures the schema + structural tuples are loaded WITHOUT seeding any user's demo
 * relations. Used by the /admin write path: granting a relation to a user must never
 * also seed that user (which would hand them the demo tuples too).
 */
export async function ensureFgaBootstrap(): Promise<FgaMode> {
  await bootstrap();
  return lastFgaMode();
}

// ---------------------------------------------------------------------------
// Admin relationship management — assign/revoke ANY relation on ANY entity, and
// read the whole relationship table. Used by the role-gated /admin section.
// ---------------------------------------------------------------------------

export type FgaEntityType = "organization" | "team" | "kb_space" | "kb_doc";

/** The relations an admin may grant on each entity type, per the schema. */
export const VALID_RELATIONS: Record<FgaEntityType, string[]> = {
  organization: [ORG_RELATION.hr, ORG_RELATION.itAdmin],
  team: [TEAM_RELATION.manager, TEAM_RELATION.member],
  kb_space: [SPACE_RELATION.reader],
  kb_doc: [DOC_RELATION.reader],
};

/**
 * The structural relations (`team#org`, `employee#team`, `kb_space#team`,
 * `kb_doc#space`) are deliberately absent above: they describe the company's shape,
 * not who may do what, and they point at other entities rather than users. Only
 * user-subject relations are grantable from /admin.
 */
export function isValidRelation(
  entityType: string,
  relation: string
): entityType is FgaEntityType {
  return (
    (entityType === "organization" ||
      entityType === "team" ||
      entityType === "kb_space" ||
      entityType === "kb_doc") &&
    VALID_RELATIONS[entityType].includes(relation)
  );
}

/** Display name for an entity, or null when we don't know it (so callers can 400). */
export function entityLabel(entityType: string, entityId: string): string | null {
  if (entityType === "organization") return entityId === ORG_ID ? ORG_NAME : null;
  if (entityType === "team") return teamName(entityId) ?? null;
  if (entityType === "kb_space") return kbSpaceName(entityId) ?? null;
  if (entityType === "kb_doc") {
    return KB_DOCS.find((d) => d.id === entityId)?.title ?? null;
  }
  if (entityType === "employee") return employeeName(entityId) ?? null;
  return null;
}

export interface FgaEntityOption {
  entityType: FgaEntityType;
  entityId: string;
  label: string;
  relations: string[];
}

/** Every entity an admin can grant on, for the /admin picker. */
export function fgaEntityOptions(): FgaEntityOption[] {
  return [
    {
      entityType: "organization",
      entityId: ORG_ID,
      label: ORG_NAME,
      relations: VALID_RELATIONS.organization,
    },
    ...TEAMS.map((team) => ({
      entityType: "team" as const,
      entityId: team.id,
      label: team.name,
      relations: VALID_RELATIONS.team,
    })),
    ...KB_SPACES.map((space) => ({
      entityType: "kb_space" as const,
      entityId: space.id,
      label: space.name,
      relations: VALID_RELATIONS.kb_space,
    })),
    ...KB_DOCS.map((doc) => ({
      entityType: "kb_doc" as const,
      entityId: doc.id,
      label: doc.title,
      relations: VALID_RELATIONS.kb_doc,
    })),
  ];
}

/** Grants a relation to a user — writes a live Permify tuple. Validated caller-side. */
export async function assignRelation(
  entityType: FgaEntityType,
  entityId: string,
  relation: string,
  userId: string
): Promise<void> {
  await writeTuples([
    {
      entity: { type: entityType, id: entityId },
      relation,
      subject: { type: ENTITY.user, id: userId },
    },
  ]);
}

/** Revokes a relation from a user — deletes the Permify tuple. */
export async function unassignRelation(
  entityType: FgaEntityType,
  entityId: string,
  relation: string,
  userId: string
): Promise<void> {
  await deleteTuple({
    entity: { type: entityType, id: entityId },
    relation,
    subject: { type: ENTITY.user, id: userId },
  });
}

export interface EntityRelationRow {
  relation: string;
  userIds: string[];
}
export interface EntityRelationships {
  entityType: FgaEntityType;
  entityId: string;
  label: string;
  rows: EntityRelationRow[];
}

/**
 * The full relationship table across every grantable entity, read live from Permify —
 * the admin's view of "who has what, everywhere". Returns raw user ids; /admin resolves
 * them to emails with the roster it already fetches.
 */
export async function relationshipTable(): Promise<EntityRelationships[]> {
  return Promise.all(
    fgaEntityOptions().map(async (option) => ({
      entityType: option.entityType,
      entityId: option.entityId,
      label: option.label,
      rows: await Promise.all(
        option.relations.map(async (relation) => ({
          relation,
          userIds: await readEntityRelation(
            option.entityType,
            option.entityId,
            relation
          ),
        }))
      ),
    }))
  );
}
