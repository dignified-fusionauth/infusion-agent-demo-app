interface AccountLinksProps {
  accountUrl: string;
  twoFactorUrl: string;
}

const LINKS = [
  {
    key: "profile",
    title: "Profile & password",
    desc: "Update your name, email, and password on FusionAuth's hosted page.",
    icon: "👤",
  },
  {
    key: "twofactor",
    title: "Two-factor methods",
    desc: "Add or remove authenticator apps, email, and SMS — used by step-up.",
    icon: "🔐",
  },
] as const;

/**
 * Links out to FusionAuth's hosted self-service /account pages rather than
 * InFusion Agent building its own — the same approach the sibling apps take.
 */
export default function AccountLinks({
  accountUrl,
  twoFactorUrl,
}: AccountLinksProps) {
  const hrefFor = (key: string) =>
    key === "twofactor" ? twoFactorUrl : accountUrl;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {LINKS.map((link) => (
        <a
          key={link.key}
          href={hrefFor(link.key)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-3 rounded-xl border border-line bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <span className="text-2xl" aria-hidden="true">
            {link.icon}
          </span>
          <div>
            <p className="font-semibold text-ink">{link.title}</p>
            <p className="mt-0.5 text-sm text-ink-soft">{link.desc}</p>
            <span className="mt-2 inline-block text-sm font-semibold text-brand-ink">
              Open →
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}
