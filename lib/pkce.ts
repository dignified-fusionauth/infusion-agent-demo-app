import { randomBytes, createHash } from "crypto";

/** Random URL-safe string for the PKCE code_verifier and OAuth state param. */
export function randomUrlSafeString(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** S256 code_challenge derived from a code_verifier, per RFC 7636. */
export function codeChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
