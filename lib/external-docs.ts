import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/**
 * The one tool that leaves the company network.
 *
 * Everything else in this app reaches internal systems on behalf of the signed-in
 * employee, carrying that employee's access token as the bearer. This module is the
 * opposite case, and it exists to make the boundary visible: the agent acting as an MCP
 * *client* against a THIRD-PARTY MCP server, over the same Streamable HTTP transport its
 * own resource server speaks (lib/mcp-server.ts). MCP in both directions, one library.
 *
 * The default endpoint is DeepWiki's public MCP server, which answers questions about
 * indexed public GitHub repositories. It needs no key and no account, and the repos it is
 * pointed at are the technologies this demo is built on — FusionAuth (its documentation
 * site and its container deployment), MCP itself, and Permify — so "ask the outside world"
 * means asking about the platform rather than about company data. Answers take roughly
 * 10–20s (they are themselves model-generated upstream, over a large docs index), which is
 * why the timeout is generous.
 *
 * The remit is exactly what those repos cover, and the tool's description says so. If you
 * point EXTERNAL_MCP_REPOS somewhere else, update the description with it — a tool that
 * advertises a remit it can't answer for is worse than a narrow one. An unindexed repo in
 * the list is tolerated by the upstream server: it answers from the rest.
 *
 * Two properties worth reading the code for:
 *
 *  1. **The employee's token stops at the boundary.** It is never forwarded here. A third
 *     party couldn't verify it anyway (it's signed for, and audience-bound to, this
 *     app's FusionAuth Application), and forwarding it would leak a company credential
 *     to an unrelated service. The outbound request carries no user identity at all —
 *     this server requires no credential, and if it did, the right one would be the tool
 *     server's own non-human identity (lib/fusionauth.ts `getMcpServiceIdentity`), never
 *     the human's.
 *
 *  2. **What comes back is untrusted DATA.** The answer text is third-party content that
 *     ends up inside a model's context window, which makes it a prompt-injection surface.
 *     The app therefore does exactly two things with it: shows it to the user, labelled
 *     as external, and nothing else. It is never treated as instructions, never used to
 *     pick a tool, and never fed back into the planner.
 */

/**
 * The public repositories the external tool is allowed to ask about. Not arbitrary — the
 * stack this demo runs on, so the tool has an honest remit rather than being a
 * general-purpose web hole.
 */
const DEFAULT_REPOS = [
  // FusionAuth's own docs site — the product documentation, so questions like "what is
  // an Entity" (the very primitive this demo's tool server uses for its non-human
  // identity) get a real answer rather than a deployment detail.
  "FusionAuth/fusionauth-site",
  "FusionAuth/fusionauth-containers",
  "modelcontextprotocol/modelcontextprotocol",
  "Permify/permify",
];

export const externalDocsConfig = {
  /** Streamable HTTP endpoint of the external MCP server. */
  get url() {
    return (
      process.env.EXTERNAL_MCP_URL || "https://mcp.deepwiki.com/mcp"
    ).replace(/\/$/, "");
  },
  /** The tool to call on that server. */
  get toolName() {
    return process.env.EXTERNAL_MCP_TOOL || "ask_question";
  },
  /** Comma-separated override for the repositories it may be asked about. */
  get repos(): string[] {
    const raw = process.env.EXTERNAL_MCP_REPOS;
    if (!raw) return DEFAULT_REPOS;
    const parsed = raw.split(",").map((r) => r.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_REPOS;
  },
  /**
   * Per-call timeout. The upstream answer is itself model-generated and typically takes
   * ~5s, so this is deliberately generous — but bounded, because a chat turn must not
   * hang on a third party.
   */
  get timeoutMs() {
    return Number(process.env.EXTERNAL_MCP_TIMEOUT_MS) || 32000;
  },
  /** A short label for the trace and the reply. */
  get serverLabel() {
    return new URL(externalDocsConfig.url).host;
  },
};

/**
 * A hard wall-clock bound around a promise.
 *
 * Needed because `Client.connect()` takes NO timeout of its own — only `callTool` does.
 * A server that accepts the TCP connection but never completes the MCP handshake would
 * otherwise hang here forever, and `EXTERNAL_MCP_TIMEOUT_MS` wouldn't save us because it
 * only bounds the call that never gets made. That is not hypothetical: a polling script
 * written against this same endpoint wedged in exactly this way, silently, for an hour.
 * A chat turn must never be at a third party's mercy.
 */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms`)),
      ms
    );
  });
  return (Promise.race([work, guard]) as Promise<T>).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface ExternalDocsAnswer {
  ok: boolean;
  /** The third-party answer text. Untrusted content — display only. */
  answer?: string;
  /** Which server answered, for an honest attribution in the reply. */
  server: string;
  repos: string[];
  /** Why the call produced nothing usable, when it didn't. */
  reason?: string;
}

/**
 * Asks the external MCP server a question about the public docs. Never throws: an
 * unreachable server, a timeout, or an unindexed repository all come back as
 * `ok: false` with a reason, so the caller can degrade to the next stage instead of
 * failing the turn — the same honest-fallback convention the rest of the app uses.
 */
export async function askPublicDocs(
  question: string
): Promise<ExternalDocsAnswer> {
  const { url, toolName, repos, timeoutMs, serverLabel } = externalDocsConfig;
  const base: ExternalDocsAnswer = { ok: false, server: serverLabel, repos };

  const trimmed = question.trim();
  if (!trimmed) return { ...base, reason: "No question to ask." };

  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({
    name: "infusion-agent-external-docs",
    version: "0.1.0",
  });

  // One budget for the whole round trip — handshake included — so a slow connect eats
  // into the call's time rather than extending the turn.
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1_000, deadline - Date.now());

  try {
    await withDeadline(
      client.connect(transport),
      Math.min(8_000, remaining()),
      "MCP handshake"
    );
    const res = await withDeadline(
      client.callTool(
        {
          name: toolName,
          // `repoName` accepts a list, so one call spans the whole allowed remit. An
          // unindexed repo among them is tolerated upstream: it answers from the rest.
          arguments: { repoName: repos, question: trimmed },
        },
        { timeout: remaining() }
      ),
      remaining(),
      "external tool call"
    );

    const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (res.isError || !text) {
      return { ...base, reason: text || "The external server returned no answer." };
    }
    // The upstream reports an unindexed repository as a normal text result; treat it as
    // "no answer" rather than passing an error string off as documentation.
    if (/repository not found|not indexed/i.test(text)) {
      return {
        ...base,
        reason: `${serverLabel} has no index for ${repos.join(", ")}.`,
      };
    }
    return { ...base, ok: true, answer: text };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "The external MCP server was unreachable.";
    console.error("[external-docs] call failed:", reason);
    return { ...base, reason };
  } finally {
    try {
      // Bounded too — a wedged transport must not keep the turn open on the way out.
      await withDeadline(client.close(), 3_000, "MCP close");
    } catch {
      // ignore close errors
    }
  }
}
