/**
 * The honest agent-mode banner — mirrors InFusion Market's "Live FGA / demo
 * mode" banner. When ANTHROPIC_API_KEY is set the planner is a real Claude
 * tool-calling loop; when it isn't, a deterministic scripted planner drives tool
 * selection. Crucially, the AUTHORIZATION behavior is identical either way — the
 * auth layer never trusts the planner — so the banner is about the planner only.
 */
export default function AgentModeBanner({ mode }: { mode: "live" | "scripted" }) {
  if (mode === "live") {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-verified/30 bg-verified-soft px-4 py-2.5 text-sm text-verified"
      >
        <span aria-hidden="true">●</span>
        <span>
          <strong className="font-semibold">Live LLM Agent.</strong> A real
          Claude tool-calling loop is choosing which tools to call. Every scope
          check below still runs independently — the auth layer never trusts the
          planner.
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm text-signal-ink"
    >
      <span className="font-semibold">Scripted Agent</span> — add{" "}
      <code className="font-[family-name:var(--font-mono)]">ANTHROPIC_API_KEY</code>{" "}
      for live mode. A deterministic keyword planner is selecting tools right now.
      It still makes real MCP calls, real scope checks, and real step-up — only
      the &ldquo;which tool&rdquo; decision is rule-based.
    </div>
  );
}
