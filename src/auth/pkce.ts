import { createHash, randomBytes } from 'crypto';

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generateState(): string {
  return randomBytes(16).toString('base64url');
}

export function generateNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Per-browser id for the `oidc_binding` cookie (see PkceEntry.binding). */
export function generateBinding(): string {
  return randomBytes(32).toString('base64url');
}
