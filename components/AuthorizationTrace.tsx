import type { TraceStep, TraceLayer, TraceStatus } from "@/lib/agent";

/**
 * The signature UI: a live authorization trace. It logs every step of every turn
 * — tool selected → sandbox check → step-up (if required) → MCP call → the MCP
 * server's own check → result — so a viewer can watch the whole story scroll by
 * without narration. The sandbox and MCP layers are colored independently so
 * "the agent refused locally" reads differently from "the resource server
 * refused."
 */

const LAYER_LABEL: Record<TraceLayer, string> = {
  planner: "planner",
  sandbox: "sandbox",
  stepup: "step-up",
  mcp: "mcp server",
  result: "result",
};

function statusClasses(status: TraceStatus): { dot: string; badge: string } {
  switch (status) {
    case "allowed":
    case "verified":
      return {
        dot: "text-verified",
        badge: "bg-verified-soft text-verified",
      };
    case "denied":
    case "error":
      return { dot: "text-denied", badge: "bg-denied-soft text-denied" };
    case "required":
      return {
        dot: "text-signal-ink",
        badge: "bg-signal-soft text-signal-ink",
      };
    default:
      return { dot: "text-brand-ink", badge: "bg-brand-soft text-brand-ink" };
  }
}

export default function AuthorizationTrace({
  steps,
}: {
  steps: TraceStep[];
}) {
  return (
    <div className="rounded-xl border border-line bg-card shadow-sm">
      <div className="border-b border-line px-5 py-3">
        <h2 className="font-bold text-ink font-[family-name:var(--font-display)]">
          Authorization trace
        </h2>
        <p className="text-xs text-ink-soft">
          Two independent checks, live: the agent&rsquo;s sandbox and the MCP
          resource server.
        </p>
      </div>

      {steps.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-soft">
          Ask something to see the agent plan, check scopes, and call tools.
        </p>
      ) : (
        <ol className="ia-rail space-y-3 px-5 py-4">
          {steps.map((step, i) => {
            const c = statusClasses(step.status);
            return (
              <li key={i} className={`ia-node relative ${c.dot} ia-animate-in`}>
                <div className="flex flex-wrap items-center gap-2 text-ink">
                  <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-ink-soft font-[family-name:var(--font-mono)]">
                    {LAYER_LABEL[step.layer]}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold font-[family-name:var(--font-mono)] ${c.badge}`}
                  >
                    {step.label}
                  </span>
                </div>
                {step.detail ? (
                  <p className="mt-0.5 text-xs text-ink-soft">{step.detail}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
