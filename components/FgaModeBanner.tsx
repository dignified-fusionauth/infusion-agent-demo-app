/**
 * The honest "not talking to a live Permify server" banner, the same shape as
 * AgentModeBanner's scripted/live distinction. When Permify is reachable this says so
 * plainly; when it isn't, every resource decision on the page came from the in-memory
 * app-code cascade resolver in lib/fga.ts — the very thing FGA exists to replace — and
 * we say that instead of pretending.
 */
export default function FgaModeBanner({ mode }: { mode: "live" | "demo" }) {
  if (mode === "live") {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-fga/30 bg-fga-soft px-4 py-2.5 text-sm text-fga-ink"
      >
        <span aria-hidden="true">●</span>
        <span>
          <strong className="font-semibold">Live FGA.</strong> Every resource decision
          in the trace below came from a real FusionAuth FGA{" "}
          <code className="font-[family-name:var(--font-mono)]">check</code> —
          relationship cascade and all — with zero app-code traversal.
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm text-signal-ink"
    >
      <span className="font-semibold">Showing demo authorization.</span> No Permify
      server is reachable at{" "}
      <code className="font-[family-name:var(--font-mono)]">PERMIFY_URL</code>, so the
      resource-level decisions came from an in-memory app-code cascade resolver — the
      very thing FGA replaces. Start Permify (see the README); the schema loads itself
      and these checks go live.
    </div>
  );
}
