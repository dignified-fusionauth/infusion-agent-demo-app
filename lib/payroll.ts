/**
 * Mock payroll + PTO data for the `view_payroll` and `update_pto_balance` tools —
 * kept deliberately separate from the real FusionAuth calls in lib/fusionauth.ts,
 * the same split the sibling apps use. Nothing here is a live lookup, and there
 * is no real HR/payroll backend.
 *
 * PTO adjustments made by `update_pto_balance` are held in a globalThis-backed map
 * so they survive dev HMR, and — like InFusion Market's in-memory feed — reset
 * whenever the server restarts. This is intentional: no database.
 */

/** Formats integer cents as USD, the shared portfolio money helper. */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export interface PayrollLine {
  team: string;
  headcount: number;
  monthlyGrossCents: number;
}

/** Last month's payroll summary, the payload `view_payroll` returns. */
export const PAYROLL_SUMMARY: PayrollLine[] = [
  { team: "Platform", headcount: 12, monthlyGrossCents: 1_486_000 },
  { team: "IT", headcount: 5, monthlyGrossCents: 512_000 },
  { team: "People", headcount: 4, monthlyGrossCents: 396_000 },
  { team: "Finance", headcount: 6, monthlyGrossCents: 604_000 },
];

export function payrollTotalCents(): number {
  return PAYROLL_SUMMARY.reduce((sum, l) => sum + l.monthlyGrossCents, 0);
}

export interface PtoBalance {
  employee: string;
  remainingDays: number;
}

/** Starting PTO balances, before any in-session adjustments. */
const BASE_PTO: PtoBalance[] = [
  { employee: "Ada Okafor", remainingDays: 14 },
  { employee: "Bruno Vega", remainingDays: 9 },
  { employee: "Chen Li", remainingDays: 21 },
  { employee: "Dara Novak", remainingDays: 6 },
  { employee: "Elif Demir", remainingDays: 18 },
  { employee: "Farhan Qureshi", remainingDays: 11 },
];

// In-memory adjustments, on globalThis so they survive HMR (reset on restart).
const globalForPto = globalThis as unknown as {
  __infusionAgentPto?: Map<string, number>;
};
function ptoOverrides(): Map<string, number> {
  if (!globalForPto.__infusionAgentPto) {
    globalForPto.__infusionAgentPto = new Map();
  }
  return globalForPto.__infusionAgentPto;
}

function baseFor(employee: string): number | undefined {
  const key = employee.trim().toLowerCase();
  return BASE_PTO.find((p) => p.employee.toLowerCase() === key)?.remainingDays;
}

/** Current PTO balance for one employee (base + any in-session adjustment). */
export function ptoBalanceFor(employee: string): PtoBalance | null {
  const base = baseFor(employee);
  if (base === undefined) return null;
  const canonical =
    BASE_PTO.find(
      (p) => p.employee.toLowerCase() === employee.trim().toLowerCase()
    )?.employee ?? employee;
  const override = ptoOverrides().get(canonical.toLowerCase());
  return {
    employee: canonical,
    remainingDays: override ?? base,
  };
}

/**
 * Adjusts one employee's PTO balance by `deltaDays` (can be negative). Returns
 * the new balance, or null when the employee is unknown.
 */
export function adjustPtoBalance(
  employee: string,
  deltaDays: number
): PtoBalance | null {
  const current = ptoBalanceFor(employee);
  if (!current) return null;
  const next = Math.max(0, current.remainingDays + deltaDays);
  ptoOverrides().set(current.employee.toLowerCase(), next);
  return { employee: current.employee, remainingDays: next };
}
