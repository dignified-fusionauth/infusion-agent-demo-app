import type { McpServiceIdentity } from "@/lib/fusionauth";

interface UserIdentity {
  subject: string;
  name?: string;
  roles: string[];
  scopes: string[];
}

/**
 * The two identities side by side: the signed-in human's decoded access token
 * (left) and the MCP tool server's own Client Credentials identity (right). This
 * is the "the agent's tools have an identity too, distinct from the user it acts
 * for" point made visible. When the tool-server Entity / Client Credentials
 * grant isn't reachable (Entity Management is a paid feature), the right card
 * shows an honest "not connected" state.
 */
export default function NonHumanIdentityCard({
  user,
  mcp,
}: {
  user: UserIdentity;
  mcp: McpServiceIdentity | null;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Human identity */}
      <div className="rounded-xl border border-line bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-ink">
            human
          </span>
          <h3 className="font-bold text-ink font-[family-name:var(--font-display)]">
            Signed-in user
          </h3>
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="name" value={user.name ?? "—"} />
          <Row label="sub" value={user.subject} mono />
          <Row label="roles" value={user.roles.join(", ") || "—"} />
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-soft">
              granted scopes
            </dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {user.scopes.length === 0 ? (
                <span className="text-ink-soft">none</span>
              ) : (
                user.scopes.map((s) => (
                  <code
                    key={s}
                    className="rounded bg-surface px-1.5 py-0.5 text-xs text-brand-ink font-[family-name:var(--font-mono)]"
                  >
                    {s}
                  </code>
                ))
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* MCP tool server (non-human) identity */}
      <div className="rounded-xl border border-line bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-signal-soft px-2 py-0.5 text-xs font-semibold text-signal-ink">
            non-human
          </span>
          <h3 className="font-bold text-ink font-[family-name:var(--font-display)]">
            MCP tool server
          </h3>
        </div>
        {mcp ? (
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="grant" value="client_credentials" mono />
            <Row label="client_id" value={mcp.clientId} mono />
            <Row label="sub" value={mcp.subject ?? mcp.clientId} mono />
            <Row
              label="scopes"
              value={mcp.scopes.length ? mcp.scopes.join(" ") : "—"}
              mono
            />
            <Row
              label="expires"
              value={
                mcp.expiresAt
                  ? new Date(mcp.expiresAt * 1000).toISOString()
                  : "—"
              }
              mono
            />
          </dl>
        ) : (
          <p className="mt-3 text-sm text-ink-soft">
            Not connected. In FusionAuth the client_credentials grant is{" "}
            <strong className="text-ink">Entity Management</strong> (a paid
            feature), not an Application grant. Create an{" "}
            <strong className="text-ink">Entity</strong> for the tool server,
            then set{" "}
            <code className="font-[family-name:var(--font-mono)] text-xs text-ink">
              FUSIONAUTH_MCP_CLIENT_ID
            </code>{" "}
            /{" "}
            <code className="font-[family-name:var(--font-mono)] text-xs text-ink">
              _SECRET
            </code>{" "}
            and{" "}
            <code className="font-[family-name:var(--font-mono)] text-xs text-ink">
              FUSIONAUTH_MCP_SCOPE
            </code>{" "}
            to mint and show its own identity here.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-ink-soft">{label}</dt>
      <dd
        className={`truncate text-right text-ink ${
          mono ? "font-[family-name:var(--font-mono)] text-xs" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
