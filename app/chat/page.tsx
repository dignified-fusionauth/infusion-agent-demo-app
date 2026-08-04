import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import AgentModeBanner from "@/components/AgentModeBanner";
import ChatWindow from "@/components/ChatWindow";
import { getSession } from "@/lib/session";
import { agentMode } from "@/lib/agent";
import { primaryAgentRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

/**
 * "Ask Fusion" — the chat surface next to the live authorization trace. proxy.ts
 * gates on the session cookie's presence; this page does the real verification
 * via getSession() and reads the granted scopes off the verified token.
 */
export default async function ChatPage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/chat");

  const mode = agentMode();
  const role = primaryAgentRole(session.roles);

  return (
    <Shell session={session}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink font-[family-name:var(--font-display)]">
            Ask Fusion
          </h1>
          <p className="text-sm text-ink-soft">
            Signed in as {session.name ?? "you"}
            {role ? ` · ${role}` : ""} · {session.scopes.length} scope
            {session.scopes.length === 1 ? "" : "s"} granted
          </p>
        </div>
      </div>

      <div className="mb-5">
        <AgentModeBanner mode={mode} />
      </div>

      <ChatWindow />
    </Shell>
  );
}
