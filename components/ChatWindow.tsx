"use client";

import { useState } from "react";
import AuthorizationTrace from "@/components/AuthorizationTrace";
import ArchitectureDiagram from "@/components/ArchitectureDiagram";
import StepUpSlip, { type StepUpMethod } from "@/components/StepUpSlip";
import type { TraceStep, ChatResponse } from "@/lib/agent";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

interface PendingSlip {
  tool: string;
  args: Record<string, unknown>;
  action: string;
  title: string;
  twoFactorId: string;
  methods: StepUpMethod[];
  error?: string;
}

/**
 * The starter prompts, ordered so clicking straight down them walks the whole story:
 * an internal read anyone can do; a directory lookup that has no resource dimension;
 * the same colleague's PTO, which does (and is where FGA refuses); payroll, which FGA
 * narrows rather than refuses; the one tool that leaves the network; and finally a
 * question no tool can serve at all.
 *
 * Each one is a different outcome in the trace, not just a different topic — the point
 * of the chips is that a viewer can produce every authorization state without knowing
 * what to type.
 */
const SUGGESTIONS = [
  "What's our PTO policy?",
  "Look up Chen Li in the directory",
  "Adjust Chen Li's PTO by -2 days",
  "Show me last month's payroll numbers",
  "What is a FusionAuth Entity?",
  "What's the capital of Norway?",
];

async function postChat(body: unknown): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ChatResponse;
}

/**
 * "Ask Fusion" — the chat surface plus the live authorization trace. It drives
 * the whole turn client-side: send → (step-up round trip if the server asks) →
 * resume, accumulating trace steps as each phase reports back.
 */
export default function ChatWindow({
  initialMode = "scripted",
}: {
  /**
   * The mode the server reports (agentMode()). Seeding state with it keeps the diagram's
   * planner label agreeing with the banner above it before the first turn; from then on
   * each response's own `mode` wins, so an honest degrade still shows through.
   */
  initialMode?: "live" | "scripted";
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [mode, setMode] = useState<"live" | "scripted">(initialMode);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [slip, setSlip] = useState<PendingSlip | null>(null);

  function pushAssistant(text: string) {
    setMessages((m) => [...m, { role: "assistant", text }]);
  }

  function appendTrace(steps: TraceStep[]) {
    setTrace((t) => [...t, ...steps]);
  }

  async function handleResponse(res: ChatResponse) {
    appendTrace(res.trace);
    setMode(res.mode);
    if (res.kind === "reply") {
      pushAssistant(res.reply);
      setBusy(false);
      return;
    }
    // kind === "stepup": ask FusionAuth whether a fresh challenge is needed.
    await beginStepUp(res.pending);
  }

  async function beginStepUp(pending: {
    tool: string;
    args: Record<string, unknown>;
    action: string;
    title: string;
  }) {
    try {
      const res = await fetch("/api/two-factor/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: pending.action }),
      });
      const data = (await res.json()) as {
        challengeRequired?: boolean;
        twoFactorId?: string;
        methods?: StepUpMethod[];
        error?: string;
      };
      if (!res.ok) {
        pushAssistant(data.error ?? "Couldn't start the step-up check.");
        setBusy(false);
        return;
      }
      if (!data.challengeRequired) {
        // Grant already recorded server-side — resume immediately.
        await resumeTurn(pending);
        return;
      }
      setSlip({
        ...pending,
        twoFactorId: data.twoFactorId ?? "",
        methods: data.methods ?? [],
      });
      setBusy(false); // waiting on the user to enter a code
    } catch {
      pushAssistant("Couldn't reach the step-up service.");
      setBusy(false);
    }
  }

  async function submitCode(code: string) {
    if (!slip) return;
    setBusy(true);
    setSlip({ ...slip, error: undefined });
    try {
      const res = await fetch("/api/two-factor/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          twoFactorId: slip.twoFactorId,
          code,
          action: slip.action,
        }),
      });
      const data = (await res.json()) as { verified?: boolean; error?: string };
      if (!res.ok || !data.verified) {
        setSlip({ ...slip, error: data.error ?? "Incorrect code. Try again." });
        setBusy(false);
        return;
      }
      const pending = slip;
      setSlip(null);
      await resumeTurn(pending);
    } catch {
      setSlip({ ...slip, error: "Verification failed. Try again." });
      setBusy(false);
    }
  }

  async function resumeTurn(pending: {
    tool: string;
    args: Record<string, unknown>;
  }) {
    setBusy(true);
    try {
      const res = await postChat({
        resume: { tool: pending.tool, args: pending.args },
      });
      await handleResponse(res);
    } catch {
      pushAssistant("Something went wrong resuming the turn.");
      setBusy(false);
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setTrace([]); // fresh turn → fresh trace
    setSlip(null);
    setBusy(true);
    try {
      const res = await postChat({ message });
      await handleResponse(res);
    } catch {
      pushAssistant("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* Chat column */}
        <div className="flex min-h-[28rem] flex-col rounded-xl border border-line bg-card shadow-sm">
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {messages.length === 0 ? (
            <div className="text-sm text-ink-soft">
              <p>
                Ask Fusion checks its five internal tools first — the knowledge base, the
                directory, IT tickets, and (with the right scopes) payroll and PTO. Only
                then may it ask a third-party server about public documentation, and only
                if nothing else fits does it answer from the model&rsquo;s own knowledge.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    disabled={busy}
                    className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-soft transition hover:border-brand hover:text-brand-ink disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ia-animate-in ${
                    m.role === "user"
                      ? "bg-brand text-white"
                      : "bg-surface text-ink"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))
          )}

          {slip ? (
            <div className="pt-2">
              <StepUpSlip
                title={slip.title}
                methods={slip.methods}
                busy={busy}
                error={slip.error}
                onSubmit={submitCode}
                onCancel={() => {
                  setSlip(null);
                  pushAssistant("Step-up cancelled — the tool didn't run.");
                }}
              />
            </div>
          ) : null}
        </div>

        <form
          className="flex gap-2 border-t border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Fusion…"
            disabled={busy || slip !== null}
            className="flex-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-ink focus:border-brand focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || slip !== null || !input.trim()}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-ink disabled:opacity-50"
          >
            {busy ? "…" : "Send"}
          </button>
        </form>
      </div>

      {/* Trace column */}
        <AuthorizationTrace steps={trace} />
      </div>
      <ArchitectureDiagram steps={trace} mode={mode} />
    </div>
  );
}
