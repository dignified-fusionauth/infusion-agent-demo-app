import { redirect } from "next/navigation";
import ScopeConsentPreview from "@/components/ScopeConsentPreview";
import { getSession } from "@/lib/session";

const ERRORS: Record<string, string> = {
  invalid_state: "That sign-in link expired. Please try again.",
  exchange_failed: "We couldn't complete sign-in. Please try again.",
  access_denied: "You declined the requested access.",
};

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Authenticated visitors skip the landing. getSession() fully verifies the
  // access token, so an expired/tampered session falls through to sign-in.
  const session = await getSession();
  if (session) redirect("/chat");

  const { error } = await searchParams;
  const errorMessage = error ? (ERRORS[error] ?? "Sign-in failed.") : null;

  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="border-b border-line bg-ink text-white">
        <div className="mx-auto max-w-5xl px-5 py-16 sm:py-20">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-md bg-white text-sm font-bold text-ink font-[family-name:var(--font-display)]"
              aria-hidden="true"
            >
              IA
            </span>
            <span className="text-base font-bold tracking-tight font-[family-name:var(--font-display)]">
              InFusion Agent
            </span>
          </div>
          <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
            OAuth for agentic AI
          </p>
          <h1 className="mt-3 max-w-3xl text-4xl font-bold leading-tight tracking-tight font-[family-name:var(--font-display)] sm:text-5xl">
            Authorizing the agent, not just the human.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-white/70">
            &ldquo;Ask Fusion&rdquo; is an internal assistant that searches a
            knowledge base and takes actions through an MCP tool server. Every
            retrieval and every tool call is gated by the signed-in
            employee&rsquo;s <strong className="text-white">actual OAuth
            scopes</strong> — a non-human identity, least-privilege per tool, and
            two independent authorization checks you can watch happen live.
          </p>
        </div>
      </section>

      {/* Story + role picker */}
      <section className="mx-auto max-w-5xl px-5 py-12">
        {errorMessage ? (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm font-medium text-signal-ink"
          >
            {errorMessage}
          </div>
        ) : null}

        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">
          Sign in as a demo role
        </h2>
        <p className="mt-1 mb-6 max-w-2xl text-ink-soft">
          The role you choose decides which tool scopes your login even
          <em> requests</em>. An employee&rsquo;s sign-in never asks for payroll
          or PTO, so FusionAuth&rsquo;s hosted consent screen never offers them.
          A manager&rsquo;s does — and must grant them explicitly.
        </p>

        <ScopeConsentPreview />

        {/* The two checks */}
        <div className="mt-12 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-6">
            <h3 className="font-bold text-ink font-[family-name:var(--font-display)]">
              1 · The agent&rsquo;s sandbox check
            </h3>
            <p className="mt-2 text-sm text-ink-soft">
              Before calling any tool, the agent checks the user&rsquo;s token
              scopes <em>and</em> role locally and refuses what it already knows
              is out of reach —{" "}
              <code className="font-[family-name:var(--font-mono)] text-xs text-brand-ink">
                sandbox: DENIED
              </code>{" "}
              with no MCP call attempted.
            </p>
          </div>
          <div className="rounded-2xl border border-line bg-card p-6">
            <h3 className="font-bold text-ink font-[family-name:var(--font-display)]">
              2 · The MCP server&rsquo;s own check
            </h3>
            <p className="mt-2 text-sm text-ink-soft">
              The MCP tool server is a real OAuth 2.1 resource server. It
              verifies the bearer token <em>independently</em> against
              FusionAuth&rsquo;s JWKS and re-checks the scope and role — a
              separate code path, so defense-in-depth is real, not cosmetic.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
