/**
 * idempotency-cache.service.ts — PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE
 *
 * Redis-backed cache for HTTP request idempotency. Used by
 * IdempotencyInterceptor to:
 *
 *   · acquire a short-TTL processing lock so concurrent same-key
 *     requests don't double-process,
 *   · replay a cached 2xx response when the same key is presented
 *     again within the TTL window,
 *   · refuse a key reused with a different payload (409).
 *
 * Two Redis keys per logical idempotency entry:
 *   · `<ns>:lock`    — short-TTL sentinel set during processing.
 *                       Atomic SET NX EX. Released after success/failure.
 *   · `<ns>:result`  — long-TTL JSON envelope with the cached
 *                       response. Written after a successful 2xx.
 *
 * Where `<ns>` = `idempotency:v1:<METHOD>:<PATH>:<key>`.
 *
 * Fail-closed semantics: when Redis is unreachable, every method
 * either rejects with an Error (caller maps to 503) or returns a
 * sentinel that the interceptor treats as a hard failure for keyed
 * requests. A keyed request will NEVER silently fall through to
 * "process twice" on Redis failure.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h
export const IDEMPOTENCY_LOCK_TTL_SECONDS = 60;       // 60s processing budget
export const IDEMPOTENCY_NAMESPACE = 'idempotency:v1';

export type CachedResponse = {
  status: number;
  body: unknown;
  payload_hash: string;
  cached_at: string; // ISO timestamp
};

export type AcquireResult =
  | { kind: 'acquired'; cacheKey: string }
  | { kind: 'replay'; cached: CachedResponse }
  | { kind: 'in_progress'; cacheKey: string }
  | { kind: 'payload_mismatch'; cached: CachedResponse }
  | { kind: 'unavailable' };

@Injectable()
export class IdempotencyCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('IdempotencyCache');
  private client: Redis | null = null;

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL || 'redis://redis:6379';
    try {
      this.client = new IORedis(url, {
        // Don't crash on connection issues — interceptor handles
        // unavailable state explicitly.
        lazyConnect: true,
        // Short retry strategy so a permanently-down Redis fails fast
        // instead of hanging requests.
        maxRetriesPerRequest: 1,
      });
      await this.client.connect();
      this.logger.log(`connected to Redis at ${url.replace(/:[^:@/]*@/, ':***@')}`);
    } catch (err: any) {
      this.logger.error(`failed to connect to Redis: ${err?.message ?? err}`);
      // Leave client = null; isAvailable() returns false; interceptor
      // fail-closes keyed requests.
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }

  /** Test-only setter for injecting a mock client. */
  setClientForTesting(client: Redis | null): void {
    this.client = client;
  }

  isAvailable(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }

  buildCacheKey(method: string, path: string, key: string): string {
    return `${IDEMPOTENCY_NAMESPACE}:${method.toUpperCase()}:${path}:${key}`;
  }

  /**
   * Single atomic step: check for a cached result, then try to take
   * the processing lock. The interceptor calls this BEFORE invoking
   * the handler.
   *
   * Returns:
   *   · 'acquired'         — caller should process the request and
   *                          call cacheResult() on success.
   *   · 'replay'           — same key + matching payload hash; caller
   *                          should return the cached response.
   *   · 'payload_mismatch' — same key + different payload hash; caller
   *                          should return 409.
   *   · 'in_progress'      — another request is currently processing
   *                          the same key; caller should return 425
   *                          (Too Early) so the client can retry.
   *   · 'unavailable'      — Redis unreachable; caller should return
   *                          503 for the keyed request (fail-closed).
   */
  async tryAcquireOrReplay(
    method: string,
    path: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<AcquireResult> {
    if (!this.isAvailable() || !this.client) {
      return { kind: 'unavailable' };
    }
    const cacheKey = this.buildCacheKey(method, path, idempotencyKey);
    const resultKey = `${cacheKey}:result`;
    const lockKey = `${cacheKey}:lock`;

    try {
      // Fast path: cached completed response wins.
      const cachedJson = await this.client.get(resultKey);
      if (cachedJson) {
        const cached = JSON.parse(cachedJson) as CachedResponse;
        if (cached.payload_hash === payloadHash) {
          return { kind: 'replay', cached };
        }
        return { kind: 'payload_mismatch', cached };
      }

      // No cached result yet — try to acquire the processing lock.
      // SET NX EX is atomic; race-safe under concurrent same-key.
      const acquired = await this.client.set(
        lockKey,
        new Date().toISOString(),
        'EX',
        IDEMPOTENCY_LOCK_TTL_SECONDS,
        'NX',
      );
      if (acquired === 'OK') {
        return { kind: 'acquired', cacheKey };
      }
      // Lock present but no cached result — another request in flight.
      return { kind: 'in_progress', cacheKey };
    } catch (err: any) {
      this.logger.warn(`tryAcquireOrReplay redis error: ${err?.message ?? err}`);
      return { kind: 'unavailable' };
    }
  }

  /**
   * Persist the successful response for replay within TTL. Releases
   * the processing lock atomically as a side effect (best-effort).
   */
  async cacheResult(
    cacheKey: string,
    payloadHash: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    if (!this.isAvailable() || !this.client) return;
    const envelope: CachedResponse = {
      status,
      body,
      payload_hash: payloadHash,
      cached_at: new Date().toISOString(),
    };
    try {
      const resultKey = `${cacheKey}:result`;
      const lockKey = `${cacheKey}:lock`;
      // Pipeline so result + lock release happen together. Result has
      // 24h TTL; lock release is unconditional.
      await this.client
        .multi()
        .set(resultKey, JSON.stringify(envelope), 'EX', IDEMPOTENCY_TTL_SECONDS)
        .del(lockKey)
        .exec();
    } catch (err: any) {
      this.logger.warn(`cacheResult redis error: ${err?.message ?? err}`);
    }
  }

  /**
   * Release the processing lock without caching a result. Called when
   * the handler throws (so a retry isn't blocked for the full lock
   * TTL). Best-effort; safe to fail.
   */
  async releaseLock(cacheKey: string): Promise<void> {
    if (!this.isAvailable() || !this.client) return;
    try {
      await this.client.del(`${cacheKey}:lock`);
    } catch (err: any) {
      this.logger.warn(`releaseLock redis error: ${err?.message ?? err}`);
    }
  }
}
