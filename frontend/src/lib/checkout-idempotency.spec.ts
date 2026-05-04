/**
 * checkout-idempotency.spec.ts — PR-AUDIT-IDEMPOTENCY-POS-INVOICE-FE
 *
 * Pins the FE half of the opt-in idempotency contract for
 * `POST /pos/invoices`:
 *
 *   1. One Idempotency-Key per checkout intent (the cart).
 *   2. Same key reused on retry of the same cart (network blip,
 *      manual cashier retry).
 *   3. Reset only when `cart.clear()` is called.
 *   4. Customer/warehouse changes do NOT reset the key.
 *   5. Header is attached only to POST /pos/invoices — not GETs,
 *      not other POST routes, not the offline /sync/push endpoint.
 *   6. A caller-provided Idempotency-Key is preserved (never
 *      overwritten by this module).
 *   7. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getOrCreateCheckoutIdempotencyKey,
  resetCheckoutIdempotencyKey,
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';
import { useCartStore } from '@/stores/cart.store';

// BE-side regex (idempotency.interceptor.ts). Any FE-generated key
// must satisfy this or a 400 IDEMPOTENCY_KEY_INVALID is returned.
const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

beforeEach(() => {
  _resetCheckoutIdempotencyKeyForTests();
});

describe('checkout idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same key on repeated calls within one intent', () => {
    const a = getOrCreateCheckoutIdempotencyKey();
    const b = getOrCreateCheckoutIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW key', () => {
    const a = getOrCreateCheckoutIdempotencyKey();
    resetCheckoutIdempotencyKey();
    const b = getOrCreateCheckoutIdempotencyKey();
    expect(b).not.toBe(a);
    expect(a).toMatch(BE_PATTERN);
    expect(b).toMatch(BE_PATTERN);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    // Simulate an old browser / SSR-ish env where randomUUID is missing.
    // We restore in finally so the rest of the suite is unaffected.
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetCheckoutIdempotencyKeyForTests();
      const k = getOrCreateCheckoutIdempotencyKey();
      expect(k).toMatch(BE_PATTERN);
      expect(k.length).toBeGreaterThanOrEqual(8);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

describe('attachCheckoutIdempotencyKeyIfApplicable — request shape gate', () => {
  it('attaches the header on POST /pos/invoices', () => {
    const cfg: any = {
      method: 'post',
      url: '/pos/invoices',
      headers: {},
    };
    const out = attachCheckoutIdempotencyKeyIfApplicable(cfg);
    expect(out.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('sends the SAME key on a second POST /pos/invoices for the same intent', () => {
    const cfg1: any = { method: 'post', url: '/pos/invoices', headers: {} };
    const cfg2: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg1);
    attachCheckoutIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBeDefined();
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after cart.clear(), the next POST /pos/invoices uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];

    useCartStore.getState().clear();

    const cfg2: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg2);
    const k2 = cfg2.headers['Idempotency-Key'];

    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k2).not.toBe(k1);
  });

  it('changing the customer does NOT reset the key', () => {
    const cfg1: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];

    useCartStore.getState().setCustomer({ id: 'cust-1' } as any);
    useCartStore.getState().setCustomer(null);

    const cfg2: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).toBe(k1);
  });

  it('changing the warehouse does NOT reset the key', () => {
    const cfg1: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];

    useCartStore.getState().setWarehouse({ id: 'wh-1', code: 'C', name_ar: 'M' } as any);
    useCartStore.getState().setWarehouse({ id: 'wh-2', code: 'B', name_ar: 'B' } as any);

    const cfg2: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).toBe(k1);
  });

  it('does NOT attach the header on GET /pos/invoices (or any GET)', () => {
    const cfg: any = { method: 'get', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    const cfg2: any = { method: 'get', url: '/customers', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on POST to other endpoints', () => {
    for (const url of [
      '/pos/invoices/xyz/void',
      '/pos/invoices/xyz/edit',
      '/payments/charge',
      '/returns',
      '/sync/push', // explicit: offline-sync path is out of scope
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachCheckoutIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key (does not overwrite)', () => {
    const cfg: any = {
      method: 'post',
      url: '/pos/invoices',
      headers: { 'Idempotency-Key': 'caller-supplied-key-1234' },
    };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe('caller-supplied-key-1234');
  });

  it('preserves a caller-provided lowercase idempotency-key header too', () => {
    const cfg: any = {
      method: 'post',
      url: '/pos/invoices',
      headers: { 'idempotency-key': 'caller-supplied-lower-1234' },
    };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    // Either casing is acceptable — what matters is we didn't double-set
    // a different key under the canonical name.
    expect(cfg.headers['idempotency-key']).toBe('caller-supplied-lower-1234');
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});
