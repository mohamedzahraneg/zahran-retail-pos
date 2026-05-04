/**
 * idempotency.interceptor.ts — PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE
 *
 * Optional Idempotency-Key support for financial-mutation endpoints.
 *
 *   · No header  → behavior is exactly unchanged from today.
 *   · With header on first call  → process, cache 2xx response for 24h.
 *   · With same header + same payload  → return cached response,
 *                                         skip the handler entirely.
 *   · With same header + different payload  → 409 conflict.
 *   · Concurrent same-key requests  → first one acquires the lock,
 *                                      others receive 425 Too Early.
 *   · Redis unavailable  → keyed request fail-closes with 503 (the
 *                          unprotected behavior would be unsafe).
 *
 * Pilot scope: applied only to `POST /pos/invoices` in this PR. Other
 * P0 endpoints follow in separate phased PRs.
 */

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import * as crypto from 'node:crypto';
import {
  IdempotencyCacheService,
  CachedResponse,
} from '../cache/idempotency-cache.service';

/**
 * Format check for the Idempotency-Key header. Accepts UUID-ish or
 * alphanumeric+dash+underscore, 8-128 chars. Rejects anything else
 * loudly so a misuse can't slip through (HTTP 400).
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('IdempotencyInterceptor');

  constructor(private readonly cache: IdempotencyCacheService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest();
    const res = httpCtx.getResponse();

    // 1. Idempotency-Key header is OPTIONAL. No header → behave
    //    exactly as today (no protection — opt-in pattern).
    const rawHeader =
      req.headers?.['idempotency-key'] ??
      req.headers?.['Idempotency-Key'];
    const idempotencyKey =
      Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      // No header — pass through. Make sure the response header is
      // explicit so callers can detect non-idempotent endpoints.
      res?.setHeader?.('X-Idempotent-Replay', 'false');
      return next.handle();
    }

    // 2. Validate the key format. Reject loudly on misuse.
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new HttpException(
        {
          message:
            'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-]',
          code: 'IDEMPOTENCY_KEY_INVALID',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // 3. Compute a stable hash of the request body so we can detect
    //    key reuse with a different payload.
    const payloadHash = this.hashPayload(req.body ?? {});
    const method = String(req.method ?? 'POST');
    const path = String(req.route?.path ?? req.originalUrl ?? req.url ?? '');

    // 4. Probe the cache + try to acquire the processing lock.
    const acquireResult = await this.cache.tryAcquireOrReplay(
      method,
      path,
      idempotencyKey,
      payloadHash,
    );

    switch (acquireResult.kind) {
      case 'replay':
        return this.replayCachedResponse(res, acquireResult.cached);

      case 'payload_mismatch':
        throw new HttpException(
          {
            message:
              'Idempotency-Key already used with a different request payload',
            code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
            cached_status: acquireResult.cached.status,
          },
          HttpStatus.CONFLICT,
        );

      case 'in_progress':
        throw new HttpException(
          {
            message:
              'A request with this Idempotency-Key is already being processed; retry shortly',
            code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
          },
          // 425 Too Early — RFC 8470. Client should retry with the
          // same key after a short backoff.
          425,
        );

      case 'unavailable':
        // Fail-closed. A keyed request that can't reach Redis MUST
        // NOT be processed — that would defeat the protection.
        this.logger.warn(
          `Redis unavailable for keyed ${method} ${path} — fail-closed 503`,
        );
        throw new HttpException(
          {
            message:
              'Idempotency cache is temporarily unavailable; retry shortly',
            code: 'IDEMPOTENCY_CACHE_UNAVAILABLE',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );

      case 'acquired':
        // Fall through — this caller is the processor.
        break;
    }

    // 5. We hold the lock. Run the handler, then cache the response.
    const cacheKey = acquireResult.cacheKey;
    res?.setHeader?.('X-Idempotent-Replay', 'false');

    return next.handle().pipe(
      tap(async (data) => {
        const status = res?.statusCode ?? 200;
        // Cache only successful 2xx — explicit per audit safety guidance.
        if (status >= 200 && status < 300) {
          await this.cache.cacheResult(cacheKey, payloadHash, status, data);
        } else {
          // Non-2xx → release lock so a retry isn't blocked by the
          // 60s lock TTL. We deliberately do NOT cache 4xx/5xx.
          await this.cache.releaseLock(cacheKey);
        }
      }),
      catchError(async (err) => {
        // Handler threw — release lock so a retry can proceed. Re-
        // throw so the caller still sees the error.
        await this.cache.releaseLock(cacheKey);
        throw err;
      }),
    );
  }

  /** SHA-256 of canonicalized JSON. Stable across key order. */
  private hashPayload(body: unknown): string {
    const canonical = this.canonicalize(body);
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /** Stable JSON.stringify with sorted object keys. */
  private canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return '[' + value.map((v) => this.canonicalize(v)).join(',') + ']';
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (k) => JSON.stringify(k) + ':' + this.canonicalize((value as Record<string, unknown>)[k]),
    );
    return '{' + entries.join(',') + '}';
  }

  /**
   * Replay a cached 2xx response. We set the header marker, set the
   * HTTP status to match, and emit the cached body — skipping the
   * downstream handler entirely.
   */
  private replayCachedResponse(
    res: any,
    cached: CachedResponse,
  ): Observable<unknown> {
    res?.setHeader?.('X-Idempotent-Replay', 'true');
    if (typeof res?.status === 'function') {
      res.status(cached.status);
    } else if (res) {
      res.statusCode = cached.status;
    }
    return of(cached.body);
  }
}
