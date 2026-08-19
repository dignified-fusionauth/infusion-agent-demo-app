/**
 * The RAG corpus for the `search_knowledge_base` tool — a small, in-memory set of
 * mock articles, kept deliberately separate from the real FusionAuth calls in
 * lib/fusionauth.ts. There is no vector database and no real embeddings: the
 * scorer is a plain keyword-overlap function. It's small on purpose (the README's
 * non-goals say so), but the retrieval code is real, ungated logic — not a canned
 * response.
 *
 * Two INDEPENDENT dimensions decide what a caller may retrieve, and they answer
 * different questions:
 *
 *   - `requiredScope` — the OAuth dimension. Retrieval filters by the caller's
 *     granted scopes BEFORE it ranks, so an under-scoped user doesn't just fail to
 *     open a restricted article: the article never surfaces at all. They can't even
 *     learn it exists.
 *   - `space` — the FGA dimension (lib/fga.ts). A non-public article belongs to a
 *     knowledge-base space, and the MCP tool asks Permify `kb_doc:<id>#read` for
 *     every article that survives the scope filter. Document-level ACLs are the
 *     canonical fine-grained-authorization problem for a retriever, and they're
 *     relationship-shaped ("your team can read that space"), which is exactly what a
 *     scope string can't express.
 *
 * Scope answers "may this agent search the knowledge base at all"; FGA answers "which
 * documents". A doc must pass BOTH to enter the model's context window.
 */

export interface Article {
  id: string;
  title: string;
  body: string;
  tags: string[];
  /**
   * "public" for articles any signed-in employee can retrieve, or a scope id
   * (e.g. "tools:payroll.read") that the caller's token must carry.
   */
  requiredScope: "public" | string;
  /**
   * The knowledge-base space this article lives in, which is what the FGA layer
   * authorizes against (`kb_doc:<id>#read` resolving through `kb_space` to a team —
   * see permify/schema.perm). "public" means no FGA check runs at all.
   */
  space: KbSpaceId;
}

/** The FGA-governed spaces, mirroring KB_SPACES in lib/org-graph.ts. */
export type KbSpaceId = "public" | "hr" | "it" | "finance";

export const ARTICLES: Article[] = [
  {
    id: "kb-pto-policy",
    title: "Paid time off (PTO) policy",
    body: "Full-time employees accrue 1.5 PTO days per month, up to 18 days a year, carrying over a maximum of 5 unused days. Request time off at least two weeks in advance through the People portal.",
    tags: ["pto", "vacation", "time off", "leave", "holiday", "policy"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-expense-policy",
    title: "Expense reimbursement policy",
    body: "Submit expenses within 30 days with an itemized receipt. Meals are capped at $60/day while travelling. Software purchases over $200 need manager approval before purchase.",
    tags: ["expense", "reimbursement", "receipts", "travel", "policy"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-vpn-setup",
    title: "Setting up the VPN",
    body: "Install the WireGuard client, then import the config from the IT portal. If the tunnel drops repeatedly, switch from the default gateway to the regional gateway. Contact IT if MFA prompts loop.",
    tags: ["vpn", "wireguard", "remote", "network", "it", "setup"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-password-reset",
    title: "Resetting your password",
    body: "Use the self-service reset on the login page; it sends a one-time link to your work email. Passwords must be at least 12 characters. Enrolling a second factor is required for engineering and IT roles.",
    tags: ["password", "reset", "login", "mfa", "account", "security"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-onboarding",
    title: "New hire onboarding checklist",
    body: "Day one: pick up your laptop, enroll in MFA, and join the #welcome channel. Week one: complete security awareness training and meet your onboarding buddy. Your manager assigns your first project by day three.",
    tags: ["onboarding", "new hire", "checklist", "first day", "training"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-security-awareness",
    title: "Security awareness basics",
    body: "Never share your password or MFA codes. Report suspicious emails with the Phish Alert button. Lock your screen when you step away. Least-privilege access means you only get the scopes your role needs.",
    tags: ["security", "phishing", "awareness", "mfa", "training", "scopes"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-remote-work",
    title: "Remote work guidelines",
    body: "Core collaboration hours are 10am–3pm in your team's primary timezone. Keep your calendar current. Home-office stipend requests go through the People portal once per fiscal year.",
    tags: ["remote", "work from home", "hybrid", "calendar", "stipend"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-benefits",
    title: "Benefits overview",
    body: "Health, dental, and vision start on your first day. The 401(k) match is 4% and vests immediately. Open enrollment runs each November. Life-event changes can be made within 30 days of the event.",
    tags: ["benefits", "health", "dental", "401k", "insurance", "enrollment"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-laptop-refresh",
    title: "Laptop refresh program",
    body: "Company laptops are refreshed every three years. When yours is eligible, IT opens a ticket automatically. Back up to the company drive before handing back your old device.",
    tags: ["laptop", "hardware", "refresh", "device", "it", "equipment"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-meeting-rooms",
    title: "Booking meeting rooms",
    body: "Reserve rooms from the calendar's room finder. Rooms auto-release if no one checks in within 10 minutes. The two large rooms on floor 4 require facilities approval for events over 20 people.",
    tags: ["meeting", "rooms", "booking", "calendar", "facilities", "office"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-holidays",
    title: "Company holiday calendar",
    body: "There are 11 company holidays a year plus two floating holidays you can take any time. Regional offices observe their local public holidays in addition to the shared set.",
    tags: ["holidays", "calendar", "time off", "floating", "public holiday"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-oncall",
    title: "On-call rotation and escalation contacts",
    body: "The Platform on-call rotates weekly; the current primary and secondary are listed in the directory. Escalate a Sev-1 to the engineering manager on duty, then People Ops if it becomes an HR matter.",
    tags: ["on-call", "oncall", "escalation", "rotation", "contacts", "directory", "incident"],
    requiredScope: "tools:directory.read",
    space: "it",
  },
  {
    id: "kb-org-chart",
    title: "Team org chart and reporting lines",
    body: "Platform and IT roll up to the VP of Engineering; People and Finance roll up to the COO. Reporting lines and each manager's direct reports are maintained in the employee directory.",
    tags: ["org chart", "reporting", "manager", "directory", "structure", "team"],
    requiredScope: "tools:directory.read",
    space: "hr",
  },
  {
    id: "kb-comp-bands",
    title: "Compensation bands (confidential)",
    body: "Each level maps to a salary band with a defined midpoint; offers target 90–110% of midpoint. Bands are reviewed annually against market data. This document is restricted to payroll-authorized roles.",
    tags: ["compensation", "salary", "bands", "pay", "payroll", "levels", "confidential"],
    requiredScope: "tools:payroll.read",
    space: "finance",
  },
  {
    id: "kb-payroll-calendar",
    title: "Payroll calendar and cutoffs (confidential)",
    body: "Pay runs on the last business day of each month. Timesheet and adjustment cutoffs are the 25th. Off-cycle payments require Finance approval. Restricted to payroll-authorized roles.",
    tags: ["payroll", "pay", "calendar", "cutoff", "timesheet", "finance", "confidential"],
    requiredScope: "tools:payroll.read",
    space: "finance",
  },
];

export interface RankedArticle {
  article: Article;
  score: number;
}

/**
 * Function words the scorer ignores. Beyond the usual suspects this deliberately drops
 * pronouns and auxiliaries, because several of them collide with real tags: "what is it
 * used for" would otherwise score a tag hit on the IT department's "it" and look like an
 * internal question. A router that mistakes English grammar for a topic sends the wrong
 * turns to the wrong tools.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "in", "on",
  "our", "my", "me", "what", "whats", "how", "do", "i", "we", "can", "get",
  "show", "tell", "about", "with", "s",
  "it", "its", "this", "that", "these", "those", "you", "your", "they", "them",
  "their", "be", "was", "were", "been", "am", "will", "would", "should",
  "could", "has", "have", "had", "does", "did", "by", "at", "as", "if", "so",
  "not", "from", "when", "where", "which", "who", "why", "there", "here",
  "than", "then", "but", "also", "just", "only", "more", "most", "some",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** True when an article is visible to a caller holding `callerScopes`. */
export function articleVisible(
  article: Article,
  callerScopes: string[]
): boolean {
  return (
    article.requiredScope === "public" ||
    callerScopes.includes(article.requiredScope)
  );
}

/**
 * Scope-filtered keyword retrieval. Filters the corpus down to what `callerScopes`
 * may see, THEN scores the survivors by keyword overlap against the query. An
 * article the caller can't see is never scored and never returned — its existence
 * doesn't leak. Returns the top `limit` matches with a non-zero score.
 */
export function searchKnowledgeBase(
  query: string,
  callerScopes: string[],
  limit = 3
): RankedArticle[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const visible = ARTICLES.filter((a) => articleVisible(a, callerScopes));

  const ranked: RankedArticle[] = visible.map((article) => {
    const haystack = new Set(
      tokenize(`${article.title} ${article.body} ${article.tags.join(" ")}`)
    );
    let score = 0;
    for (const token of queryTokens) {
      if (haystack.has(token)) score += 1;
      // A tag exact-match is worth a little extra weight.
      if (article.tags.includes(token)) score += 1;
    }
    return { article, score };
  });

  return ranked
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** How many restricted articles the caller's scopes hide — for an honest note in the trace. */
export function hiddenArticleCount(callerScopes: string[]): number {
  return ARTICLES.filter((a) => !articleVisible(a, callerScopes)).length;
}

/**
 * Routing helper for the internal-first turn: does this prompt look like something
 * the internal corpus could actually answer? Scores the query against article TITLES
 * and TAGS (a tag hit counts double), which is signal about topics rather than prose.
 *
 * It is deliberately scope-blind and FGA-blind: it only decides whether the agent
 * SEARCHES, never what comes back. Retrieval still filters by the caller's scopes
 * (searchKnowledgeBase) and then by their FGA document relations (lib/mcp-server.ts),
 * so routing on the full corpus can't leak the existence of a restricted article —
 * an under-privileged caller just gets an empty result set and the external fallback.
 *
 * The scripted planner uses this instead of treating knowledge-base search as a
 * universal catch-all, so both planners route the same way: internal tools first, the
 * model's own knowledge only when nothing internal could serve the prompt.
 */
export function corpusMatches(query: string): boolean {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return false;

  return ARTICLES.some((article) => {
    const tagTokens = new Set(article.tags.flatMap((t) => tokenize(t)));
    const titleTokens = new Set(tokenize(article.title));
    let score = 0;
    for (const token of queryTokens) {
      if (tagTokens.has(token)) score += 2;
      if (titleTokens.has(token)) score += 1;
    }
    return score >= 2;
  });
}
