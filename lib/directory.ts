/**
 * Mock employee directory for the `lookup_employee` tool — kept deliberately
 * separate from the real FusionAuth calls in lib/fusionauth.ts, the same split
 * the sibling apps use between lib/accounts.ts / lib/org.ts and lib/fusionauth.ts.
 * Nothing here is a live lookup.
 *
 * The tool tries a real FusionAuth `/api/user` search first (see
 * lib/fusionauth.ts `searchDirectoryUsers`) and only falls back to this list when
 * that search can't run — an honest degrade, never a hard failure.
 */

export interface DirectoryEntry {
  name: string;
  title: string;
  department: string;
  email: string;
  location: string;
}

export const DIRECTORY: DirectoryEntry[] = [
  {
    name: "Ada Okafor",
    title: "Staff Engineer",
    department: "Platform",
    email: "ada.okafor@infusion.example",
    location: "Lagos",
  },
  {
    name: "Bruno Vega",
    title: "Engineering Manager",
    department: "Platform",
    email: "bruno.vega@infusion.example",
    location: "Denver",
  },
  {
    name: "Chen Li",
    title: "IT Administrator",
    department: "IT",
    email: "chen.li@infusion.example",
    location: "Singapore",
  },
  {
    name: "Dara Novak",
    title: "People Operations Lead",
    department: "People",
    email: "dara.novak@infusion.example",
    location: "Prague",
  },
  {
    name: "Elif Demir",
    title: "Payroll Specialist",
    department: "Finance",
    email: "elif.demir@infusion.example",
    location: "Istanbul",
  },
  {
    name: "Farhan Qureshi",
    title: "Support Engineer",
    department: "IT",
    email: "farhan.qureshi@infusion.example",
    location: "Karachi",
  },
];

/** Simple case-insensitive substring match across name / email / department. */
export function searchDirectory(query: string): DirectoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return DIRECTORY.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      e.department.toLowerCase().includes(q) ||
      e.title.toLowerCase().includes(q)
  );
}
