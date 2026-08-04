"use client";

import { useState } from "react";

export interface StepUpMethod {
  id: string;
  method: string;
  email?: string;
  mobilePhone?: string;
}

interface StepUpSlipProps {
  title: string;
  methods: StepUpMethod[];
  busy: boolean;
  error?: string;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}

function methodHint(methods: StepUpMethod[]): string {
  const m = methods[0];
  if (!m) return "Enter the verification code to continue.";
  if (m.method === "email")
    return `We sent a code to ${m.email ?? "your email on file"}.`;
  if (m.method === "sms")
    return `We texted a code to ${m.mobilePhone ?? "your phone on file"}.`;
  return "Enter the code from your authenticator app.";
}

/**
 * The step-up challenge UI — styled as a perforated slip, the shared portfolio
 * motif (FusionBank's VerificationSlip, FusionWorks' BadgeReswipe, FusionMarket's
 * StepUpSlip). Presentational only; the parent (ChatWindow) owns all state and
 * drives the two-factor round trip. Here it's triggered by the agent's sensitive
 * tool call rather than a form submit.
 */
export default function StepUpSlip({
  title,
  methods,
  busy,
  error,
  onSubmit,
  onCancel,
}: StepUpSlipProps) {
  const [code, setCode] = useState("");

  return (
    <div className="overflow-hidden rounded-xl border border-signal/40 bg-card shadow-md">
      <div className="flex items-center gap-2 bg-signal-soft px-5 py-3">
        <span className="text-xl" aria-hidden="true">
          🔐
        </span>
        <div>
          <p className="text-sm font-bold text-signal-ink font-[family-name:var(--font-display)]">
            Confirm it&rsquo;s you
          </p>
          <p className="text-xs text-signal-ink/80">{title}</p>
        </div>
      </div>

      <form
        className="ia-perforated space-y-3 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) onSubmit(code.trim());
        }}
      >
        <p className="text-sm text-ink-soft">{methodHint(methods)}</p>
        <div>
          <label className="sr-only" htmlFor="stepup-code">
            Verification code
          </label>
          <input
            id="stepup-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            autoFocus
            className="w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-center text-lg tracking-[0.5em] text-ink font-[family-name:var(--font-mono)] focus:border-signal focus:outline-none"
          />
        </div>
        {error ? (
          <p className="text-sm font-medium text-signal-ink" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="flex-1 rounded-lg bg-signal px-4 py-2.5 font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify & continue"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-line px-4 py-2.5 font-medium text-ink hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
