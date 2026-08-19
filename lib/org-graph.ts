import { DIRECTORY } from "@/lib/directory";
import { PAYROLL_SUMMARY } from "@/lib/payroll";
import { ARTICLES } from "@/lib/knowledge-base";

/**
 * The company graph the FGA layer authorizes against: one organization, its teams,
 * the employees on each team, and the knowledge-base spaces each team can read.
 *
 * This is mock domain data, kept deliberately separate from the service calls in
 * lib/fga.ts (which talks to Permify) and lib/fusionauth.ts (which talks to
 * FusionAuth) — the same split lib/directory.ts, lib/payroll.ts, and
 * lib/knowledge-base.ts already follow. Nothing here is a live lookup.
 *
 * Everything is DERIVED from the data modules that already exist rather than
 * re-listed, so the FGA entity ids can't drift from the payroll lines, the
 * directory, or the RAG corpus: teams come from PAYROLL_SUMMARY, employees from
 * DIRECTORY, and the document→space links from ARTICLES.
 */

/** The single organization every team hangs off. */
export const ORG_ID = "infusion";
export const ORG_NAME = "InFusion";

export interface TeamNode {
  /** The Permify entity id, e.g. "platform". */
  id: string;
  /** Display name — also the `team` on a payroll line and the `department` in the directory. */
  name: string;
}

/**
 * The teams, derived from the payroll summary so a team can never exist for FGA
 * without a payroll line (or vice versa).
 */
export const TEAMS: TeamNode[] = PAYROLL_SUMMARY.map((line) => ({
  id: line.id,
  name: line.team,
}));

export function teamName(teamId: string): string | undefined {
  return TEAMS.find((t) => t.id === teamId)?.name;
}

/** The team id for a directory department (case-insensitive), if we know it. */
export function teamIdForDepartment(department: string): string | undefined {
  const needle = department.trim().toLowerCase();
  return TEAMS.find((t) => t.name.toLowerCase() === needle)?.id;
}

export interface EmployeeNode {
  /** The Permify entity id, e.g. "chen-li". */
  id: string;
  name: string;
  /** The team whose manager (or the org's HR) may act on this employee. */
  teamId: string;
}

/** Lowercase, hyphenated entity id from a person's name ("Chen Li" → "chen-li"). */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The employees, derived from the mock directory. An entry whose department isn't a
 * known team is dropped rather than pointed at a team that doesn't exist — an
 * employee with no `team` tuple simply fails every `adjust_pto` check, which is the
 * correct closed-world answer.
 */
export const EMPLOYEES: EmployeeNode[] = DIRECTORY.flatMap((entry) => {
  const teamId = teamIdForDepartment(entry.department);
  return teamId ? [{ id: slugify(entry.name), name: entry.name, teamId }] : [];
});

/**
 * Resolves the name a tool was called with to an employee entity id. Tolerant of
 * case and spacing (the planner passes through whatever the user typed), and falls
 * back to a unique first-name match so "adjust Ada's PTO" still resolves.
 */
export function employeeIdForName(name: string): string | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  const exact = EMPLOYEES.find((e) => e.name.toLowerCase() === needle);
  if (exact) return exact.id;
  const bySlug = EMPLOYEES.find((e) => e.id === slugify(name));
  if (bySlug) return bySlug.id;
  const partial = EMPLOYEES.filter(
    (e) =>
      e.name.toLowerCase().includes(needle) ||
      e.name.toLowerCase().split(/\s+/).includes(needle)
  );
  return partial.length === 1 ? partial[0].id : undefined;
}

/**
 * Finds a known employee mentioned anywhere in a sentence, resolving against the actual
 * directory rather than guessing at capitalisation.
 *
 * Guessing is what the planner used to do, and it broke on the most natural phrasing there
 * is: "Adjust Chen Li's PTO" has two capitalised words in a row at the start, so a
 * capitalised-pair regex captures "Adjust Chen". That resolves to nobody, which silently
 * skipped the FGA pre-check (there was no resource to check) and left the user completing
 * a two-factor challenge for a record the tool would then refuse as unknown.
 *
 * Order matters: an exact full-name match wins; then a surname, then a first name, but
 * only when it identifies exactly one person. Ambiguity resolves to nobody rather than to
 * a guess — acting on the wrong employee's PTO is worse than asking again.
 */
export function findEmployeeInText(text: string): EmployeeNode | undefined {
  const haystack = text.toLowerCase();

  const full = EMPLOYEES.find((e) => haystack.includes(e.name.toLowerCase()));
  if (full) return full;

  const wordish = (token: string) =>
    new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack);

  for (const part of ["surname", "given"] as const) {
    const matches = EMPLOYEES.filter((e) => {
      const pieces = e.name.toLowerCase().split(/\s+/);
      const token = part === "surname" ? pieces.slice(1).join(" ") : pieces[0];
      return token ? wordish(token) : false;
    });
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

export function employeeName(employeeId: string): string | undefined {
  return EMPLOYEES.find((e) => e.id === employeeId)?.name;
}

export interface KbSpaceNode {
  /** The Permify entity id — matches an Article's `space`. */
  id: string;
  name: string;
  /** The team whose members (and the org's HR / IT admin) may read the space. */
  teamId: string;
}

/**
 * The knowledge-base spaces. Each restricted article lives in one; every `public`
 * article skips FGA entirely (see lib/knowledge-base.ts).
 */
export const KB_SPACES: KbSpaceNode[] = [
  { id: "hr", name: "People & HR", teamId: "people" },
  { id: "it", name: "IT & Platform ops", teamId: "it" },
  { id: "finance", name: "Finance & payroll", teamId: "finance" },
];

export function kbSpaceName(spaceId: string): string | undefined {
  return KB_SPACES.find((s) => s.id === spaceId)?.name;
}

export interface KbDocNode {
  /** The article id, used as the Permify `kb_doc` entity id. */
  id: string;
  title: string;
  spaceId: string;
}

/**
 * The documents that are FGA-governed: every article carrying a space. Derived from
 * the corpus, so adding a restricted article to lib/knowledge-base.ts is enough to
 * bring it under FGA — no second list to remember.
 */
export const KB_DOCS: KbDocNode[] = ARTICLES.flatMap((article) =>
  article.space === "public"
    ? []
    : [{ id: article.id, title: article.title, spaceId: article.space }]
);

/** True when this article id is governed by a `kb_doc#read` check. */
export function isGovernedDoc(articleId: string): boolean {
  return KB_DOCS.some((d) => d.id === articleId);
}
