# InFusion Agent — a FusionAuth demo for agentic AI

InFusion Agent is the fourth app in the InFusion portfolio, and it takes on
FusionAuth's newest story: **authenticating and authorizing an AI agent.**
[InFusion Bank](https://github.com/dignified-fusionauth/infusionbank-demo-app)
(B2C) shows consumer step-up MFA;
[InFusion Works](https://github.com/dignified-fusionauth/infusion-works) (B2B2E)
shows enterprise SSO; InFusion Market (B2C2B) shows FGA by Permify across a seller
hierarchy. InFusion Agent shows the thing none of them do: an **OAuth 2.1 identity
layer for a non-human actor** — the MCP tool server and RAG retriever that a chat
assistant uses — where every retrieval and every tool call is gated by the *signed-in
employee's actual OAuth scopes*, not a shared service credential and not a
role check baked into the UI.

It then answers the question scopes structurally can't: **which resources?** A scope
says whether the payroll tool may run; it cannot say *whose* payroll, *whose* PTO, or
*which* documents — those depend on a relationship. So the agent's third authorization
layer is **FusionAuth FGA by Permify**, and it is the one that decides what a permitted
tool may actually touch.

"Ask Fusion" is an internal assistant. It can search a knowledge base (RAG) and
take actions (tools), but what a given employee's agent can do changes live based
on what FusionAuth issued that employee at login.

**What it demonstrates:**

1. **Non-human identity.** The MCP tool server has its own FusionAuth identity
   (a Client Credentials **Entity** — FusionAuth's machine-to-machine primitive),
   distinct from the human it acts for — shown side by side in `/admin`.
2. **Least-privilege scopes per tool.** A canonical scope catalog
   (`lib/scopes.ts`) maps one custom OAuth scope to each tool, used identically
   by login, the agent's sandbox pre-check, and the MCP server.
3. **Role-appropriate scopes at login.** The role you sign in as decides which
   scopes your login even *requests* — an employee's login never asks for
   `tools:payroll.read`, so FusionAuth's hosted consent screen never offers it.
4. **Two layered, independent scope checks** — one in the agent's
   sandbox, one in the MCP resource server itself — each requiring *both* the
   scope *and* a permitted role (defense-in-depth), visibly distinct on screen.
5. **Resource-level authorization with FusionAuth FGA (Permify).** A third layer,
   asked in two independent places, that answers the per-resource question: payroll
   narrows to the teams you manage, PTO writes are refused for anyone off your team
   (*after* scope, role and step-up all pass), and RAG results are filtered by
   document relations. One tuple — `team:platform#manager` — cascades to all three.
6. **Scope-filtered RAG, then FGA-filtered RAG.** Retrieval filters by the caller's
   scopes *before* it ranks, so an under-scoped user never learns a restricted article
   exists; the survivors are then checked document by document against the caller's
   relations. A doc must pass both to enter the model's context.
7. **Step-up on sensitive tools.** `view_payroll` and `update_pto_balance`
   require a fresh two-factor check before the tool executes — and the FGA
   pre-check runs *first*, so nobody completes a 2FA challenge for a record FGA
   is going to refuse anyway.
8. **Internal tools first, external tools last — and the external one is authorized
   too.** Every turn considers the five internal tools first. Only then may
   `search_public_docs` reach a **third-party MCP server** for public documentation, and
   only then may the model answer from its own knowledge. The external tool is authorized
   like every other — the sandbox and the resource server both check it — and the
   employee's access token stops at that boundary: a third party can't verify it, so
   nothing user-identifying leaves.
9. **A live authorization trace and a live architecture diagram** — the signature UI —
   both driven by the same step list, so a viewer can follow the whole story without
   narration and see *where* each decision was made.
10. **Scripted or live-LLM planning**, swappable with an env var, with identical
   authorization behavior either way — because the auth layer never trusts the
   planner.

Same conventions as its siblings: Next.js 16 (App Router, Turbopack), React 19,
TypeScript, Tailwind v4; one `lib/fusionauth.ts` that owns the human-auth
FusionAuth calls; `proxy.ts` doing a cheap cookie-presence gate while real
verification happens per-request against FusionAuth's JWKS; one encrypted `jose`
session cookie; **no database** — mock data modules kept deliberately separate
from the real auth calls; and an **honest fallback banner** for optional
services instead of a hard failure — including Permify, which degrades to an in-memory
resolver rather than taking the demo down.

---

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** (no config file — the theme lives in `app/globals.css`)
- **`jose`** for the encrypted session cookie and all JWKS verification
- **`@fusionauth/typescript-client`** for FusionAuth API calls
- **`@modelcontextprotocol/server`** + **`mcp-handler`** for the real MCP server
  (Streamable HTTP resource server), and **`@modelcontextprotocol/client`** for
  the agent's MCP client (the v2 MCP SDK, split into server/client packages)
- **`@anthropic-ai/sdk`** *(optional)* for Live LLM Agent mode and the external
  fallback answer
- **An external MCP server** *(optional, free, no key)* — [DeepWiki](https://mcp.deepwiki.com/mcp)
  by default, reached with the same `@modelcontextprotocol/client` the agent uses for its
  own server. MCP in both directions: the app is an MCP *server* to itself and an MCP
  *client* to a third party. It answers from the public repos behind this stack —
  FusionAuth's docs site and containers, MCP, and Permify
- **FusionAuth FGA by Permify** *(optional)* over its REST API (v1.7.x) — the
  resource-level authorization layer. Self-hosted open-source server for local dev;
  FGA provisioning hosted inside FusionAuth needs the Enterprise plan. No SDK: five
  endpoints, called from one file

> **Route protection lives in `proxy.ts`** (Next.js 16's renamed `middleware`),
> and it only checks that the encrypted session cookie is *present* on `/chat`
> and `/admin`. Real verification — decrypting the cookie and checking the
> enclosed access token against FusionAuth's JWKS — happens per-request in
> `getSession()`. The MCP endpoint (`/api/mcp`) is deliberately not gated here:
> it is its own OAuth resource server and enforces its own bearer-token check.

---

## Prerequisites

- Node.js 20+
- A running FusionAuth instance (local Docker or hosted) to actually sign in.
  The app compiles, type-checks, builds, and boots in **Scripted Agent mode**
  with no FusionAuth reachable — you just can't complete a login until it's
  configured.
- *(Optional)* an Anthropic API key to enable Live LLM Agent mode and the external
  fallback answer.
- The external documentation tool needs **nothing at all** — DeepWiki's public MCP
  server takes no key and no account. Unreachable? The turn degrades to the model's own
  knowledge and says so.
- *(Optional but recommended)* Docker, to run a local Permify server for **live FGA**.
  Without one the resource-level decisions still work — they just come from an
  in-memory resolver, and the UI says so.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # fill in the values (placeholders build fine)

# Optional but recommended: a local Permify server for LIVE FGA.
docker run -p 3476:3476 -p 3478:3478 ghcr.io/permify/permify serve

npm run dev                        # http://localhost:3000
```

The app loads `permify/schema.perm` and writes the company graph (teams, employees,
knowledge-base spaces and documents) on your first visit to `/chat` — see
`lib/fga.ts` `bootstrap` — so there is nothing to hand-load. It also seeds a demo
relation for whoever signs in, chosen by their role, and **only for a user who holds no
relations at all** — so a grant you revoke in `/admin` is never silently re-applied.
Turn seeding off entirely with `INFUSIONAGENT_SEED_DEMO=false`.

Build / verify (the portfolio bar — all pass with placeholder env):

```bash
npx tsc --noEmit
npx eslint .
npx next build
```

---

## Environment variables

Copy `.env.local.example` to `.env.local` and fill it in.

| Variable | What it is |
|---|---|
| `FUSIONAUTH_URL` | Base URL of your FusionAuth instance |
| `FUSIONAUTH_CLIENT_ID` / `_SECRET` | The main "InFusion Agent" Application — the user login app; also the JWT `aud` and where the custom scopes live |
| `FUSIONAUTH_MCP_CLIENT_ID` / `_SECRET` | The tool server's own non-human identity — the **Client Id / secret of a FusionAuth Entity** (client_credentials in FusionAuth is Entity Management, a paid feature — *not* an Application grant). Optional; leave unset to run without the identity card |
| `FUSIONAUTH_MCP_SCOPE` | *(optional)* The Entity token's scope, `target-entity:<entityId>:<permission>`. Required for the client_credentials grant to succeed |
| `FUSIONAUTH_API_KEY` | Server-side calls: two-factor (step-up) and `GET /api/user` (directory lookups, consent roster) |
| `FUSIONAUTH_TENANT_ID` | *(optional)* pin the tenant on a multi-tenant instance |
| `APP_BASE_URL` | Public base URL of this app; builds the redirect URI, same-origin guards, and the URL the agent uses to reach its own MCP server. Default `http://localhost:3000` |
| `SESSION_SECRET` | Secret hashed to the AES key for the session cookie. Generate one with `openssl rand -base64 48` |
| `ANTHROPIC_API_KEY` | *(optional)* enables Live LLM Agent mode |
| `INFUSIONAGENT_ADMIN_ROLE` | *(optional)* the role that unlocks `/admin`. Default `admin` |
| `PERMIFY_URL` | REST base URL of your Permify server. Default `http://localhost:3476`. Unreachable → the honest in-memory fallback |
| `PERMIFY_TENANT` | *(optional)* Permify tenant id. Default `t1` (the server ships with it pre-inserted) |
| `PERMIFY_TOKEN` | *(optional)* bearer token for a secured Permify deployment. The open-source server runs auth-less |
| `PERMIFY_TIMEOUT_MS` | *(optional)* how long a check may take before falling back. Default `2500` |
| `INFUSIONAGENT_SEED_DEMO` | *(optional)* set `false` once you manage relations by hand in `/admin`. Default `true` |
| `EXTERNAL_MCP_URL` | *(optional)* Streamable HTTP endpoint of the external MCP server. Default `https://mcp.deepwiki.com/mcp` — free, no key |
| `EXTERNAL_MCP_TOOL` | *(optional)* the tool to call on it. Default `ask_question` |
| `EXTERNAL_MCP_REPOS` | *(optional)* comma-separated public repos it may be asked about. Defaults to the three this demo runs on |
| `EXTERNAL_MCP_TIMEOUT_MS` | *(optional)* ceiling for the whole external round trip, handshake included. Default `32000` — upstream answers take ~10–20s |
| `MCP_CALL_TIMEOUT_MS` | *(optional)* ceiling for a round trip to the app's own MCP server. Default `55000`; must exceed `EXTERNAL_MCP_TIMEOUT_MS`, since one tool proxies outward |

---

## FusionAuth admin setup

1. **Application → Add**, name it **"InFusion Agent."** On the OAuth tab: set the
   redirect URL to `http://localhost:3000/api/auth/callback`, the Logout URL to
   `http://localhost:3000`, enable the **Authorization Code** and **Refresh
   Token** grants, and turn **Require PKCE** on. Copy the id/secret into
   `FUSIONAUTH_CLIENT_ID` / `_SECRET`.
2. On that Application's **OAuth → Scopes**, add the five custom scopes:
   `tools:kb.read`, `tools:tickets.write`, `tools:directory.read`,
   `tools:payroll.read`, `tools:pto.write`. Mark **`tools:payroll.read`** and
   **`tools:pto.write`** as *requiring user consent*, so FusionAuth's hosted consent
   screen is the moment a manager explicitly grants payroll/PTO access to their agent.

   > **Optional sixth scope, for a different kind of consent.** The external tool
   > (`search_public_docs`) ships **role-gated**, with no scope of its own, so it works
   > without any extra configuration. The more interesting design is to gate it on
   > **egress**: a `tools:docs.read` scope guards no sensitive data at all — the answer is
   > public — it guards *leaving the network*, which is the employee agreeing their agent
   > may send a question outside the company. To enable that: add `tools:docs.read` here
   > (consent-required), set `id: "tools:docs.read"` on that catalog entry in
   > `lib/scopes.ts`, and restart.

   > **You don't have to do this before the app works.** FusionAuth rejects an entire
   > authorize request if *any* requested scope is undefined (`invalid_scope`), which would
   > otherwise mean nobody can log in at any role until every scope above exists. So the
   > login learns instead: it reads which scope FusionAuth didn't recognise, drops it, and
   > retries once (`lib/bff.ts`). The tool that scope unlocks is then denied at the
   > sandbox with the ordinary `missing tools:…` message, `/admin` marks the scope
   > *not on this instance*, and everything else works. Add the scope and restart to pick
   > it up.
3. Add the Roles `employee`, `manager`, and `it-admin` on this Application and
   assign them to your demo users. (Roles ride on the access token's `roles`
   claim automatically — no JWT Populate lambda, same as InFusion Works.)
4. **Give the MCP tool server its own non-human identity** *(optional; needs
   Entity Management, a paid feature)*. In FusionAuth the `client_credentials`
   grant is **not** an Application setting — Applications have no Client
   Credentials checkbox. It's **Entity Management**. So: **Entities → Add**, name
   it **"InFusion Agent — MCP Tool Server"**, of an Entity Type that defines a
   permission (e.g. `tool_execution`). Copy the Entity's **Client Id / Client
   secret** into `FUSIONAUTH_MCP_CLIENT_ID` / `_SECRET`. Then add a **Grant** so
   the entity can target itself with that permission, and set
   `FUSIONAUTH_MCP_SCOPE=target-entity:<entityId>:tool_execution`. Skip this
   whole step to run without the identity card — it degrades to an honest "not
   connected" state.
5. Enable a two-factor method and a step-up policy on the tenant, same as
   InFusion Bank / Works. `view_payroll` and `update_pto_balance` trigger it.
6. Create an **API key** scoped to the two-factor endpoints
   (`/api/two-factor/status`, `/start`, `/send`, `/login`) and `GET /api/user`,
   and put it in `FUSIONAUTH_API_KEY`. `GET /api/user` covers both the directory
   lookups and resolving an email to a user id when you grant an FGA relation in
   `/admin`.
7. **Stand up Permify for live FGA** *(optional)*:

   ```bash
   docker run -p 3476:3476 -p 3478:3478 ghcr.io/permify/permify serve
   ```

   The app writes `permify/schema.perm` and the company graph on first use. To load
   the schema yourself:

   ```bash
   curl -s -X POST "http://localhost:3476/v1/tenants/t1/schemas/write" \
     -H "Content-Type: application/json" \
     --data "$(jq -Rs '{schema: .}' permify/schema.perm)"
   ```

   Note the connection details in `.env.local` (`PERMIFY_URL`, `PERMIFY_TENANT`).
   **FGA-by-Permify provisioning hosted inside FusionAuth requires the Enterprise
   plan;** local dev runs the open-source server, and the app's fallback covers the
   case where no server is up at all.

---

## How auth works here (the one-file tour)

- **`lib/fusionauth.ts`** — every FusionAuth call for the *human* identity:
  hand-built authorize URL (taking the role's scope string), PKCE code exchange,
  JWKS-verified `verifyAccessToken` / `verifyIdToken`, the two-factor step-up
  wrappers, the hosted logout URL, and `getMcpServiceIdentity()` — the tool
  server's own Client Credentials token.
- **`lib/mcp-auth.ts`** — the MCP resource server's *own, independent* bearer
  verifier. It stands up a separate JWKS + `jwtVerify` path on purpose, so the
  "second check" shares no code with the human session reader.
- **`lib/session.ts`** — one encrypted `jose` cookie (`ia_session`), JWKS-verified
  on every read; also the short-lived step-up grant.
- **`lib/scopes.ts`** — the canonical scope catalog, imported by login, the
  sandbox pre-check, and the MCP server.
- **`lib/fga.ts`** — every FusionAuth FGA (Permify) call: the REST client, the schema,
  the tuple writes, the cascade-aware `check`, the per-role demo seeding, and the
  in-memory fallback resolver. The AuthZ half of the platform, deliberately kept apart
  from `lib/fusionauth.ts`'s AuthN half so "two services, one platform" is legible in
  the code and not just the README.
- **`lib/org-graph.ts`** — the company graph FGA authorizes against (org, teams,
  employees, knowledge-base spaces and documents), *derived* from the existing mock data
  so the entity ids can't drift from the payroll lines, the directory, or the corpus.
- **`lib/external-docs.ts`** — the agent as an MCP *client* against a THIRD-PARTY MCP
  server. The mirror image of `lib/mcp-server.ts`, and the only code that leaves the
  network: read its header for why the employee's token isn't forwarded and why what
  comes back is treated strictly as untrusted data.
- **`lib/agent.ts`** — the planner (scripted or Claude), the sandbox pre-check, the FGA
  resource pre-check, the external stages, and the MCP *client* that calls the
  server with the user's bearer token.
- **`lib/mcp-server.ts`** — the six tools; each runs the MCP server's own
  scope + role check off the verified `authInfo`, the three resource-bearing ones
  then run their own FGA checks, and the sixth is the one that calls out.
- **`lib/roles.ts`** — role helpers, including `rolesAllowTool` (the per-tool
  role gate) used by both the sandbox and the MCP server.
- **`proxy.ts`** — the cookie-presence gate.

### The three layers

Every sensitive turn passes through three authorization layers, and the trace colors
them differently so you can tell them apart. The first two answer *may this tool run
at all* — the coarse, per-class question — and each requires **both** the tool's scope
**and** a permitted role (`defaultForRoles` in the scope catalog — the admin role is a
superuser). Scope alone is never enough, so a scope FusionAuth mis-issues to the wrong
role still can't unlock a tool.

The third answers a different question — *which resources may it touch* — and it is the
only one that can, because that answer depends on a relationship.

- **Sandbox (layer 1, in the agent).** `lib/agent.ts` checks the verified
  token's granted scopes *and* roles *before* any MCP call. A missing scope →
  `sandbox: DENIED (missing …)`; a present scope but disallowed role →
  `sandbox: DENIED (role not permitted)`. Either way, no MCP call is attempted.
- **MCP server (layer 2, in the resource server).** `app/api/mcp/route.ts` wraps
  the tools with `withMcpAuth(…, verifyMcpToken, …)`. An unauthenticated request
  gets `401 + WWW-Authenticate` pointing at
  `/.well-known/oauth-protected-resource` (RFC 9728); an authenticated request
  that fails the per-tool scope or role check is refused →
  `mcp: DENIED (missing …)` / `mcp: DENIED (role not permitted)`. The role check
  runs off the token's own `roles` claim, re-verified independently in
  `lib/mcp-auth.ts`.

- **FGA (layer 3, in Permify).** `lib/fga.ts` resolves a **relationship**, not a claim.
  It is asked in two independent places, exactly like the scope check: once by the agent
  as a pre-flight for tools whose arguments name one resource (`fga (pre-check):
  DENIED (employee:chen-li#adjust_pto)`) and once by the resource server for the specific
  teams, employees, or documents a tool is about to touch (`fga (resource server):
  FILTERED (1 of 4 teams)`). A denial here reads as violet, not red-for-scope, because it
  means something different: your token was fine, your relations don't reach that
  resource.

Normally the two scope checks agree — the point of showing both is what
defense-in-depth actually buys you: if the sandbox were ever bypassed or wrong, the MCP
server's independent scope + role check still has to pass.

**Why FGA rather than more scopes.** You could mint `tools:payroll.read:platform`,
`tools:payroll.read:finance`, `tools:pto.write:platform`… and you would be encoding a
relationship in a string, re-issuing tokens whenever an org chart changes, and asking
the consent screen to explain it. The relationship is the real thing: write
`team:platform#manager@user:X` once, and `team#view_payroll`,
`employee#adjust_pto` (two hops, through the employee's team) and `kb_doc#read` (three
hops, through the document's space) all resolve from it. The scope still gates the tool;
FGA gates the rows.

### The FGA relationship graph

The schema (`permify/schema.perm`) models the company in five entity types. It is
deliberately small — every relation and permission in it is used by real code:

```
organization   hr, it_admin                     → all_teams
team           org, manager, member              → view_payroll, manage_people, read_space
employee       team                              → adjust_pto      (2 hops: employee → team)
kb_space       team, reader                      → read
kb_doc         space, reader                     → read            (3 hops: doc → space → team)
```

The *structural* tuples — which team an employee is on, which team a space belongs to,
which space a document lives in — are written once at bootstrap and derived from the
data modules that already exist (`lib/org-graph.ts`), so the FGA entity ids cannot drift
from the payroll lines, the directory, or the RAG corpus. Teams come from
`PAYROLL_SUMMARY`, employees from `DIRECTORY`, documents from `ARTICLES`.

The *grant* tuples are what change per user. A new sign-in is seeded one relation based
on their role, and each persona is a different point on the cascade — so the same
question gets a different answer depending on who asks:

| Signed in as | Seeded relation | Payroll teams | Ada Okafor's PTO (Platform) | Chen Li's PTO (IT) | FGA-governed docs |
|---|---|---|---|---|---|
| `employee` | `team:platform#member` | — | ✗ | ✗ | — |
| `manager` | `team:platform#manager` | Platform | **✓** | **✗** | — |
| `it-admin` | `team:it#manager` + `organization:infusion#it_admin` | IT | ✗ | ✓ | all 4 |
| admin role | `organization:infusion#hr` | all 4 | ✓ | ✓ | all 4 |

The manager row is the one to demo. Scope, role and step-up all pass; Chen Li is on
another team; the write is refused. Note also what `it-admin` *can't* do: running IT
reaches every knowledge-base space but no payroll, because `team#view_payroll` is
`manager or org.hr` and never `org.it_admin`.

Seeding only ever runs for a user who holds **no relations at all**, so a grant you
revoke in `/admin` is never silently re-applied on the next page load or restart; set
`INFUSIONAGENT_SEED_DEMO=false` to disable it outright.

> **Keeping the fallback honest.** `lib/fga.ts` carries an in-memory cascade resolver for
> when no Permify server is reachable, and it mirrors the schema by hand. If you change
> `permify/schema.perm`, change `AGENT_SCHEMA` and `demoCheck` with it — otherwise the
> two modes disagree and the fallback quietly lies. Both are verified to return identical
> answers for all four personas above.

### Internal tools first, external knowledge last

Both planners route the same way, and the trace opens with the routing decision so it's
visible rather than implied:

1. `routing: internal-first` — the five internal tools are always considered first.
2. If one plausibly serves the prompt, it's chosen and the three authorization layers
   above run. The scripted planner decides with `corpusMatches` (a topic match against
   the corpus's titles and tags); the live planner is told to prefer a tool on any close
   call, since an unauthorized attempt is refused safely and therefore costs nothing.
3. **The external tool.** If nothing internal applies but the prompt is about the
   *platform* — FusionAuth, MCP, Permify — `search_public_docs` runs. It is a normal tool
   call in every respect: the sandbox and the resource server's own independent check
   (role-gated here — see the optional egress scope in the setup section).
   The trace shows `sandbox: ALLOWED (role-gated)` → `mcp: ALLOWED` →
   `external: answered from public docs`, and the diagram lights the one edge that
   crosses the boundary. A narrow keyword gate decides this, so "what's the capital of
   Norway" never leaves the network at all.
4. **The model's own knowledge**, last. Logged as
   `external: answered from model knowledge`. It reaches nothing — no tool, no network,
   no company data. With no `ANTHROPIC_API_KEY` there is no such source at all, and the
   app says so rather than inventing an answer.

---

## Demo script (~8 minutes)

Every prompt below is one of the six starter chips on `/chat`, in the order they appear —
so you can run the whole thing by clicking down the list. They're chosen because each one
lands on a *different* authorization outcome, not just a different topic: allowed,
narrowed, refused at the scope, refused at the relationship, out to a third party, and no
tool at all.

1. **Sign in as an employee.** Note the consent screen never offers payroll or
   PTO — the employee's login didn't request those scopes.
2. **Ask "what's our PTO policy."** A public RAG doc comes back; the trace shows
   `routing: internal-first`, `sandbox: ALLOWED` and `mcp: ALLOWED`.
3. **Ask "show me last month's payroll numbers."** The sandbox denies it *before*
   any MCP call, and the trace shows exactly why — `sandbox: DENIED (missing
   tools:payroll.read)` if the employee's token never got the scope, or
   `sandbox: DENIED (role not permitted)` if the scope is present but the
   employee role isn't allowed (the role gate is defense-in-depth, so either
   way the tool is blocked).
4. **Sign out, sign in as a manager.** The consent screen now offers the payroll
   scope; grant it. Ask the same question: it passes the sandbox (scope + role),
   reaches the MCP server, triggers step-up, you verify — and the answer covers
   **Platform only**, because `fga (resource server): FILTERED (1 of 4 teams)`. The
   manager's one seeded relation is `team:platform#manager`; the other three teams'
   rows never leave the tool.
5. **Ask "adjust Ada Okafor's PTO by 2 days."** Allowed — Ada is on Platform.
   Now ask the same for **Chen Li** (IT): `fga (pre-check): DENIED
   (employee:chen-li#adjust_pto)`, raised *before* the step-up prompt and before any
   MCP call. Scope, role and 2FA were all fine; the relationship wasn't. This is the
   beat that shows what scopes structurally cannot do.
6. **Ask "What is a FusionAuth Entity?"** No internal tool applies, but this is a platform
   question — so the agent leaves the network. (The answer describes the very primitive
   this demo uses for its tool server's non-human identity. "How does Permify model
   relationships?" works the same way.) The trace shows
   `sandbox: ALLOWED (role-gated)` → `mcp: ALLOWED` →
   `external: answered from public docs`, the diagram lights the **External Tool** node
   off to the right, and the answer is attributed to the third-party server it came from.
   Note what the trace does *not* show: any forwarding of your access token.
7. **Ask "what's the capital of Norway?"** Not internal, and not a platform question
   either — so nothing leaves the network. The trace shows
   `external: answered from model knowledge` and the reply says plainly where it came
   from. Three rungs, and you can see which one answered.
8. **Open `/admin`.** The scope catalog, the two FusionAuth identities side by side
   (user-login **Application** vs. the tool server's Client-Credentials **Entity**), and
   the **FGA section**: the schema, and the live relationship table. Now **revoke your
   own `team:platform#manager`**, go back to `/chat`, and ask the payroll question
   again — same token, same scopes, same role, and now a flat refusal. Re-grant it and
   it works again. Nothing was re-issued; only a relationship changed.
9. **Stop the Permify container and reload `/chat`.** The banner turns amber and says
   the decisions are coming from the in-memory resolver. Every step above still behaves
   the same — the demo survives without the server, and it doesn't pretend otherwise.
10. **Set `ANTHROPIC_API_KEY` and restart.** Same conversation, but planning is
   now a real Claude tool-calling loop instead of the scripted planner — and the
   authorization trace is unchanged, because the auth layer never trusted the
   planner in the first place.

---

## Non-goals

- **No real ticketing / payroll / HR backend** — `lib/tickets.ts`,
  `lib/payroll.ts`, and `lib/directory.ts` are mock data; created tickets and PTO
  edits live in memory and reset on restart.
- **No production-grade MCP hardening** — no dynamic client registration, no
  token revocation/rotation. This demonstrates the auth *shape*, not a hardened
  deployment.
- **No vector database / real embeddings** — the RAG corpus is a small in-memory
  set with a keyword-overlap scorer. The retrieval, scope-filtering and
  document-relation-filtering code is real; the corpus is intentionally tiny.
- **No FusionAuth-hosted FGA provisioning** — that needs the Enterprise plan. Local dev
  runs the open-source Permify server, and the app talks to it over plain REST.
- **The in-memory FGA fallback walks the cascade in app code**, which is precisely what
  Permify exists to replace. That is deliberate: it keeps the demo runnable with no
  server, and the banner never lets it masquerade as the real thing. It is the *only*
  traversal in this codebase.
- **The external tool's remit is bounded, and honestly so.** It answers about the four
  public repos this stack is built on — FusionAuth's documentation site and its container
  deployment, MCP, and Permify — because those are what the default server has indexed. It
  is not a web search and doesn't pretend to be. Point `EXTERNAL_MCP_REPOS` elsewhere to
  move it, but update the tool's description with it: a tool advertising a remit it can't
  answer for is worse than a narrow one. (A repo DeepWiki hasn't indexed is tolerated — it
  answers from the rest. To add one, visit `deepwiki.com/<owner>/<repo>` and index it.)
- **Third-party answers are untrusted content.** What the external server returns lands
  in a model's context window, which makes it a prompt-injection surface. The app does
  exactly two things with it: displays it, attributed as external, and nothing else. It is
  never treated as instructions, never used to pick a tool, never fed back to the planner.
  Hardening that boundary further is out of scope here — naming it is not.
- **FGA doesn't govern every tool.** `lookup_employee` and `create_it_ticket` have no
  resource check — the directory is company-wide by design and a new ticket has no
  pre-existing resource to relate to. Nor does `search_public_docs`: it is one public
  endpoint with a fixed remit, so there is nothing per-resource to filter, and the only
  interesting question about it — may this agent leave the network at all — is one a scope
  expresses well (see the optional `tools:docs.read` in the setup section). Not every tool
  needs resource-level authorization, and pretending otherwise would misrepresent the model.
- **No multi-tenant story.**
- **The `?role=` login hint is only a UX decision** — it picks which scopes a
  sign-in *requests*, never what's enforced. Enforcement uses the verified
  `scope` **and** `roles` claims together, checked independently at the sandbox
  and the MCP server (defense-in-depth): a tool runs only when the token carries
  the scope *and* the role is permitted, so a scope FusionAuth mis-issues to the
  wrong role can't unlock it on its own.

---

## Project structure

```
app/
  page.tsx                          Landing — the non-human-identity story + role picker
  chat/page.tsx                     "Ask Fusion" — chat + live authorization trace
  admin/page.tsx                    Role-gated: scope catalog, the two identities, demo users, FGA relations
  api/auth/login|callback|logout/   PKCE flow (login requests role-appropriate scopes)
  api/chat/route.ts                 Agent turn: route → plan → sandbox → FGA pre-check → step-up → MCP → reply
  api/mcp/route.ts                  The MCP server (Streamable HTTP, OAuth-protected)
  api/admin/fga/route.ts            Admin-gated grant/revoke of Permify relation tuples
  api/two-factor/status|verify/     Step-up status + completion
  .well-known/oauth-protected-resource/route.ts   RFC 9728 metadata
  layout.tsx, globals.css
lib/
  fusionauth.ts     Human AuthN: authorize/callback/logout, JWKS verify, two-factor, CC token
  mcp-auth.ts       Independent bearer verifier for the MCP server itself
  mcp-server.ts     Tool registry + 6 handlers (own scope + role check, then FGA per resource)
  external-docs.ts  The agent as an MCP CLIENT to a third-party server — the one call that leaves
  fga.ts            FusionAuth FGA (Permify): schema, tuples, cascade checks, seeding, fallback
  org-graph.ts      The company graph FGA authorizes against, derived from the mock data
  agent.ts          Planner (scripted|Claude) + sandbox + FGA pre-check + external stage + MCP client
  knowledge-base.ts Mock RAG corpus + scope-filtered retrieval + the internal-first router
  scopes.ts         Canonical scope catalog
  session.ts        Encrypted cookie (JWKS-verified reads) + step-up grant
  bff.ts, pkce.ts, roles.ts
  tickets.ts / directory.ts / payroll.ts   Mock data for the tool handlers
components/
  ChatWindow.tsx  AuthorizationTrace.tsx  ArchitectureDiagram.tsx  AgentModeBanner.tsx
  FgaModeBanner.tsx  FgaSchemaViewer.tsx  FgaRelationshipAdmin.tsx
  ScopeConsentPreview.tsx  NonHumanIdentityCard.tsx  StepUpSlip.tsx
  Shell.tsx  TopNav.tsx  AccountLinks.tsx
permify/
  schema.perm       The Permify (ReBAC) schema — org → team → employee, space → doc
proxy.ts
```
