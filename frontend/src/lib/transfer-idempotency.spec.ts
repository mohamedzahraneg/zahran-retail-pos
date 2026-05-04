/**
 * transfer-idempotency.spec.ts — PR-AUDIT-IDEMPOTENCY-CASH-DESK-TRANSFER-FE
 *
 * Pins the FE half of the opt-in idempotency contract for
 * `POST /cash-desk/transfer`. Mirror of `checkout-idempotency.spec.ts`
 * but scoped to the transfer route + modal-mount intent boundary.
 *
 *   1. One Idempotency-Key per transfer intent (= one TransferModal
 *      session). The reset hook is wired in TransferModal's
 *      mount/unmount useEffect.
 *   2. Same key reused on retry within one open modal session.
 *   3. Reset only when `resetTransferIdempotencyKey()` is called
 *      (which fires on modal mount + unmount).
 *   4. Source/dest/amount/notes changes within the modal do NOT
 *      reset the key.
 *   5. Header is attached only to POST /cash-desk/transfer — not
 *      to any GET, not to other POST routes (POS, deposit,
 *      customer-payments, supplier-payments, voids, /sync/push).
 *   6. A caller-provided Idempotency-Key (any casing) is preserved.
 *   7. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *
 * The two helpers (checkout + transfer) MUST not cross-fire — a
 * `POST /pos/invoices` must never receive the transfer key, and
 * vice versa.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateTransferIdempotencyKey,
  resetTransferIdempotencyKey,
  attachTransferIdempotencyKeyIfApplicable,
  _resetTransferIdempotencyKeyForTests,
} from './transfer-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

beforeEach(() => {
  _resetTransferIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
});

describe('transfer idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same key on repeated calls within one intent', () => {
    const a = getOrCreateTransferIdempotencyKey();
    const b = getOrCreateTransferIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW key', () => {
    const a = getOrCreateTransferIdempotencyKey();
    resetTransferIdempotencyKey();
    const b = getOrCreateTransferIdempotencyKey();
    expect(b).not.toBe(a);
    expect(a).toMatch(BE_PATTERN);
    expect(b).toMatch(BE_PATTERN);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetTransferIdempotencyKeyForTests();
      const k = getOrCreateTransferIdempotencyKey();
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

describe('attachTransferIdempotencyKeyIfApplicable — request shape gate', () => {
  it('attaches the header on POST /cash-desk/transfer', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/transfer',
      headers: {},
    };
    attachTransferIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('sends the SAME key on a second POST /cash-desk/transfer for the same intent', () => {
    const cfg1: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    const cfg2: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachTransferIdempotencyKeyIfApplicable(cfg1);
    attachTransferIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBeDefined();
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after resetTransferIdempotencyKey(), the next POST /cash-desk/transfer uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachTransferIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];

    // Simulates TransferModal unmount → next mount cycle.
    resetTransferIdempotencyKey();

    const cfg2: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachTransferIdempotencyKeyIfApplicable(cfg2);
    const k2 = cfg2.headers['Idempotency-Key'];

    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k2).not.toBe(k1);
  });

  it('does NOT attach the header on POST /pos/invoices (the checkout route)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachTransferIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on GET /cash-desk/transfer (or any GET)', () => {
    const cfg: any = {
      method: 'get',
      url: '/cash-desk/transfer',
      headers: {},
    };
    attachTransferIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    const cfg2: any = { method: 'get', url: '/cash-desk/cashboxes', headers: {} };
    attachTransferIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on POSTs to sibling cash-desk endpoints', () => {
    for (const url of [
      '/cash-desk/cashboxes',
      '/cash-desk/cashboxes/abc-id',
      '/cash-desk/cashboxes/abc-id/delete',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/customer-payments/abc-id/void',
      '/cash-desk/supplier-payments',
      '/cash-desk/supplier-payments/abc-id/void',
      '/cash-desk/reconciliation/mark',
      '/cash-desk/reconciliation/unmark',
      '/cash-desk/reconciliation/auto-match',
      '/sync/push', // explicit: offline sync is out of scope
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachTransferIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key (does not overwrite)', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/transfer',
      headers: { 'Idempotency-Key': 'caller-supplied-transfer-1234' },
    };
    attachTransferIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      'caller-supplied-transfer-1234',
    );
  });

  it('preserves a caller-provided lowercase idempotency-key header too', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/transfer',
      headers: { 'idempotency-key': 'caller-supplied-lower-trans-1234' },
    };
    attachTransferIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['idempotency-key']).toBe(
      'caller-supplied-lower-trans-1234',
    );
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: '/cash-desk/transfer', headers: {} };
    attachTransferIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

/**
 * Cross-route isolation: the two helpers must not leak keys
 * between routes. A request to /pos/invoices must use the
 * checkout key (not transfer), and vice versa, even when both
 * are called in the same axios interceptor pass.
 */
describe('cross-route isolation — checkout helper vs transfer helper', () => {
  it('checkout helper does NOT attach to /cash-desk/transfer', () => {
    const cfg: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('transfer helper does NOT attach to /pos/invoices', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachTransferIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('running both helpers in sequence (interceptor order) on /pos/invoices uses the checkout key only', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    const checkoutKey = cfg.headers['Idempotency-Key'];
    // The transfer module's key must be DIFFERENT from the one set
    // (proves the second helper didn't overwrite — its URL gate
    // refused to fire).
    const standaloneTransferKey = getOrCreateTransferIdempotencyKey();
    expect(checkoutKey).toBeDefined();
    expect(checkoutKey).not.toBe(standaloneTransferKey);
  });

  it('running both helpers in sequence on /cash-desk/transfer uses the transfer key only', () => {
    const cfg: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    const transferKey = cfg.headers['Idempotency-Key'];
    expect(transferKey).toBeDefined();
    // The transfer module's getter should now return the same key
    // we observed on the request (proves the request got the
    // transfer module's value, not the checkout one).
    expect(transferKey).toBe(getOrCreateTransferIdempotencyKey());
  });
});
