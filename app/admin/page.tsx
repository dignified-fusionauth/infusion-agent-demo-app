import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import NonHumanIdentityCard from "@/components/NonHumanIdentityCard";
import AccountLinks from "@/components/AccountLinks";
import FgaModeBanner from "@/components/FgaModeBanner";
import FgaSchemaViewer from "@/components/FgaSchemaViewer";
import FgaRelationshipAdmin, {
  type FgaEntityChoice,
  type FgaEntityRow,
} from "@/components/FgaRelationshipAdmin";
import { getSession } from "@/lib/session";
import { isAdmin, primaryRoleBadge } from "@/lib/roles";
import {
  getMcpServiceIdentity,
  searchTenantUsers,
  accountManagementUrl,
  twoFactorManagementUrl,
} from "@/lib/fusionauth";
import { SCOPE_CATALOG } from "@/lib/scopes";
import { unsupportedScopeIds } from "@/lib/bff";
import {
  AGENT_SCHEMA,
  ensureFgaBootstrap,
  fgaEntityOptions,
  relationshipTable,
} from "@/lib/fga";

export const dynamic = "force-dynamic";

/**
 * Admin console. proxy.ts only checks the session cookie is present; the real
 * gate is HERE, off the verified access-token `roles` claim — a signed-in
 * non-admin is bounced to /chat. Shows the canonical scope catalog, the two
 * FusionAuth identities (the user-login Application vs. the MCP tool server's own
 * Client-Credentials Entity), which demo users hold which roles, and the FGA
 * relationship graph those scopes are layered on top of.
 *
 * The FGA section is where the two halves of the platform meet: an Application ROLE
 * gates this page, and what you edit inside it are Permify RELATIONS. Revoke a relation
 * here and the next chat turn changes — same token, same scopes, different answer.
 */
export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/admin");
  if (!isAdmin(session.roles)) redirect("/chat");

  // All degrade honestly: null identity → "not connected"; null roster → "unavailable";
  // unreachable Permify → the in-memory fallback plus a banner that says so.
  const [mcp, users, fgaMode] = await Promise.all([
    getMcpServiceIdentity(),
    searchTenantUsers(),
    // Bootstrap only — never seed from /admin, or opening this page would hand the
    // viewer the demo relations for their role.
    ensureFgaBootstrap(),
  ]);
  const fgaTable = await relationshipTable();
  // Scopes this FusionAuth Application turned out not to define. The login learned it the
  // hard way (see lib/bff.ts) and dropped them; saying so here is how a setup gap gets
  // noticed instead of quietly disabling a tool.
  const missingScopes = new Set(unsupportedScopeIds());

  // Resolve raw Permify subject ids to something human, reusing the roster this page
  // already fetched. An id with no match still renders — as itself.
  const nameById = new Map(
    (users ?? []).map((u) => [u.id, u.name || u.email || u.id])
  );
  const fgaEntities: FgaEntityChoice[] = fgaEntityOptions().map((o) => ({
    type: o.entityType,
    id: o.entityId,
    label: o.label,
    relations: o.relations,
  }));
  const fgaRows: FgaEntityRow[] = fgaTable.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    label: row.label,
    groups: row.rows.map((r) => ({
      relation: r.relation,
      members: r.userIds.map((id) => ({
        userId: id,
        label: nameById.get(id) ?? id,
      })),
    })),
  }));

  return (
    <Shell session={session}>
      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink font-[family-name:var(--font-display)]">
          Admin console
        </h1>
        <p className="mt-2 text-ink-soft">
          You see this because your access token carries the admin role. Below:
          the scope catalog every layer reads from, the two FusionAuth identities
          behind this demo (a user-login Application and a Client-Credentials
          Entity), and the demo users&rsquo; roles.
        </p>
      </div>

      {/* Scope catalog */}
      <section className="mt-8 overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="border-b border-line px-5 py-3">
          <h2 className="font-bold text-ink font-[family-name:var(--font-display)]">
            Scope catalog
          </h2>
          <p className="text-sm text-ink-soft">
            One source of truth (<code className="font-[family-name:var(--font-mono)] text-xs">lib/scopes.ts</code>)
            used by login (which scopes to request), the sandbox pre-check, and
            the MCP server. A tool needs its scope <em>and</em> an allowed role.
            {missingScopes.size > 0 ? (
              <>
                {" "}
                A scope marked <em>not on this instance</em> isn&rsquo;t defined on the
                FusionAuth Application, so logins skip it rather than failing outright
                and its tool is denied at the sandbox. Add it under{" "}
                <strong className="text-ink">Applications → OAuth → Scopes</strong>, then
                restart the app.
              </>
            ) : null}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
                <th className="px-5 py-2 font-semibold">Scope</th>
                <th className="px-5 py-2 font-semibold">Unlocks tool</th>
                <th className="px-5 py-2 font-semibold">Consent</th>
                <th className="px-5 py-2 font-semibold">Allowed roles</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {SCOPE_CATALOG.map((s) => (
                <tr key={s.id}>
                  <td className="px-5 py-2">
                    {s.id ? (
                      <code className="text-brand-ink font-[family-name:var(--font-mono)] text-xs">
                        {s.id}
                      </code>
                    ) : (
                      <span
                        className="text-xs text-ink-soft"
                        title="This tool carries no dedicated OAuth scope, so the role gate is the only app-level check. Add tools:docs.read on the Application and set its id in lib/scopes.ts to gate it on egress consent instead."
                      >
                        — none · role-gated
                      </span>
                    )}
                    {s.id && missingScopes.has(s.id) ? (
                      <span
                        className="ml-2 rounded-full bg-signal-soft px-2 py-0.5 text-[0.65rem] font-semibold text-signal-ink"
                        title="This Application doesn't define the scope, so logins skip it and the tool is denied at the sandbox. Add it under FusionAuth → Applications → OAuth → Scopes, then restart the app."
                      >
                        not on this instance
                      </span>
                    ) : null}
                  </td>
                  <td className="px-5 py-2 font-[family-name:var(--font-mono)] text-xs text-ink">
                    {s.tool}
                  </td>
                  <td className="px-5 py-2">
                    {s.requiresConsent ? (
                      <span className="rounded-full bg-signal-soft px-2 py-0.5 text-xs font-semibold text-signal-ink">
                        required
                      </span>
                    ) : (
                      <span className="text-xs text-ink-soft">no</span>
                    )}
                  </td>
                  <td className="px-5 py-2 text-xs text-ink-soft">
                    {s.defaultForRoles.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* The two FusionAuth identities */}
      <section className="mt-6">
        <h2 className="font-bold text-ink font-[family-name:var(--font-display)]">
          Two FusionAuth identities
        </h2>
        <p className="mb-3 text-sm text-ink-soft">
          The human logs in through an <strong className="text-ink">Application</strong>;
          the MCP tool server has its own non-human identity as a
          Client-Credentials <strong className="text-ink">Entity</strong>.
        </p>
        <NonHumanIdentityCard
          user={{
            subject: session.userId,
            name: session.name,
            roles: session.roles,
            scopes: session.scopes,
          }}
          mcp={mcp}
        />
      </section>

      {/* FusionAuth FGA — the resource layer */}
      <section className="mt-8">
        <h2 className="font-bold text-ink font-[family-name:var(--font-display)]">
          FusionAuth FGA (Permify)
        </h2>
        <p className="mb-3 text-sm text-ink-soft">
          Scopes above decide whether a tool may run at all. The relations below decide{" "}
          <em>which</em> resources it may touch — whose payroll, whose PTO, which
          documents. Grant or revoke one and the next chat turn changes, with no new
          token and no scope change.
        </p>
        <div className="space-y-4">
          <FgaModeBanner mode={fgaMode} />
          <FgaSchemaViewer schema={AGENT_SCHEMA} />
          <FgaRelationshipAdmin entities={fgaEntities} initial={fgaRows} />
        </div>
      </section>

      {/* Demo users + roles (a proxy for who can consent to what) */}
      <section className="mt-6 overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="border-b border-line px-5 py-3">
          <h2 className="font-bold text-ink font-[family-name:var(--font-display)]">
            Demo users
          </h2>
          <p className="text-sm text-ink-soft">
            {users === null
              ? "User Search is unavailable on this instance."
              : `${users.length} user${users.length === 1 ? "" : "s"} — a manager or IT-admin can consent to the payroll and PTO scopes.`}
          </p>
        </div>
        {users === null ? (
          <p className="px-5 py-4 text-sm text-ink-soft">
            The User Search API didn&rsquo;t return results — it needs the
            Elasticsearch/OpenSearch backend and an API key with the{" "}
            <code className="font-[family-name:var(--font-mono)] text-xs text-ink">
              /api/user/search
            </code>{" "}
            scope. This is the honest fallback, not a crash.
          </p>
        ) : users.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-soft">No users found yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {users.map((person) => {
              const badge = primaryRoleBadge(person.roles);
              return (
                <li
                  key={person.id}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{person.name}</p>
                    {person.email ? (
                      <p className="truncate text-sm text-ink-soft">
                        {person.email}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    style={{ background: badge.background, color: badge.color }}
                  >
                    {badge.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Hosted account self-service */}
      <section className="mt-6">
        <h2 className="mb-3 font-bold text-ink font-[family-name:var(--font-display)]">
          Your account
        </h2>
        <AccountLinks
          accountUrl={accountManagementUrl()}
          twoFactorUrl={twoFactorManagementUrl()}
        />
      </section>
    </Shell>
  );
}
