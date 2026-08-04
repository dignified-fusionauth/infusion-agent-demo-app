import type { ReactNode } from "react";
import TopNav from "@/components/TopNav";
import { isAdmin } from "@/lib/roles";
import type { Session } from "@/lib/session";

/**
 * Shared chrome for every signed-in page: the session-aware TopNav plus a
 * centered content column. Kept a server component so pages can pass the
 * verified session straight through.
 */
export default function Shell({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  return (
    <>
      <TopNav name={session.name ?? "Employee"} isAdmin={isAdmin(session.roles)} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      <footer className="border-t border-line px-5 py-6 text-center text-xs text-ink-soft">
        InFusion Agent · a FusionAuth demo for agentic AI · not a real assistant
      </footer>
    </>
  );
}
