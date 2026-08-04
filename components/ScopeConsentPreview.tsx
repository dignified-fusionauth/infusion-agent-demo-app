import {
  KNOWN_ROLES,
  SCOPE_CATALOG,
  defaultToolScopesForRole,
  type AgentRole,
} from "@/lib/scopes";

/**
 * Pre-login preview of what each role's sign-in will request — and grant links.
 * This is where the demo's "an employee's login never even requests
 * tools:payroll.read" claim becomes visible: each card lists exactly the tool
 * scopes that role's authorize URL will carry, with the consent-required ones
 * flagged. Choosing a role sends ?role=… to /api/auth/login, which maps it to
 * the scope string (see lib/bff.ts).
 */

const ROLE_LABEL: Record<AgentRole, string> = {
  employee: "Employee",
  manager: "Manager",
  "it-admin": "IT Admin",
};

const ROLE_BLURB: Record<AgentRole, string> = {
  employee: "Knowledge base + tickets. No directory, payroll, or PTO.",
  manager: "Adds directory, payroll, and PTO — the last two require consent.",
  "it-admin": "The full tool set, payroll and PTO included.",
};

function scopeDef(id: string) {
  return SCOPE_CATALOG.find((s) => s.id === id);
}

export default function ScopeConsentPreview() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {KNOWN_ROLES.map((role) => {
        const scopes = defaultToolScopesForRole(role);
        return (
          <div
            key={role}
            className="flex flex-col rounded-2xl border border-line bg-card p-5 shadow-sm"
          >
            <h3 className="font-bold text-ink font-[family-name:var(--font-display)]">
              {ROLE_LABEL[role]}
            </h3>
            <p className="mt-1 text-sm text-ink-soft">{ROLE_BLURB[role]}</p>

            <ul className="mt-4 flex-1 space-y-1.5">
              {scopes.map((id) => {
                const def = scopeDef(id);
                return (
                  <li key={id} className="flex items-center gap-2 text-xs">
                    <code className="rounded bg-surface px-1.5 py-0.5 text-brand-ink font-[family-name:var(--font-mono)]">
                      {id}
                    </code>
                    {def?.requiresConsent ? (
                      <span className="rounded-full bg-signal-soft px-1.5 py-0.5 font-semibold text-signal-ink">
                        consent
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <a
              href={`/api/auth/login?role=${role}&redirect_uri=/chat`}
              className="mt-5 inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-ink"
            >
              Sign in as {ROLE_LABEL[role]}
            </a>
          </div>
        );
      })}
    </div>
  );
}
