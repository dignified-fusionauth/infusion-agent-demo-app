import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { scopesFromClaims } from "@/lib/scopes";
import { rolesFromClaims } from "@/lib/roles";

/**
 * The MCP resource server's OWN, independent bearer-token verifier.
 *
 * This is the SECOND of the two authorization checks the demo makes visible. It
 * deliberately does NOT import verifyAccessToken / getSession from lib/session.ts
 * or lib/fusionauth.ts — it stands up its own OIDC discovery + JWKS + jwtVerify
 * here, so the check the MCP server performs is genuinely independent of the
 * agent sandbox's check, not the same code called twice. If the sandbox were ever
 * bypassed or wrong, THIS is the check that still has to pass before a tool runs.
 *
 * mcp-handler's `withMcpAuth` calls `verifyMcpToken(req, bearerToken)`; returning
 * undefined makes it answer 401 with a `WWW-Authenticate` header pointing at the
 * RFC 9728 metadata (see app/.well-known/oauth-protected-resource).
 */

function baseUrl(): string {
  const url = process.env.FUSIONAUTH_URL;
  if (!url) throw new Error("Missing FUSIONAUTH_URL.");
  return url.replace(/\/$/, "");
}

function tenantId(): string | undefined {
  return process.env.FUSIONAUTH_TENANT_ID || undefined;
}

/** Audience the MCP server accepts — the main InFusion Agent Application's client id. */
function expectedAudience(): string {
  const clientId = process.env.FUSIONAUTH_CLIENT_ID;
  if (!clientId) throw new Error("Missing FUSIONAUTH_CLIENT_ID.");
  return clientId;
}

function wellKnownUrl(): string {
  const segment = tenantId() ? `/${tenantId()}` : "";
  return `${baseUrl()}/.well-known/openid-configuration${segment}`;
}

interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
}

// Separate, module-local caches — intentionally NOT the ones in lib/fusionauth.ts.
let mcpDiscovery: Promise<OidcDiscovery> | null = null;
function getMcpDiscovery(): Promise<OidcDiscovery> {
  if (!mcpDiscovery) {
    mcpDiscovery = (async () => {
      const res = await fetch(wellKnownUrl());
      if (!res.ok) {
        mcpDiscovery = null;
        throw new Error(`OIDC discovery failed (${res.status}).`);
      }
      const doc = (await res.json()) as OidcDiscovery;
      return { issuer: doc.issuer, jwks_uri: doc.jwks_uri };
    })();
  }
  return mcpDiscovery;
}

let mcpJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function getMcpJwks() {
  if (!mcpJwks) {
    const { jwks_uri } = await getMcpDiscovery();
    mcpJwks = createRemoteJWKSet(new URL(jwks_uri));
  }
  return mcpJwks;
}

/**
 * Verifies a bearer access token against FusionAuth's JWKS, checking signature,
 * issuer, and audience. Returns the MCP `AuthInfo` (token + client + scopes) on
 * success, or undefined for any missing/expired/wrong-audience/under-verified
 * token so withMcpAuth answers 401.
 */
export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  try {
    const [keys, { issuer }] = await Promise.all([
      getMcpJwks(),
      getMcpDiscovery(),
    ]);
    const { payload } = await jwtVerify(bearerToken, keys, {
      issuer,
      audience: expectedAudience(),
    });

    const claims = payload as Record<string, unknown>;
    const scopes = scopesFromClaims(claims);
    const clientId =
      (typeof claims.aud === "string" && claims.aud) || expectedAudience();

    return {
      token: bearerToken,
      clientId,
      scopes,
      expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
      extra: {
        sub: typeof claims.sub === "string" ? claims.sub : undefined,
        email: typeof claims.email === "string" ? claims.email : undefined,
        name: typeof claims.name === "string" ? claims.name : undefined,
        // Roles from the verified token, so the MCP server can enforce the
        // per-tool role gate independently of the agent sandbox.
        roles: rolesFromClaims(claims),
      },
    };
  } catch {
    return undefined;
  }
}
