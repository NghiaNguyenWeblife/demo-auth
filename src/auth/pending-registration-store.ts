import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { FusionAuthTokenResponse } from './fusionauth.service';

export interface PendingRegistration {
  userId: string;
  email?: string;
  tokens: FusionAuthTokenResponse;
  redirect: string;
}

interface Entry extends PendingRegistration {
  expiresAt: number;
}

export const PENDING_TTL_MS = 10 * 60 * 1000;
export const PENDING_COOKIE = 'yl_pending_registration';

/**
 * Users who authenticated with FusionAuth but have no YUILINK registration.
 * They get no session yet: their tokens wait here until they press "Register"
 * (or the entry expires). Same in-memory shape as PkceStore.
 */
@Injectable()
export class PendingRegistrationStore {
  private readonly store = new Map<string, Entry>();

  save(entry: PendingRegistration): string {
    const id = randomBytes(24).toString('base64url');
    this.store.set(id, { ...entry, expiresAt: Date.now() + PENDING_TTL_MS });
    this.cleanup();
    return id;
  }

  get(id: string | undefined): PendingRegistration | null {
    if (!id) return null;
    const entry = this.store.get(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(id);
      return null;
    }
    return entry;
  }

  consume(id: string | undefined): PendingRegistration | null {
    const entry = this.get(id);
    if (entry) this.store.delete(id!);
    return entry;
  }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt < now) this.store.delete(k);
    }
  }
}
