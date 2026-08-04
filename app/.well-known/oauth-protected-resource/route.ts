import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";
import { authorizationServerIssuer } from "@/lib/fusionauth";

/**
 * GET /.well-known/oauth-protected-resource  (RFC 9728)
 *
 * Advertises this MCP resource server's metadata, pointing at the FusionAuth
 * Application as the OAuth 2.1 Authorization Server. A compliant MCP client that
 * gets a 401 from /api/mcp reads this document to discover where to obtain a
 * token. The authorization server URL is FusionAuth's OIDC issuer (resolved from
 * discovery; falls back to FUSIONAUTH_URL so this route never throws).
 */
export async function GET(request: Request) {
  const issuer = await authorizationServerIssuer();
  return protectedResourceHandler({ authServerUrls: [issuer] })(request);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
