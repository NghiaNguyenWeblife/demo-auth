import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

export const SIGNUP_INTENT_TTL_MS = 10 * 60 * 1000;
export const SIGNUP_INTENT_COOKIE = 'yl_signup_intent';

/**
 * "Sign up (option 2)", existing WebLiFE ID: remembers which email the user
 * asked to sign up with, between the email step and the "Continue" POST.
 *
 * The id lives in a lax httpOnly cookie, so a cross-site page cannot POST
 * "Continue" on the user's behalf (that would register a user who is already
 * logged in to FA for YUILINK without them asking).
 */
@Injectable()
export class SignupIntentStore {
  private readonly store = new Map<
    string,
    { email: string; expiresAt: number }
  >();

  save(email: string): string {
    const id = randomBytes(24).toString('base64url');
    this.store.set(id, { email, expiresAt: Date.now() + SIGNUP_INTENT_TTL_MS });
    this.cleanup();
    return id;
  }

  consume(id: string | undefined): string | null {
    if (!id) return null;
    const entry = this.store.get(id);
    if (!entry) return null;
    this.store.delete(id);
    return entry.expiresAt < Date.now() ? null : entry.email;
  }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt < now) this.store.delete(k);
    }
  }
}
