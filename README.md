# InFusion Agent — a FusionAuth demo for agentic AI

InFusion Agent is the fourth app in the InFusion portfolio, and it takes on
FusionAuth's newest story: **authenticating and authorizing an AI agent.**
[InFusion Bank](https://github.com/dignified-fusionauth/infusionbank-demo-app)
(B2C) shows consumer step-up MFA;
[InFusion Works](https://github.com/dignified-fusionauth/infusion-works) (B2B2E)
shows enterprise SSO; InFusion Market (B2C2B) shows live FGA by Permify. InFusion
Agent shows the thing none of them do: an **OAuth 2.1 identity layer for a
non-human actor** — the MCP tool server and RAG retriever that a chat assistant
uses — where every retrieval and every tool call is gated by the *signed-in
employee's actual OAuth scopes*, not a shared service credential and not a
role check baked into the UI.

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
4. **Two layered, independent authorization checks** — one in the agent's
   sandbox, one in the MCP resource server itself — each requiring *both* the
   scope *and* a permitted role (defense-in-depth), visibly distinct on screen.
5. **Scope-filtered RAG.** Retrieval filters by the caller's scopes *before* it
   ranks, so an under-scoped user never even learns a restricted article exists.
6. **Step-up on sensitive tools.** `view_payroll` and `update_pto_balance`
   require a fresh two-factor check before the tool executes.
7. **A live authorization trace** — the signature UI — that logs every step of
   every turn so a viewer can follow the whole story without narration.
8. **Scripted or live-LLM planning**, swappable with an env var, with identical
   authorization behavior either way — because the auth layer never trusts the
   planner.

Same conventions as its siblings: Next.js 16 (App Router, Turbopack), React 19,
TypeScript, Tailwind v4; one `lib/fusionauth.ts` that owns the human-auth
FusionAuth calls; `proxy.ts` doing a cheap cookie-presence gate while real
verification happens per-request against FusionAuth's JWKS; one encrypted `jose`
session cookie; **no database** — mock data modules kept deliberately separate
from the real auth calls; and an **honest fallback banner** for optional
services instead of a hard failure.

---

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** (no config file — the theme lives in `app/globals.css`)
- **`jose`** for the encrypted session cookie and all JWKS verification
- **`@fusionauth/typescript-client`** for FusionAuth API calls
- **`@modelcontextprotocol/server`** + **`mcp-handler`** for the real MCP server
  (Streamable HTTP resource server), and **`@modelcontextprotocol/client`** for
  the agent's MCP client (the v2 MCP SDK, split into server/client packages)
- **`@anthropic-ai/sdk`** *(optional)* for Live LLM Agent mode

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
- *(Optional)* an Anthropic API key to enable Live LLM Agent mode.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # fill in the values (placeholders build fine)
npm run dev                        # http://localhost:3000
```

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
   **`tools:pto.write`** as *requiring user consent*, so FusionAuth's hosted
   consent screen is the moment a manager explicitly grants payroll/PTO access
   to their agent.
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
   and put it in `FUSIONAUTH_API_KEY`.

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
- **`lib/agent.ts`** — the planner (scripted or Claude), the sandbox pre-check,
  and the MCP *client* that calls the server with the user's bearer token.
- **`lib/mcp-server.ts`** — the five tools; each runs the MCP server's own
  scope + role check off the verified `authInfo`.
- **`lib/roles.ts`** — role helpers, including `rolesAllowTool` (the per-tool
  role gate) used by both the sandbox and the MCP server.
- **`proxy.ts`** — the cookie-presence gate.

### The two independent checks

Every sensitive turn passes through two authorization layers, and the trace
colors them differently so you can tell them apart:

Each layer requires **both** the tool's scope **and** a permitted role
(`defaultForRoles` in the scope catalog — the admin role is a superuser). Scope
alone is never enough, so a scope FusionAuth mis-issues to the wrong role still
can't unlock a tool.

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

Normally both agree — the point of showing both is what defense-in-depth
actually buys you: if the sandbox were ever bypassed or wrong, the MCP server's
independent scope + role check still has to pass.

---

## Demo script (~5 minutes)

1. **Sign in as an employee.** Note the consent screen never offers payroll or
   PTO — the employee's login didn't request those scopes.
2. **Ask "what's our PTO policy."** A public RAG doc comes back; the trace shows
   `sandbox: ALLOWED` and `mcp: ALLOWED`.
3. **Ask "show me last month's payroll numbers."** The sandbox denies it *before*
   any MCP call, and the trace shows exactly why — `sandbox: DENIED (missing
   tools:payroll.read)` if the employee's token never got the scope, or
   `sandbox: DENIED (role not permitted)` if the scope is present but the
   employee role isn't allowed (the role gate is defense-in-depth, so either
   way the tool is blocked).
4. **Sign out, sign in as a manager.** The consent screen now offers the payroll
   scope; grant it. Ask the same question: it passes the sandbox (scope + role),
   reaches the MCP server, triggers step-up, you verify, and the tool executes.
5. **Open `/admin`.** See the scope catalog and the two FusionAuth identities
   side by side — the user-login **Application** and the tool server's own
   Client-Credentials **Entity**.
6. **Set `ANTHROPIC_API_KEY` and restart.** Same conversation, but planning is
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
  set with a keyword-overlap scorer. The retrieval + scope-filtering code is
  real; the corpus is intentionally tiny.
- **No FGA / Permify** — that's InFusion Market's beat. This app's beat is
  OAuth-for-agents, MCP resource-server auth, and scope- + role-gated tool calls.
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
  admin/page.tsx                    Role-gated: scope catalog, the two FusionAuth identities, demo users
  api/auth/login|callback|logout/   PKCE flow (login requests role-appropriate scopes)
  api/chat/route.ts                 Agent turn: plan → sandbox → step-up → MCP call → reply
  api/mcp/route.ts                  The MCP server (Streamable HTTP, OAuth-protected)
  api/two-factor/status|verify/     Step-up status + completion
  .well-known/oauth-protected-resource/route.ts   RFC 9728 metadata
  layout.tsx, globals.css
lib/
  fusionauth.ts     Human AuthN: authorize/callback/logout, JWKS verify, two-factor, CC token
  mcp-auth.ts       Independent bearer verifier for the MCP server itself
  mcp-server.ts     Tool registry + 5 handlers (each runs its own scope check)
  agent.ts          Planner (scripted|Claude) + sandbox pre-check + MCP client + trace
  knowledge-base.ts Mock RAG corpus + scope-filtered retrieval
  scopes.ts         Canonical scope catalog
  session.ts        Encrypted cookie (JWKS-verified reads) + step-up grant
  bff.ts, pkce.ts, roles.ts
  tickets.ts / directory.ts / payroll.ts   Mock data for the tool handlers
components/
  ChatWindow.tsx  AuthorizationTrace.tsx  AgentModeBanner.tsx
  ScopeConsentPreview.tsx  NonHumanIdentityCard.tsx  StepUpSlip.tsx
  Shell.tsx  TopNav.tsx  AccountLinks.tsx
proxy.ts
```
