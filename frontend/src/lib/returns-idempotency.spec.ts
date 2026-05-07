/**
 * returns-idempotency.spec.ts — PR-FE-IDEM-RETURNS
 *   (Sprint 5 / FE-IDEM PR 4)
 *
 * Pins the FE half of the opt-in idempotency contract for the four
 * returns/exchanges mutation routes already protected backend-side:
 *
 *   · POST /returns/:id/approve  (BE: PR #310 / PR-11E + PR #312 / PR-11F)
 *   · POST /returns/:id/refund   (BE: PR #310 / PR-11E)
 *   · POST /returns/:id/cancel   (BE: PR #310 / PR-11E)
 *   · POST /exchanges            (BE: PR #308 / PR-11C)
 *
 *   1. One Idempotency-Key per ACTION TYPE (approve / refund /
 *      cancel / exchange). The four keys are isolated — minting
 *      one does NOT affect the others.
 *   2. Same key reused on retry within one open modal session.
 *   3. Reset only when the matching `reset*()` is called (which
 *      fires on each modal mount + unmount via useEffect in
 *      pages/Returns.tsx).
 *   4. Field tweaks within an open modal do NOT reset the key —
 *      payload-tamper safety lives BE-side via 409
 *      IDEMPOTENCY_KEY_PAYLOAD_MISMATCH.
 *   5. Header is attached only to the four exact patterns — not to
 *      POST /returns (create), not to POST /returns/:id/reject,
 *      not to GETs, not to other POST routes elsewhere.
 *   6. A caller-provided Idempotency-Key (any casing) is preserved.
 *   7. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *
 * Cross-route isolation: this helper MUST not cross-fire with the
 * seven sibling helpers (checkout, transfer, expense,
 * customer-payment, supplier-payment, cash-desk-deposit,
 * reservation). Pinned in the final describe block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateReturnsApproveIdempotencyKey,
  resetReturnsApproveIdempotencyKey,
  _resetReturnsApproveIdempotencyKeyForTests,
  getOrCreateReturnsRefundIdempotencyKey,
  resetReturnsRefundIdempotencyKey,
  _resetReturnsRefundIdempotencyKeyForTests,
  getOrCreateReturnsCancelIdempotencyKey,
  resetReturnsCancelIdempotencyKey,
  _resetReturnsCancelIdempotencyKeyForTests,
  getOrCreateReturnsExchangeIdempotencyKey,
  resetReturnsExchangeIdempotencyKey,
  _resetReturnsExchangeIdempotencyKeyForTests,
  attachReturnsIdempotencyKeyIfApplicable,
} from './returns-idempotency';
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
import {
  attachCashDeskDepositIdempotencyKeyIfApplicable,
  _resetCashDeskDepositIdempotencyKeyForTests,
} from './cash-desk-deposit-idempotency';
import {
  attachReservationIdempotencyKeyIfApplicable,
  _resetReservationCancelIdempotencyKeyForTests,
  _resetReservationPaymentIdempotencyKeyForTests,
  _resetReservationConvertIdempotencyKeyForTests,
} from './reservation-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RET_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';

beforeEach(() => {
  _resetReturnsApproveIdempotencyKeyForTests();
  _resetReturnsRefundIdempotencyKeyForTests();
  _resetReturnsCancelIdempotencyKeyForTests();
  _resetReturnsExchangeIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetTransferIdempotencyKeyForTests();
  _resetCustomerPaymentIdempotencyKeyForTests();
  _resetSupplierPaymentIdempotencyKeyForTests();
  _resetCashDeskDepositIdempotencyKeyForTests();
  _resetReservationCancelIdempotencyKeyForTests();
  _resetReservationPaymentIdempotencyKeyForTests();
  _resetReservationConvertIdempotencyKeyForTests();
});

// ── Per-action key lifecycle (approve) ────────────────────────────────
describe('returns-approve idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same approve key on repeated calls', () => {
    const a = getOrCreateReturnsApproveIdempotencyKey();
    const b = getOrCreateReturnsApproveIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW approve key', () => {
    const a = getOrCreateReturnsApproveIdempotencyKey();
    resetReturnsApproveIdempotencyKey();
    const b = getOrCreateReturnsApproveIdempotencyKey();
    expect(b).not.toBe(a);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetReturnsApproveIdempotencyKeyForTests();
      const k = getOrCreateReturnsApproveIdempotencyKey();
      expect(k).toMatch(BE_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

// ── Per-action key lifecycle (refund/cancel/exchange) ─────────────────
describe('returns-refund + cancel + exchange — key lifecycles', () => {
  it('refund: getOrCreate caches; reset mints fresh', () => {
    const a = getOrCreateReturnsRefundIdempotencyKey();
    expect(getOrCreateReturnsRefundIdempotencyKey()).toBe(a);
    resetReturnsRefundIdempotencyKey();
    expect(getOrCreateReturnsRefundIdempotencyKey()).not.toBe(a);
  });

  it('cancel: getOrCreate caches; reset mints fresh', () => {
    const a = getOrCreateReturnsCancelIdempotencyKey();
    expect(getOrCreateReturnsCancelIdempotencyKey()).toBe(a);
    resetReturnsCancelIdempotencyKey();
    expect(getOrCreateReturnsCancelIdempotencyKey()).not.toBe(a);
  });

  it('exchange: getOrCreate caches; reset mints fresh', () => {
    const a = getOrCreateReturnsExchangeIdempotencyKey();
    expect(getOrCreateReturnsExchangeIdempotencyKey()).toBe(a);
    resetReturnsExchangeIdempotencyKey();
    expect(getOrCreateReturnsExchangeIdempotencyKey()).not.toBe(a);
  });
});

// ── Inter-action isolation ────────────────────────────────────────────
describe('inter-action isolation — four keys are independent', () => {
  it('approve + refund + cancel + exchange keys are all distinct', () => {
    const a = getOrCreateReturnsApproveIdempotencyKey();
    const r = getOrCreateReturnsRefundIdempotencyKey();
    const c = getOrCreateReturnsCancelIdempotencyKey();
    const e = getOrCreateReturnsExchangeIdempotencyKey();
    expect(new Set([a, r, c, e]).size).toBe(4);
  });

  it('reset on approve does NOT affect refund/cancel/exchange keys', () => {
    getOrCreateReturnsApproveIdempotencyKey();
    const r = getOrCreateReturnsRefundIdempotencyKey();
    const c = getOrCreateReturnsCancelIdempotencyKey();
    const e = getOrCreateReturnsExchangeIdempotencyKey();
    resetReturnsApproveIdempotencyKey();
    expect(getOrCreateReturnsRefundIdempotencyKey()).toBe(r);
    expect(getOrCreateReturnsCancelIdempotencyKey()).toBe(c);
    expect(getOrCreateReturnsExchangeIdempotencyKey()).toBe(e);
  });

  it('reset on refund does NOT affect approve/cancel/exchange keys', () => {
    const a = getOrCreateReturnsApproveIdempotencyKey();
    getOrCreateReturnsRefundIdempotencyKey();
    const c = getOrCreateReturnsCancelIdempotencyKey();
    const e = getOrCreateReturnsExchangeIdempotencyKey();
    resetReturnsRefundIdempotencyKey();
    expect(getOrCreateReturnsApproveIdempotencyKey()).toBe(a);
    expect(getOrCreateReturnsCancelIdempotencyKey()).toBe(c);
    expect(getOrCreateReturnsExchangeIdempotencyKey()).toBe(e);
  });

  it('reset on cancel does NOT affect approve/refund/exchange keys', () => {
    const a = getOrCreateReturnsApproveIdempotencyKey();
    const r = getOrCreateReturnsRefundIdempotencyKey();
    getOrCreateReturnsCancelIdempotencyKey();
    const e = getOrCreateReturnsExchangeIdempotencyKey();
    resetReturnsCancelIdempotencyKey();
    expect(getOrCreateReturnsApproveIdempotencyKey()).toBe(a);
    expect(getOrCreateReturnsRefundIdempotencyKey()).toBe(r);
    expect(getOrCreateReturnsExchangeIdempotencyKey()).toBe(e);
  });

  it('reset on exchange does NOT affect approve/refund/cancel keys', () => {
    const a = getOrCreateReturnsApproveIdempotencyKey();
    const r = getOrCreateReturnsRefundIdempotencyKey();
    const c = getOrCreateReturnsCancelIdempotencyKey();
    getOrCreateReturnsExchangeIdempotencyKey();
    resetReturnsExchangeIdempotencyKey();
    expect(getOrCreateReturnsApproveIdempotencyKey()).toBe(a);
    expect(getOrCreateReturnsRefundIdempotencyKey()).toBe(r);
    expect(getOrCreateReturnsCancelIdempotencyKey()).toBe(c);
  });
});

// ── URL gate — POST + exact pattern matches ───────────────────────────
describe('attachReturnsIdempotencyKeyIfApplicable — URL gate', () => {
  it('POST /returns/:id/approve attaches the approve key', () => {
    const cfg: any = { method: 'post', url: `/returns/${RET_ID}/approve`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateReturnsApproveIdempotencyKey(),
    );
  });

  it('POST /returns/:id/refund attaches the refund key', () => {
    const cfg: any = { method: 'post', url: `/returns/${RET_ID}/refund`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateReturnsRefundIdempotencyKey(),
    );
  });

  it('POST /returns/:id/cancel attaches the cancel key', () => {
    const cfg: any = { method: 'post', url: `/returns/${RET_ID}/cancel`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateReturnsCancelIdempotencyKey(),
    );
  });

  it('POST /exchanges attaches the exchange key', () => {
    const cfg: any = { method: 'post', url: '/exchanges', headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateReturnsExchangeIdempotencyKey(),
    );
  });

  it('SAME approve key on second POST approve for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: `/returns/${RET_ID}/approve`, headers: {} };
    const cfg2: any = { method: 'post', url: `/returns/${RET_ID}/approve`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg1);
    attachReturnsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST approve uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: `/returns/${RET_ID}/approve`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetReturnsApproveIdempotencyKey();
    const cfg2: any = { method: 'post', url: `/returns/${RET_ID}/approve`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  it('SAME exchange key on second POST /exchanges for same intent', () => {
    const cfg1: any = { method: 'post', url: '/exchanges', headers: {} };
    const cfg2: any = { method: 'post', url: '/exchanges', headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg1);
    attachReturnsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  // ── Strict pattern: no match for create / reject / read / etc. ──
  it('does NOT attach on POST /returns (create — out of scope)', () => {
    const cfg: any = { method: 'post', url: '/returns', headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /returns/:id/reject (reject — out of scope)', () => {
    const cfg: any = { method: 'post', url: `/returns/${RET_ID}/reject`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on GET (any returns/exchanges read)', () => {
    for (const url of [
      '/returns',
      `/returns/${RET_ID}`,
      `/returns/${RET_ID}/approve`, // GET on same path → no match
      `/returns/${RET_ID}/refund`,
      `/returns/${RET_ID}/cancel`,
      `/returns/lookup/INV-2026-001`,
      '/exchanges',
      `/exchanges/${RET_ID}`,
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachReturnsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PATCH/PUT/DELETE on the four target patterns', () => {
    for (const method of ['patch', 'put', 'delete']) {
      for (const url of [
        `/returns/${RET_ID}/approve`,
        `/returns/${RET_ID}/refund`,
        `/returns/${RET_ID}/cancel`,
        '/exchanges',
      ]) {
        const cfg: any = { method, url, headers: {} };
        attachReturnsIdempotencyKeyIfApplicable(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Bare base
      '/returns',
      // Detail get / lookup
      `/returns/${RET_ID}`,
      `/returns/lookup/INV-2026-001`,
      // Suffix beyond the action segments
      `/returns/${RET_ID}/approve/anything-else`,
      `/returns/${RET_ID}/refund/abc`,
      `/returns/${RET_ID}/cancel/xyz`,
      // Wrong action segment
      `/returns/${RET_ID}/void`,
      `/returns/${RET_ID}/edit`,
      `/returns/${RET_ID}/reject`, // explicitly out of scope
      // Plural-vs-singular trap
      `/return/${RET_ID}/approve`,
      // Adjacent collection
      `/returns_items`,
      // /exchanges sub-paths (only the bare /exchanges is decorated)
      `/exchanges/${RET_ID}`,
      `/exchanges/${RET_ID}/anything`,
      `/exchanges/lookup`,
      // POS / cash-desk siblings
      '/pos/invoices',
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      // Reservations
      `/reservations/${RET_ID}/cancel`,
      `/reservations/${RET_ID}/payments`,
      `/reservations/${RET_ID}/convert`,
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachReturnsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key (Title-Case)', () => {
    const cfg: any = {
      method: 'post', url: `/returns/${RET_ID}/approve`,
      headers: { 'Idempotency-Key': 'caller-supplied-approve-1234' },
    };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe('caller-supplied-approve-1234');
  });

  it('preserves a caller-provided lowercase idempotency-key', () => {
    const cfg: any = {
      method: 'post', url: `/returns/${RET_ID}/refund`,
      headers: { 'idempotency-key': 'caller-supplied-refund-1234' },
    };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['idempotency-key']).toBe('caller-supplied-refund-1234');
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('preserves a caller-provided UPPERCASE IDEMPOTENCY-KEY', () => {
    const cfg: any = {
      method: 'post', url: '/exchanges',
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-exchange-1234' },
    };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-exchange-1234');
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: `/returns/${RET_ID}/approve`, headers: {} };
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

// ── Cross-route isolation against the 7 sibling helpers ───────────────
describe('cross-route isolation — returns helper vs the 7 sibling helpers', () => {
  it('returns helper does NOT attach to /pos/invoices or /reservations/* or /cash-desk/*', () => {
    for (const url of [
      '/pos/invoices',
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/supplier-payments',
      `/reservations/${RET_ID}/cancel`,
      `/reservations/${RET_ID}/payments`,
      `/reservations/${RET_ID}/convert`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachReturnsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the seven sibling helpers do NOT attach to any of the 4 returns/exchanges routes', () => {
    const fns = [
      attachCheckoutIdempotencyKeyIfApplicable,
      attachTransferIdempotencyKeyIfApplicable,
      attachCustomerPaymentIdempotencyKeyIfApplicable,
      attachSupplierPaymentIdempotencyKeyIfApplicable,
      attachCashDeskDepositIdempotencyKeyIfApplicable,
      attachReservationIdempotencyKeyIfApplicable,
    ];
    for (const url of [
      `/returns/${RET_ID}/approve`,
      `/returns/${RET_ID}/refund`,
      `/returns/${RET_ID}/cancel`,
      '/exchanges',
    ]) {
      for (const fn of fns) {
        const cfg: any = { method: 'post', url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('running ALL eight helpers in sequence on /returns/:id/approve uses the approve key only', () => {
    const cfg: any = { method: 'post', url: `/returns/${RET_ID}/approve`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBeDefined();
    expect(k).toBe(getOrCreateReturnsApproveIdempotencyKey());
    // Must NOT be any unrelated returns key.
    expect(k).not.toBe(getOrCreateReturnsRefundIdempotencyKey());
    expect(k).not.toBe(getOrCreateReturnsCancelIdempotencyKey());
    expect(k).not.toBe(getOrCreateReturnsExchangeIdempotencyKey());
  });

  it('running ALL eight helpers on /exchanges uses the exchange key only', () => {
    const cfg: any = { method: 'post', url: '/exchanges', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBeDefined();
    expect(k).toBe(getOrCreateReturnsExchangeIdempotencyKey());
  });

  it('running ALL eight helpers on /pos/invoices yields checkout key (returns keys must NOT leak)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBeDefined();
    // No returns key should have leaked through.
    expect(k).not.toBe(getOrCreateReturnsApproveIdempotencyKey());
    expect(k).not.toBe(getOrCreateReturnsRefundIdempotencyKey());
    expect(k).not.toBe(getOrCreateReturnsCancelIdempotencyKey());
    expect(k).not.toBe(getOrCreateReturnsExchangeIdempotencyKey());
  });
});
