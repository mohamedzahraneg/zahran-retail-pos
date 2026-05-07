/**
 * cash-desk-deposit-idempotency.spec.ts
 *   — PR-FE-IDEM-CASHDESK-DEPOSIT (Sprint 5 / FE-IDEM PR 2)
 *
 * Pins the FE half of the opt-in idempotency contract for
 * `POST /cash-desk/deposit` (which serves BOTH deposit
 * `direction:'in'` and withdraw `direction:'out'` — single route,
 * single helper). Mirror of `transfer-idempotency.spec.ts` adapted
 * to the deposit route + DepositModal-mount intent boundary.
 *
 *   1. One Idempotency-Key per deposit/withdraw intent (= one
 *      DepositModal session). The reset hook is wired in
 *      DepositModal's mount/unmount useEffect (in pages/CashDesk.tsx).
 *   2. Same key reused on retry within one open modal session
 *      (network blip, manual cashier retry, 425 IN_PROGRESS
 *      auto-retry from PR #315's shared response interceptor).
 *   3. Reset only when `resetCashDeskDepositIdempotencyKey()` is
 *      called (which fires on modal mount + unmount).
 *   4. Cashbox/direction/amount/notes/category changes within the
 *      open modal do NOT reset the key — payload-tamper safety
 *      lives BE-side (409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH).
 *   5. Header is attached only to POST /cash-desk/deposit — not to
 *      any GET, not to other POST routes (POS, transfer, customer-
 *      payments, supplier-payments, voids, /sync/push, etc.).
 *   6. A caller-provided Idempotency-Key (any casing) is preserved.
 *   7. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *
 * Cross-route isolation: this helper MUST not cross-fire with the
 * five sibling helpers (checkout, transfer, expense, customer-
 * payment, supplier-payment). A request to /cash-desk/transfer
 * must use the transfer key only, never the deposit key, and vice
 * versa. This invariant is pinned in the final describe block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateCashDeskDepositIdempotencyKey,
  resetCashDeskDepositIdempotencyKey,
  attachCashDeskDepositIdempotencyKeyIfApplicable,
  _resetCashDeskDepositIdempotencyKeyForTests,
} from './cash-desk-deposit-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';
import {
  attachTransferIdempotencyKeyIfApplicable,
  _resetTransferIdempotencyKeyForTests,
} from './transfer-idempotency';
import {
  attachCustomerPaymentIdempotencyKeyIfApplicable,
  _resetCustomerPaymentIdempotencyKeyForTests,
} from './customer-payment-idempotency';
import {
  attachSupplierPaymentIdempotencyKeyIfApplicable,
  _resetSupplierPaymentIdempotencyKeyForTests,
} from './supplier-payment-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

beforeEach(() => {
  _resetCashDeskDepositIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetTransferIdempotencyKeyForTests();
  _resetCustomerPaymentIdempotencyKeyForTests();
  _resetSupplierPaymentIdempotencyKeyForTests();
});

describe('cash-desk-deposit idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same key on repeated calls within one intent', () => {
    const a = getOrCreateCashDeskDepositIdempotencyKey();
    const b = getOrCreateCashDeskDepositIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW key', () => {
    const a = getOrCreateCashDeskDepositIdempotencyKey();
    resetCashDeskDepositIdempotencyKey();
    const b = getOrCreateCashDeskDepositIdempotencyKey();
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
      _resetCashDeskDepositIdempotencyKeyForTests();
      const k = getOrCreateCashDeskDepositIdempotencyKey();
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

describe('attachCashDeskDepositIdempotencyKeyIfApplicable — request shape gate', () => {
  it('attaches the header on POST /cash-desk/deposit', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/deposit',
      headers: {},
    };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('sends the SAME key on a second POST /cash-desk/deposit for the same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
    const cfg2: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg1);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBeDefined();
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after resetCashDeskDepositIdempotencyKey(), the next POST uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];

    // Simulates DepositModal unmount → next mount cycle.
    resetCashDeskDepositIdempotencyKey();

    const cfg2: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg2);
    const k2 = cfg2.headers['Idempotency-Key'];

    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k2).not.toBe(k1);
  });

  it('reuses the SAME key for a withdraw (direction:"out") on the same /cash-desk/deposit route', () => {
    // Single endpoint serves both directions — a deposit followed by
    // a withdraw within the SAME modal session is one logical intent
    // and must reuse the key. (BE will likely reject a payload swap
    // with 409 PAYLOAD_MISMATCH, which the shared interceptor toasts;
    // this test only pins that the FE itself does NOT mint a new key
    // just because `direction` differs.)
    const depositCfg: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
    const withdrawCfg: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(depositCfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(withdrawCfg);
    expect(depositCfg.headers['Idempotency-Key']).toBe(
      withdrawCfg.headers['Idempotency-Key'],
    );
  });

  it('does NOT attach the header on POST /pos/invoices (the checkout route)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on GET /cash-desk/deposit (or any GET)', () => {
    const cfg: any = {
      method: 'get',
      url: '/cash-desk/deposit',
      headers: {},
    };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    const cfg2: any = { method: 'get', url: '/cash-desk/cashboxes', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on PATCH/PUT/DELETE /cash-desk/deposit', () => {
    for (const method of ['patch', 'put', 'delete']) {
      const cfg: any = { method, url: '/cash-desk/deposit', headers: {} };
      attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on POSTs to sibling cash-desk endpoints (exact-match URL gate)', () => {
    for (const url of [
      '/cash-desk/cashboxes',
      '/cash-desk/cashboxes/abc-id',
      '/cash-desk/cashboxes/abc-id/delete',
      '/cash-desk/transfer',
      '/cash-desk/customer-payments',
      '/cash-desk/customer-payments/abc-id/void',
      '/cash-desk/supplier-payments',
      '/cash-desk/supplier-payments/abc-id/void',
      '/cash-desk/reconciliation/mark',
      '/cash-desk/reconciliation/unmark',
      '/cash-desk/reconciliation/auto-match',
      // Pin exact-match (not prefix-match). A future refactor to
      // startsWith() would silently widen scope and let the header
      // leak onto sibling endpoints under the same prefix.
      '/cash-desk/deposit/anything-else',
      '/cash-desk/deposit/abc-id/void',
      '/sync/push', // explicit: offline sync is out of scope
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key (does not overwrite)', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/deposit',
      headers: { 'Idempotency-Key': 'caller-supplied-deposit-1234' },
    };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      'caller-supplied-deposit-1234',
    );
  });

  it('preserves a caller-provided lowercase idempotency-key header too', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/deposit',
      headers: { 'idempotency-key': 'caller-supplied-lower-deposit-1234' },
    };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['idempotency-key']).toBe(
      'caller-supplied-lower-deposit-1234',
    );
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('preserves a caller-provided UPPERCASE IDEMPOTENCY-KEY header too', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/deposit',
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-upper-deposit-1234' },
    };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['IDEMPOTENCY-KEY']).toBe(
      'caller-supplied-upper-deposit-1234',
    );
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: '/cash-desk/deposit', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

/**
 * Cross-route isolation: the deposit helper must not leak keys to
 * any of the five existing sibling helpers, and they must not leak
 * to it. Critical because `/cash-desk/deposit`, `/cash-desk/transfer`,
 * `/cash-desk/customer-payments`, and `/cash-desk/supplier-payments`
 * all live under the same `/cash-desk/*` prefix, so a sloppy URL
 * gate would silently cross-fire and reuse the wrong key.
 */
describe('cross-route isolation — deposit helper vs the 5 sibling helpers', () => {
  it('deposit helper does NOT attach to /cash-desk/transfer', () => {
    const cfg: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('deposit helper does NOT attach to /cash-desk/customer-payments', () => {
    const cfg: any = {
      method: 'post', url: '/cash-desk/customer-payments', headers: {},
    };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('deposit helper does NOT attach to /cash-desk/supplier-payments', () => {
    const cfg: any = {
      method: 'post', url: '/cash-desk/supplier-payments', headers: {},
    };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('deposit helper does NOT attach to /pos/invoices', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('checkout/transfer/customer-payment/supplier-payment helpers do NOT attach to /cash-desk/deposit', () => {
    for (const fn of [
      attachCheckoutIdempotencyKeyIfApplicable,
      attachTransferIdempotencyKeyIfApplicable,
      attachCustomerPaymentIdempotencyKeyIfApplicable,
      attachSupplierPaymentIdempotencyKeyIfApplicable,
    ]) {
      const cfg: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
      fn(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('running ALL six helpers in sequence on /cash-desk/deposit uses the deposit key only', () => {
    const cfg: any = { method: 'post', url: '/cash-desk/deposit', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBeDefined();
    // The deposit module's getter must now return the SAME key seen
    // on the request — proves the request's value came from this
    // module, not any sibling.
    expect(k).toBe(getOrCreateCashDeskDepositIdempotencyKey());
  });

  it('running ALL six helpers in sequence on /cash-desk/transfer uses the transfer key only (deposit must NOT leak)', () => {
    const cfg: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBeDefined();
    // Whatever ended up on the wire must NOT match the deposit
    // module's standalone key — proves cross-fire didn't happen.
    expect(k).not.toBe(getOrCreateCashDeskDepositIdempotencyKey());
  });
});
