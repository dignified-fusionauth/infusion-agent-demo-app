<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# InFusion Agent — repo conventions

Three authorization layers, and they must stay independent. Don't "simplify" one to call
another:

- **Scope + role**, checked twice: `sandboxCheck` in `lib/agent.ts` (the agent's own
  pre-flight) and `authGate` in `lib/mcp-server.ts` (the resource server's). The second
  verifies its bearer token through `lib/mcp-auth.ts`, which deliberately stands up its
  own JWKS path rather than importing `lib/session.ts` — that separation *is* the demo.
- **FGA (Permify)**, `lib/fga.ts`: the per-resource question. Also asked twice —
  `fgaPreflight` in the agent, and inside the three resource-bearing tool handlers.

Invariants worth knowing before you edit:

- `permify/schema.perm`, the `AGENT_SCHEMA` constant, and the `demoCheck` fallback
  resolver in `lib/fga.ts` all encode the same rules. Change one, change all three, or
  live and demo mode will disagree.
- `lib/org-graph.ts` *derives* the FGA entity graph from `lib/payroll.ts`,
  `lib/directory.ts`, and `lib/knowledge-base.ts`. Add a team/employee/restricted article
  there, not here.
- Dependencies point one way: mock data modules (`payroll`, `directory`, `tickets`,
  `knowledge-base`) never import a service client. `org-graph` reads them, `fga` reads
  `org-graph`, and the tool handlers read everything.
- Adding a scope to `lib/scopes.ts` is a change to FusionAuth configuration, not just to
  code: an authorize request naming an undefined scope is rejected wholesale, so a new
  catalog entry would break every login. `lib/bff.ts` absorbs that (learn → drop → retry
  once) and `/admin` flags the gap — keep both working if you touch the login path. A
  catalog entry may set `id: null` to ship a tool gated on role alone, which is how
  `search_public_docs` avoids demanding configuration; `scopeForTool` then returns
  undefined, and callers must read that as "no scope check to run", never as "deny".
- Optional services degrade with a visible banner, never a throw: FusionAuth Entity,
  Anthropic, Permify, User Search, the external MCP server. Keep it that way — an honest
  fallback is part of the product, not a workaround.
- Every MCP round trip is wrapped in a hard wall-clock deadline. `Client.connect()` takes
  no timeout of its own, so a server that accepts the socket and never finishes the
  handshake will hang the turn — the per-call `timeout` option does not cover it. Keep
  `MCP_CALL_TIMEOUT_MS` above `EXTERNAL_MCP_TIMEOUT_MS`: one internal tool proxies outward.
- `lib/external-docs.ts` is the only code that leaves the network. Two rules there are
  load-bearing, not stylistic: the employee's access token is never forwarded, and the
  answer is untrusted content — display it, attribute it, and never let it influence tool
  selection or the planner.
- `components/ArchitectureDiagram.tsx` and `components/AuthorizationTrace.tsx` render the
  *same* `TraceStep[]`. A new trace layer needs a `TraceLayer` case in both, or the
  diagram silently ignores it.
