import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

// Shared denylist for Single Logout (SLO). See ID-AUTH/05.logout.md.
//
// Key namespace is shared with the control panel app on the SAME Valkey
// instance — logout written by one app is read by the other.
const KEY_PREFIX = 'logout:revoked:sub:';

// 7 days ≈ max refresh-token lifetime. Key self-expires so Valkey doesn't grow
// unbounded; a token older than this can't exist, so it never needs the entry.
const REVOCATION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Records "user `sub` logged out at T" and answers "was a token minted before
 * the last logout?". Logic intentionally mirrors the control panel copy.
 *
 * Fail-open (decision #6): any Valkey error must NOT lock users out — reads
 * return `false` (allow) and writes are best-effort. A Valkey outage only
 * degrades SLO, it never breaks login.
 */
@Injectable()
export class LogoutRevocationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogoutRevocationService.name);
  // Valkey mode khi có VALKEY_HOST; ngược lại `null` và dùng `memory`.
  private readonly redis: Redis | null;
  // In-memory fallback khi VALKEY_HOST rỗng/undefined. Single-node, mất khi
  // restart — chỉ share SLO trong 1 tiến trình. Value = revokedAt + expiresAt (ms).
  private readonly memory: Map<
    string,
    { revokedAt: number; expiresAt: number }
  > | null;

  constructor() {
    const host = process.env.VALKEY_HOST?.trim();
    if (!host) {
      this.redis = null;
      this.memory = new Map();
      this.logger.warn(
        'VALKEY_HOST rỗng — LogoutRevocation chạy in-memory (single-node, SLO không share giữa các node).',
      );
      return;
    }
    this.memory = null;
    this.redis = new Redis({
      host,
      port: Number(process.env.VALKEY_PORT) || 6379,
      username: process.env.VALKEY_USR || undefined,
      password: process.env.VALKEY_PWD || undefined,
      // Connect explicitly in onModuleInit so a Valkey outage can't block boot.
      lazyConnect: true,
      // Reject commands immediately while disconnected instead of queueing them
      // forever — this is what makes fail-open fast rather than hanging.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      retryStrategy: times => Math.min(times * 200, 2000),
    });
    // Without this handler an emitted 'error' would crash the process.
    this.redis.on('error', err =>
      this.logger.error(`Valkey error: ${err.message}`),
    );
  }

  async onModuleInit() {
    if (!this.redis) return; // in-memory mode
    try {
      await this.redis.connect();
      this.logger.log(`Connected to Valkey at ${process.env.VALKEY_HOST}`);
    } catch (err) {
      // Fail-open: boot anyway. ioredis keeps reconnecting in the background.
      this.logger.error(
        `Valkey connect failed (continuing, SLO degraded): ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    if (!this.redis) return; // in-memory mode
    try {
      await this.redis.quit();
    } catch {
      /* shutting down — ignore */
    }
  }

  private key(sub: string): string {
    return `${KEY_PREFIX}${sub}`;
  }

  /** Mark every token of `sub` issued before now as revoked. */
  async revoke(sub: string): Promise<void> {
    if (this.memory) {
      const now = Date.now();
      this.memory.set(this.key(sub), {
        revokedAt: now,
        expiresAt: now + REVOCATION_TTL_SECONDS * 1000,
      });
      return;
    }
    try {
      await this.redis!.set(
        this.key(sub),
        Date.now().toString(),
        'EX',
        REVOCATION_TTL_SECONDS,
      );
    } catch (err) {
      // Best-effort: local cookie clear + FA SSO logout must still proceed.
      this.logger.error(`revoke(${sub}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * True when `sub` has a revocation marker newer than the token's issued-at.
   * A token minted AFTER the last logout (re-login, iat > revokedAt) passes.
   */
  async isRevoked(sub: string, tokenIatMs: number): Promise<boolean> {
    if (this.memory) {
      const entry = this.memory.get(this.key(sub));
      if (!entry) return false;
      if (entry.expiresAt <= Date.now()) {
        this.memory.delete(this.key(sub)); // lazy-expiry, mô phỏng TTL của Valkey
        return false;
      }
      return tokenIatMs < entry.revokedAt;
    }
    try {
      const value = await this.redis!.get(this.key(sub));
      if (!value) return false;
      const revokedAt = Number(value);
      return Number.isFinite(revokedAt) && tokenIatMs < revokedAt;
    } catch (err) {
      this.logger.error(
        `isRevoked(${sub}) failed, failing open: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
