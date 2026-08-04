import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import {
  FusionAuthClient,
  MultiFactorAction,
  Sort,
  type AccessToken,
} from "@fusionauth/typescript-client";

/**
 * All the FusionAuth wiring for InFusion Agent's HUMAN identity lives in this one
 * file, so during a demo you can point to a single place and walk through exactly
 * what talks to FusionAuth and when. Server-side calls go through the official
 * `@fusionauth/typescript-client`; JWT signature verification is done separately
 * with `jose` (the client doesn't verify signatures). There is NO browser SDK —
 * the front end only ever hits this app's own /api/auth/* routes.
 *
 * The concerns handled here, kept deliberately separate:
 *   1. Authorization Code + PKCE against the hosted login, requesting a
 *      role-appropriate set of custom `tools:*` scopes (see lib/scopes.ts).
 *   2. JWKS verification of the id_token / access_token for the USER session.
 *   3. Two-Factor "status" + "login" APIs -> step-up before a sensitive tool runs.
 *   4. The MCP tool server's OWN non-human identity via the Client Credentials
 *      grant on a FusionAuth Entity (Entity Management) — distinct from the user
 *      it acts for. NOTE: in FusionAuth client_credentials is Entity Management,
 *      not an Application grant (Applications have no such grant).
 *
 * NOTE: the MCP resource server verifies bearer tokens through its OWN, separate
 * verifier in lib/mcp-auth.ts — it deliberately does NOT import verifyAccessToken
 * from here, so the "second, independent check" is real and not cosmetic.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.local.example to .env.local and fill it in.`
    );
  }
  return value;
}

export const fusionAuthConfig = {
  get baseUrl() {
    return required("FUSIONAUTH_URL").replace(/\/$/, "");
  },
  get tenantId() {
    return process.env.FUSIONAUTH_TENANT_ID || undefined;
  },
  get clientId() {
    return required("FUSIONAUTH_CLIENT_ID");
  },
  get clientSecret() {
    return required("FUSIONAUTH_CLIENT_SECRET");
  },
  /**
   * The MCP tool server's OWN non-human identity. In FusionAuth the
   * client_credentials grant is Entity Management (paid), so these are an
   * ENTITY's Client Id + Client secret — not an Application's. See
   * getMcpServiceIdentity + the README setup.
   */
  get mcpClientId() {
    return required("FUSIONAUTH_MCP_CLIENT_ID");
  },
  get mcpClientSecret() {
    return required("FUSIONAUTH_MCP_CLIENT_SECRET");
  },
  get apiKey() {
    return required("FUSIONAUTH_API_KEY");
  },
  get appBaseUrl() {
    return (process.env.APP_BASE_URL || "http://localhost:3000").replace(
      /\/$/,
      ""
    );
  },
};

/** The redirect_uri handed to FusionAuth's /oauth2/authorize — our callback route. */
export const oauthRedirectUri = () =>
  `${fusionAuthConfig.appBaseUrl}/api/auth/callback`;

/**
 * One shared client, authenticated with the API key for the server-only calls
 * (Two-Factor, user search). The OAuth token calls authenticate with the
 * code/refresh-token instead, which the client handles per-method.
 */
let client: FusionAuthClient | null = null;
function faClient(): FusionAuthClient {
  if (!client) {
    client = new FusionAuthClient(
      fusionAuthConfig.apiKey,
      fusionAuthConfig.baseUrl,
      fusionAuthConfig.tenantId
    );
  }
  return client;
}

// ---------------------------------------------------------------------------
// 1. Authorization Code + PKCE  (with role-appropriate custom scopes)
// ---------------------------------------------------------------------------

/** Well-known OIDC discovery document endpoint for this tenant. */
function wellKnownUrl() {
  const tenantSegment = fusionAuthConfig.tenantId
    ? `/${fusionAuthConfig.tenantId}`
    : "";
  return `${fusionAuthConfig.baseUrl}/.well-known/openid-configuration${tenantSegment}`;
}

/**
 * Builds the URL that starts the hosted-login redirect. Hand-built because
 * front-channel authorize URLs are browser redirects, not API calls.
 *
 * `scope` is the crux of this app: it's the space-delimited scope string for the
 * signing-in role (see lib/scopes.ts `defaultScopeStringForRole`). An employee's
 * scope string never contains `tools:payroll.read`, so FusionAuth's hosted
 * consent screen never even offers payroll access at that role.
 */
export function buildAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
  scope: string;
  tenantId?: string;
}) {
  const url = new URL(`${fusionAuthConfig.baseUrl}/oauth2/authorize`);
  url.searchParams.set("client_id", fusionAuthConfig.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", oauthRedirectUri());
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  const tenantId = opts.tenantId || fusionAuthConfig.tenantId;
  if (tenantId) url.searchParams.set("tenantId", tenantId);

  return url.toString();
}

/** Exchanges the authorization code for tokens (PKCE). Server-side only. */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<AccessToken> {
  const res = await faClient().exchangeOAuthCodeForAccessTokenUsingPKCE(
    code,
    fusionAuthConfig.clientId,
    fusionAuthConfig.clientSecret,
    oauthRedirectUri(),
    codeVerifier
  );
  return res.response;
}

/** Trades a refresh token for a fresh access token. Server-side only. */
export async function refreshAccessToken(
  refreshToken: string
): Promise<AccessToken> {
  const res = await faClient().exchangeRefreshTokenForAccessToken(
    refreshToken,
    fusionAuthConfig.clientId,
    fusionAuthConfig.clientSecret,
    "",
    ""
  );
  return res.response;
}

// ---------------------------------------------------------------------------
// Logout + hosted self-service account URLs
// ---------------------------------------------------------------------------

/**
 * Logout URL to use because self-service account management is enabled. Since
 * FusionAuth 1.45.0 the hosted /account pages run their own session; hitting
 * /oauth2/logout alone leaves it alive, so we use /account/logout, which ends
 * the account session and chains into /oauth2/logout. `client_id` is the only
 * parameter to send (plus `tenantId` on a multi-tenant instance). Do NOT add a
 * post_logout_redirect_uri — an unregistered target makes FusionAuth skip the
 * logout entirely. The final landing page is the Application's configured
 * "Logout URL" in the FusionAuth admin.
 */
export function buildAccountLogoutUrl(tenantId?: string) {
  const url = new URL(`${fusionAuthConfig.baseUrl}/account/logout`);
  url.searchParams.set("client_id", fusionAuthConfig.clientId);
  const tid = tenantId || fusionAuthConfig.tenantId;
  if (tid) url.searchParams.set("tenantId", tid);
  return url.toString();
}

/** Hosted self-service account management page (FusionAuth's own UI). */
export function accountManagementUrl() {
  const url = new URL(`${fusionAuthConfig.baseUrl}/account/edit`);
  url.searchParams.set("client_id", fusionAuthConfig.clientId);
  return url.toString();
}

/** The MFA-methods page within FusionAuth's hosted self-service account UI. */
export function twoFactorManagementUrl() {
  const url = new URL(`${fusionAuthConfig.baseUrl}/account/two-factor/`);
  url.searchParams.set("client_id", fusionAuthConfig.clientId);
  return url.toString();
}

// ---------------------------------------------------------------------------
// 2. JWKS verification (USER session)
// ---------------------------------------------------------------------------

/**
 * The tenant's Issuer and its JWKS endpoint both come from the OIDC discovery
 * document, NOT from the base URL — they differ on a custom domain. Fetch once
 * and cache so verification uses the real values.
 */
interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
}

let discovery: Promise<OidcDiscovery> | null = null;
function getDiscovery(): Promise<OidcDiscovery> {
  if (!discovery) {
    discovery = (async () => {
      const res = await fetch(wellKnownUrl());
      if (!res.ok) {
        discovery = null; // don't cache failures
        throw new Error(`OIDC discovery failed (${res.status}).`);
      }
      const doc = (await res.json()) as OidcDiscovery;
      return { issuer: doc.issuer, jwks_uri: doc.jwks_uri };
    })();
  }
  return discovery;
}

/**
 * The issuer of the FusionAuth Application acting as this app's OAuth
 * Authorization Server — advertised by the MCP resource server's RFC 9728
 * metadata (see app/.well-known/oauth-protected-resource). Falls back to the
 * base URL when discovery can't be reached, so the metadata route never throws.
 */
export async function authorizationServerIssuer(): Promise<string> {
  try {
    return (await getDiscovery()).issuer;
  } catch {
    return fusionAuthConfig.baseUrl;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function getJwks() {
  if (!jwks) {
    const { jwks_uri } = await getDiscovery();
    jwks = createRemoteJWKSet(new URL(jwks_uri));
  }
  return jwks;
}

export interface FusionAuthUserClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  picture?: string;
  /** Present on the ACCESS token; absent on the id_token. */
  roles?: string[];
  /** Space-delimited granted scopes, on the ACCESS token. */
  scope?: string;
  /** Allow reading any other claim without an unsafe cast at the call site. */
  [claim: string]: unknown;
}

/** Verifies the id_token's signature + issuer/audience before trusting it. */
export async function verifyIdToken(
  idToken: string
): Promise<FusionAuthUserClaims> {
  const [keys, { issuer }] = await Promise.all([getJwks(), getDiscovery()]);
  const { payload } = await jwtVerify(idToken, keys, {
    issuer,
    audience: fusionAuthConfig.clientId,
  });
  return payload as unknown as FusionAuthUserClaims;
}

/**
 * Verifies the access_token the same way. Used server-side to turn the encrypted
 * session cookie's stored access token back into trusted identity + role + scope
 * claims (see lib/session.ts). FusionAuth access tokens are JWTs whose `aud` is
 * the application/client id.
 */
export async function verifyAccessToken(
  accessToken: string
): Promise<FusionAuthUserClaims> {
  const [keys, { issuer }] = await Promise.all([getJwks(), getDiscovery()]);
  const { payload } = await jwtVerify(accessToken, keys, {
    issuer,
    audience: fusionAuthConfig.clientId,
  });
  return payload as unknown as FusionAuthUserClaims;
}

// ---------------------------------------------------------------------------
// 3. Step-up auth (Two-Factor status + login), API-key driven
// ---------------------------------------------------------------------------

export interface TwoFactorMethod {
  id: string;
  method: string;
  email?: string;
  mobilePhone?: string;
}

export interface TwoFactorStatusResult {
  challengeRequired: boolean;
}

export interface StepUpChallenge {
  twoFactorId: string;
  methods: TwoFactorMethod[];
}

/**
 * Asks FusionAuth whether this user needs to complete MFA before performing
 * `action`. The step-up-auth pattern from the FusionAuth docs. FusionAuth returns
 * HTTP 242 when a challenge is required and 200 when it isn't; both are 2xx, so
 * we branch on `statusCode`. Runs with the app's own API key, never the user's
 * token — these are privileged FusionAuth APIs.
 */
export async function checkTwoFactorStatus(opts: {
  userId: string;
  action: string;
  ipAddress?: string;
}): Promise<TwoFactorStatusResult> {
  const res = await faClient().retrieveTwoFactorStatusWithRequest({
    userId: opts.userId,
    applicationId: fusionAuthConfig.clientId,
    action: MultiFactorAction.stepUp,
    eventInfo: {
      data: { action: opts.action },
      ...(opts.ipAddress ? { ipAddress: opts.ipAddress } : {}),
    },
  });

  return { challengeRequired: res.statusCode === 242 };
}

/**
 * Starts the step-up challenge once /status has said one is required. Only
 * /start hands back the twoFactorId + enrolled methods; for message-based
 * methods (email/SMS) we then ask FusionAuth to deliver the code via /send.
 */
export async function startTwoFactorChallenge(opts: {
  userId: string;
}): Promise<StepUpChallenge> {
  const startRes = await faClient().startTwoFactorLogin({
    userId: opts.userId,
    applicationId: fusionAuthConfig.clientId,
  });

  const twoFactorId = startRes.response.twoFactorId ?? "";
  const methods = (startRes.response.methods ?? []) as TwoFactorMethod[];

  const primary = methods[0];
  if (primary && (primary.method === "email" || primary.method === "sms")) {
    await faClient().sendTwoFactorCodeForLoginUsingMethod(twoFactorId, {
      methodId: primary.id,
    });
  }

  return { twoFactorId, methods };
}

/** Completes the step-up challenge with the code the user entered. */
export async function completeTwoFactorLogin(opts: {
  twoFactorId: string;
  code: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    await faClient().twoFactorLogin({
      twoFactorId: opts.twoFactorId,
      code: opts.code,
    });
    return { success: true };
  } catch (err) {
    // The client rejects with a ClientResponse on non-2xx. 421 = bad code.
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 421) {
      return { success: false, error: "Incorrect code. Try again." };
    }
    return {
      success: false,
      error: `Verification failed (${statusCode ?? "unknown"}).`,
    };
  }
}

// ---------------------------------------------------------------------------
// 4. The MCP tool server's OWN identity (Client Credentials grant)
// ---------------------------------------------------------------------------

/**
 * The MCP tool server's decoded non-human identity — the point that "the agent's
 * tools have an identity too, distinct from the user it's acting for." Rendered
 * on /admin and in the authorization trace.
 */
export interface McpServiceIdentity {
  /** The tool-server Entity's Client Id (the token's `sub` for a CC grant). */
  clientId: string;
  /** The token `sub` claim (equals the client id for client_credentials). */
  subject?: string;
  /** Scopes granted to the tool server, if any. */
  scopes: string[];
  /** Seconds-since-epoch expiry, if present. */
  expiresAt?: number;
  /** The raw access token string (short-lived; used for outbound tool-server calls). */
  accessToken: string;
}

// Cache the CC token until shortly before it expires (dev-HMR-safe via a plain
// module variable is fine — it's server-only and cheap to re-mint).
let mcpTokenCache: { identity: McpServiceIdentity; refreshAt: number } | null =
  null;

/**
 * Mints (and caches) the MCP tool server's Client Credentials access token from
 * its FusionAuth Entity (Entity Management). Requires FUSIONAUTH_MCP_SCOPE
 * (`target-entity:<id>:<permission>`). Returns null on any failure (Entity
 * Management not licensed, scope/grant missing, instance unreachable, bad
 * secret) so callers degrade to an honest "not connected" state instead of
 * throwing — the same fallback philosophy the sibling apps use for optional
 * services.
 */
export async function getMcpServiceIdentity(): Promise<McpServiceIdentity | null> {
  const now = Math.floor(Date.now() / 1000);
  if (mcpTokenCache && mcpTokenCache.refreshAt > now) {
    return mcpTokenCache.identity;
  }

  let clientId: string;
  let clientSecret: string;
  let baseUrl: string;
  try {
    clientId = fusionAuthConfig.mcpClientId;
    clientSecret = fusionAuthConfig.mcpClientSecret;
    baseUrl = fusionAuthConfig.baseUrl;
  } catch {
    return null; // env not configured
  }

  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });
    // FusionAuth's client_credentials grant is Entity Management (a paid
    // feature): client_id/secret belong to an Entity, and the request must name
    // a target entity + permissions via `scope=target-entity:<id>:<perm>`. The
    // exact value is instance-specific, so it's supplied via env. Without it the
    // grant is rejected and we fall through to the honest "not connected" state.
    const scope = process.env.FUSIONAUTH_MCP_SCOPE?.trim();
    if (scope) body.set("scope", scope);
    const res = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: string;
      scope?: string;
      expires_in?: number;
    };
    if (!json.access_token) return null;

    // Decode (not verify) our own token purely to surface its claims in the UI.
    let subject: string | undefined;
    let scopes: string[] = json.scope ? json.scope.split(/\s+/).filter(Boolean) : [];
    let expiresAt: number | undefined = json.expires_in
      ? now + json.expires_in
      : undefined;
    try {
      const claims = decodeJwt(json.access_token);
      if (typeof claims.sub === "string") subject = claims.sub;
      if (typeof claims.scope === "string" && scopes.length === 0) {
        scopes = claims.scope.split(/\s+/).filter(Boolean);
      }
      if (typeof claims.exp === "number") expiresAt = claims.exp;
    } catch {
      // Opaque token — the form fields above already gave us what we can show.
    }

    const identity: McpServiceIdentity = {
      clientId,
      subject: subject ?? clientId,
      scopes,
      expiresAt,
      accessToken: json.access_token,
    };
    // Refresh a minute before expiry; default to 5 min if no expiry was given.
    const ttl = expiresAt ? Math.max(30, expiresAt - now - 60) : 300;
    mcpTokenCache = { identity, refreshAt: now + ttl };
    return identity;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Optional directory enrichment (the lookup_employee tool)
// ---------------------------------------------------------------------------

export interface DirectoryHit {
  id: string;
  name: string;
  email?: string;
  roles: string[];
}

/**
 * Searches FusionAuth's users for the directory tool. Uses the app's own API key
 * (a privileged endpoint — never the user's token). Returns null when the search
 * can't run (search backend not configured, key lacks scope, instance
 * unreachable) so the tool falls back to the mock directory with an honest note.
 */
export async function searchDirectoryUsers(
  query: string
): Promise<DirectoryHit[] | null> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await faClient().searchUsersByQuery({
      search: {
        queryString: `email:*${q}* OR fullName:*${q}* OR firstName:*${q}* OR lastName:*${q}*`,
        sortFields: [{ name: "email", order: Sort.asc }],
        numberOfResults: 10,
      },
    });
    const users = res.response.users ?? [];
    return users
      .map((u) => ({
        id: u.id ?? "",
        name:
          u.fullName ||
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.email ||
          "Unnamed user",
        email: u.email,
        roles: (
          (u.registrations ?? []).find(
            (r) => r.applicationId === fusionAuthConfig.clientId
          )?.roles ?? []
        ).filter((r): r is string => typeof r === "string" && r !== ""),
      }))
      .filter((u) => u.id !== "");
  } catch {
    return null;
  }
}

/** Lists the tenant's users for the /admin consent-status roster. Null when unavailable. */
export async function searchTenantUsers(): Promise<DirectoryHit[] | null> {
  try {
    const res = await faClient().searchUsersByQuery({
      search: {
        queryString: "*",
        sortFields: [{ name: "email", order: Sort.asc }],
      },
    });
    const users = res.response.users ?? [];
    return users
      .map((u) => ({
        id: u.id ?? "",
        name:
          u.fullName ||
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.email ||
          "Unnamed user",
        email: u.email,
        roles: (
          (u.registrations ?? []).find(
            (r) => r.applicationId === fusionAuthConfig.clientId
          )?.roles ?? []
        ).filter((r): r is string => typeof r === "string" && r !== ""),
      }))
      .filter((u) => u.id !== "");
  } catch {
    return null;
  }
}
