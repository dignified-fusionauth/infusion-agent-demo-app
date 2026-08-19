import type { TraceStep, TraceLayer, TraceStatus } from "@/lib/agent";

/**
 * The signature UI: a live authorization trace. It logs every step of every turn
 * — routing → tool selected → sandbox check → FGA resource check → step-up (if
 * required) → MCP call → the MCP server's own scope, role and FGA checks → result
 * — so a viewer can watch the whole story scroll by without narration.
 *
 * Every layer is colored independently, because the failures mean different things:
 * "the agent refused locally on scope" reads differently from "the resource server
 * refused", and both read differently from "your relations don't reach that
 * resource" (the FGA layer, in its own violet). The `external` layer marks the one
 * case where no internal tool applied at all — no authorization decision to make.
 */

const LAYER_LABEL: Record<TraceLayer, string> = {
  planner: "planner",
  sandbox: "sandbox",
  fga: "fga · permify",
  stepup: "step-up",
  mcp: "mcp server",
  external: "external",
  result: "result",
};

function statusClasses(
  status: TraceStatus,
  layer: TraceLayer
): { dot: string; badge: string } {
  // The FGA layer gets its own hue on the non-denial states, so a resource-level
  // decision never reads as the scope/role decision above it.
  if (layer === "fga" && status !== "denied" && status !== "error") {
    return { dot: "text-fga-ink", badge: "bg-fga-soft text-fga-ink" };
  }
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
          Three layers, live: the agent&rsquo;s sandbox, the MCP resource server,
          and FusionAuth FGA on the resources themselves.
        </p>
      </div>

      {steps.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-soft">
          Ask something to see the agent plan, check scopes, and call tools.
        </p>
      ) : (
        <ol className="ia-rail space-y-3 pr-5 pl-5 py-4">
          {steps.map((step, i) => {
            const c = statusClasses(step.status, step.layer);
            return (
              <li key={i} className={`ia-node ${c.dot} ia-animate-in`}>
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
