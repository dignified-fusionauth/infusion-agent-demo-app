/**
 * Mock IT-ticketing store for the `create_it_ticket` tool — kept deliberately
 * separate from the real FusionAuth calls in lib/fusionauth.ts, the same split
 * the sibling apps use. Nothing here is a live lookup, and there is no real
 * ticketing backend.
 *
 * Created tickets live in a globalThis-backed ring buffer so they survive dev
 * HMR; like InFusion Market's activity feed, they reset whenever the server
 * restarts. No database.
 */

export interface Ticket {
  id: string;
  subject: string;
  category: string;
  openedBy: string;
  createdAtIso: string;
}

const MAX_TICKETS = 100;

const globalForTickets = globalThis as unknown as {
  __infusionAgentTickets?: Ticket[];
};
function store(): Ticket[] {
  if (!globalForTickets.__infusionAgentTickets) {
    globalForTickets.__infusionAgentTickets = [];
  }
  return globalForTickets.__infusionAgentTickets;
}

/** A stable-ish reference from the ticket count — no Date.now() collisions in a demo. */
function nextReference(): string {
  const n = store().length + 1;
  return `IT-${String(n).padStart(4, "0")}`;
}

/** Opens a ticket and returns it. `nowIso` is passed in so handlers stay pure/testable. */
export function createTicket(opts: {
  subject: string;
  category: string;
  openedBy: string;
  nowIso: string;
}): Ticket {
  const ticket: Ticket = {
    id: nextReference(),
    subject: opts.subject,
    category: opts.category,
    openedBy: opts.openedBy,
    createdAtIso: opts.nowIso,
  };
  const list = store();
  list.unshift(ticket);
  if (list.length > MAX_TICKETS) list.length = MAX_TICKETS;
  return ticket;
}

/** The most recently opened tickets, newest first. */
export function recentTickets(limit = 10): Ticket[] {
  return store().slice(0, limit);
}
