import { Injectable } from '@nestjs/common';

export interface PkceEntry {
  codeVerifier: string;
  redirect: string;
  /** Sent to FA as `nonce`; the id_token from the callback must echo it. */
  nonce: string;
  /**
   * Value of the browser's `oidc_binding` cookie when the login started. The
   * callback must come from the same browser, otherwise a victim could be sent
   * a callback URL carrying an attacker's code (login CSRF).
   */
  binding: string;
  /**
   * Set when the login was started from "Sign up (option 2)" for an existing
   * WebLiFE ID: register the user for YUILINK right after the callback,
   * provided they logged in as this email.
   */
  signupEmail?: string;
}

interface Entry extends PkceEntry {
  expiresAt: number;
}

export const PKCE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class PkceStore {
  private readonly store = new Map<string, Entry>();

  save(state: string, entry: PkceEntry, ttlMs = PKCE_TTL_MS) {
    this.store.set(state, { ...entry, expiresAt: Date.now() + ttlMs });
    this.cleanup();
  }

  consume(state: string): PkceEntry | null {
    const entry = this.store.get(state);
    if (!entry) return null;
    this.store.delete(state);
    if (entry.expiresAt < Date.now()) return null;
    return {
      codeVerifier: entry.codeVerifier,
      redirect: entry.redirect,
      nonce: entry.nonce,
      binding: entry.binding,
      signupEmail: entry.signupEmail,
    };
  }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt < now) this.store.delete(k);
    }
  }
}
