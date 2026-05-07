/**
 * pos-invoice-idempotency.spec.ts — PR-FE-IDEM-POS-VOID-EDIT
 *   (Sprint 5 / FE-IDEM PR 5)
 *
 * Pins the FE half of the opt-in idempotency contract for three
 * POS invoice mutation routes already protected backend-side:
 *
 *   · POST /pos/invoices/:id/void          (BE: PR #310 / PR-11E)
 *   · POST /pos/invoices/:id/edit          (BE: PR #308 / PR-11C)
 *   · POST /pos/edit-requests/:id/approve  (BE: PR #312 / PR-11F)
 *
 *   1. One Idempotency-Key per ACTION TYPE (void / edit /
 *      edit-request-approve). The three keys are isolated.
 *   2. Same key reused on retry within one open modal session
 *      (void/edit) OR within one click intent (approve, where the
 *      caller resets per click in the EditHistoryTab handler).
 *   3. Reset only when the matching `reset*()` is called.
 *   4. Field tweaks within a modal do NOT reset — body-tamper
 *      safety is BE-side via 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH.
 *   5. Header is attached only to the three exact patterns — not
 *      to POST /pos/invoices (create — that's the existing
 *      checkout helper's territory), not to /edit-request, not to
 *      /reject, not to GETs.
 *   6. A caller-provided Idempotency-Key (any casing) is preserved.
 *   7. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *
 * Coexistence: this helper MUST not cross-fire with the existing
 * checkout helper (which decorates POST /pos/invoices create). The
 * checkout helper MUST keep working unchanged. Pinned in the
 * cross-route isolation block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreatePosInvoiceVoidIdempotencyKey,
  resetPosInvoiceVoidIdempotencyKey,
  _resetPosInvoiceVoidIdempotencyKeyForTests,
  getOrCreatePosInvoiceEditIdempotencyKey,
  resetPosInvoiceEditIdempotencyKey,
  _resetPosInvoiceEditIdempotencyKeyForTests,
  getOrCreatePosEditRequestApproveIdempotencyKey,
  resetPosEditRequestApproveIdempotencyKey,
  _resetPosEditRequestApproveIdempotencyKeyForTests,
  attachPosInvoiceIdempotencyKeyIfApplicable,
} from './pos-invoice-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  getOrCreateCheckoutIdempotencyKey,
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
import {
  attachReturnsIdempotencyKeyIfApplicable,
  _resetReturnsApproveIdempotencyKeyForTests,
  _resetReturnsRefundIdempotencyKeyForTests,
  _resetReturnsCancelIdempotencyKeyForTests,
  _resetReturnsExchangeIdempotencyKeyForTests,
} from './returns-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const INV_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const REQ_ID = 'eeee5555-ffff-6666-aaaa-777788889999';

beforeEach(() => {
  _resetPosInvoiceVoidIdempotencyKeyForTests();
  _resetPosInvoiceEditIdempotencyKeyForTests();
  _resetPosEditRequestApproveIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetTransferIdempotencyKeyForTests();
  _resetCustomerPaymentIdempotencyKeyForTests();
  _resetSupplierPaymentIdempotencyKeyForTests();
  _resetCashDeskDepositIdempotencyKeyForTests();
  _resetReservationCancelIdempotencyKeyForTests();
  _resetReservationPaymentIdempotencyKeyForTests();
  _resetReservationConvertIdempotencyKeyForTests();
  _resetReturnsApproveIdempotencyKeyForTests();
  _resetReturnsRefundIdempotencyKeyForTests();
  _resetReturnsCancelIdempotencyKeyForTests();
  _resetReturnsExchangeIdempotencyKeyForTests();
});

// ── Per-action key lifecycle ─────────────────────────────────────────
describe('pos-invoice idempotency module — key lifecycle', () => {
  it('void: getOrCreate caches; reset mints fresh', () => {
    const a = getOrCreatePosInvoiceVoidIdempotencyKey();
    expect(getOrCreatePosInvoiceVoidIdempotencyKey()).toBe(a);
    resetPosInvoiceVoidIdempotencyKey();
    expect(getOrCreatePosInvoiceVoidIdempotencyKey()).not.toBe(a);
  });

  it('edit: getOrCreate caches; reset mints fresh', () => {
    const a = getOrCreatePosInvoiceEditIdempotencyKey();
    expect(getOrCreatePosInvoiceEditIdempotencyKey()).toBe(a);
    resetPosInvoiceEditIdempotencyKey();
    expect(getOrCreatePosInvoiceEditIdempotencyKey()).not.toBe(a);
  });

  it('edit-request-approve: getOrCreate caches; reset mints fresh', () => {
    const a = getOrCreatePosEditRequestApproveIdempotencyKey();
    expect(getOrCreatePosEditRequestApproveIdempotencyKey()).toBe(a);
    resetPosEditRequestApproveIdempotencyKey();
    expect(getOrCreatePosEditRequestApproveIdempotencyKey()).not.toBe(a);
  });

  it('keys match BE_PATTERN', () => {
    expect(getOrCreatePosInvoiceVoidIdempotencyKey()).toMatch(BE_PATTERN);
    expect(getOrCreatePosInvoiceEditIdempotencyKey()).toMatch(BE_PATTERN);
    expect(getOrCreatePosEditRequestApproveIdempotencyKey()).toMatch(BE_PATTERN);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetPosInvoiceVoidIdempotencyKeyForTests();
      _resetPosInvoiceEditIdempotencyKeyForTests();
      _resetPosEditRequestApproveIdempotencyKeyForTests();
      expect(getOrCreatePosInvoiceVoidIdempotencyKey()).toMatch(BE_PATTERN);
      expect(getOrCreatePosInvoiceEditIdempotencyKey()).toMatch(BE_PATTERN);
      expect(getOrCreatePosEditRequestApproveIdempotencyKey()).toMatch(BE_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

// ── Inter-action isolation ────────────────────────────────────────────
describe('inter-action isolation — three keys are independent', () => {
  it('void + edit + edit-request-approve keys are all distinct', () => {
    const v = getOrCreatePosInvoiceVoidIdempotencyKey();
    const e = getOrCreatePosInvoiceEditIdempotencyKey();
    const a = getOrCreatePosEditRequestApproveIdempotencyKey();
    expect(new Set([v, e, a]).size).toBe(3);
  });

  it('reset on void does NOT affect edit/approve keys', () => {
    getOrCreatePosInvoiceVoidIdempotencyKey();
    const e = getOrCreatePosInvoiceEditIdempotencyKey();
    const a = getOrCreatePosEditRequestApproveIdempotencyKey();
    resetPosInvoiceVoidIdempotencyKey();
    expect(getOrCreatePosInvoiceEditIdempotencyKey()).toBe(e);
    expect(getOrCreatePosEditRequestApproveIdempotencyKey()).toBe(a);
  });

  it('reset on edit does NOT affect void/approve keys', () => {
    const v = getOrCreatePosInvoiceVoidIdempotencyKey();
    getOrCreatePosInvoiceEditIdempotencyKey();
    const a = getOrCreatePosEditRequestApproveIdempotencyKey();
    resetPosInvoiceEditIdempotencyKey();
    expect(getOrCreatePosInvoiceVoidIdempotencyKey()).toBe(v);
    expect(getOrCreatePosEditRequestApproveIdempotencyKey()).toBe(a);
  });

  it('reset on approve does NOT affect void/edit keys', () => {
    const v = getOrCreatePosInvoiceVoidIdempotencyKey();
    const e = getOrCreatePosInvoiceEditIdempotencyKey();
    getOrCreatePosEditRequestApproveIdempotencyKey();
    resetPosEditRequestApproveIdempotencyKey();
    expect(getOrCreatePosInvoiceVoidIdempotencyKey()).toBe(v);
    expect(getOrCreatePosInvoiceEditIdempotencyKey()).toBe(e);
  });
});

// ── URL gate — POST + exact pattern matches ───────────────────────────
describe('attachPosInvoiceIdempotencyKeyIfApplicable — URL gate', () => {
  it('POST /pos/invoices/:id/void attaches the void key', () => {
    const cfg: any = { method: 'post', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreatePosInvoiceVoidIdempotencyKey(),
    );
  });

  it('POST /pos/invoices/:id/edit attaches the edit key', () => {
    const cfg: any = { method: 'post', url: `/pos/invoices/${INV_ID}/edit`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreatePosInvoiceEditIdempotencyKey(),
    );
  });

  it('POST /pos/edit-requests/:id/approve attaches the approve key', () => {
    const cfg: any = { method: 'post', url: `/pos/edit-requests/${REQ_ID}/approve`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreatePosEditRequestApproveIdempotencyKey(),
    );
  });

  it('SAME void key on second POST void for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    const cfg2: any = { method: 'post', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg1);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST void uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetPosInvoiceVoidIdempotencyKey();
    const cfg2: any = { method: 'post', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  // ── Strict pattern: no match for create / edit-request / reject / etc. ──
  it('does NOT attach on POST /pos/invoices (create — checkout helper territory)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /pos/invoices/:id/edit-request (state — out of scope)', () => {
    const cfg: any = { method: 'post', url: `/pos/invoices/${INV_ID}/edit-request`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /pos/edit-requests/:id/reject (state — out of scope)', () => {
    const cfg: any = { method: 'post', url: `/pos/edit-requests/${REQ_ID}/reject`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on GET (any /pos/* read path)', () => {
    for (const url of [
      '/pos/invoices',
      `/pos/invoices/${INV_ID}`,
      `/pos/invoices/${INV_ID}/void`, // GET on same path → no match
      `/pos/invoices/${INV_ID}/edit`,
      `/pos/invoices/${INV_ID}/receipt`,
      `/pos/invoices/${INV_ID}/edit-history`,
      `/pos/invoices/${INV_ID}/edit-requests`,
      '/pos/edit-requests/pending',
      `/pos/edit-requests/${REQ_ID}/approve`,
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PATCH/PUT/DELETE on the three target patterns', () => {
    for (const method of ['patch', 'put', 'delete']) {
      for (const url of [
        `/pos/invoices/${INV_ID}/void`,
        `/pos/invoices/${INV_ID}/edit`,
        `/pos/edit-requests/${REQ_ID}/approve`,
      ]) {
        const cfg: any = { method, url, headers: {} };
        attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Suffix beyond the action segments
      `/pos/invoices/${INV_ID}/void/anything-else`,
      `/pos/invoices/${INV_ID}/edit/abc`,
      `/pos/edit-requests/${REQ_ID}/approve/xyz`,
      // Wrong action segment
      `/pos/invoices/${INV_ID}/cancel`,
      `/pos/invoices/${INV_ID}/refund`,
      `/pos/invoices/${INV_ID}/edit-history`,
      // Plural-vs-singular trap
      `/pos/invoice/${INV_ID}/void`,
      `/pos/edit-request/${REQ_ID}/approve`,
      // Adjacent collections
      '/pos/edit-requests',
      '/pos/edit-requests/pending',
      // POS create and read paths
      '/pos/invoices',
      `/pos/invoices/${INV_ID}`,
      `/pos/invoices/${INV_ID}/receipt`,
      // Other controllers' siblings
      `/returns/${INV_ID}/approve`,  // returns approve, not pos
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      `/reservations/${INV_ID}/cancel`,
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key (Title-Case) on void route', () => {
    const cfg: any = {
      method: 'post', url: `/pos/invoices/${INV_ID}/void`,
      headers: { 'Idempotency-Key': 'caller-supplied-void-1234' },
    };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe('caller-supplied-void-1234');
  });

  it('preserves a caller-provided lowercase idempotency-key on edit route', () => {
    const cfg: any = {
      method: 'post', url: `/pos/invoices/${INV_ID}/edit`,
      headers: { 'idempotency-key': 'caller-supplied-edit-1234' },
    };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['idempotency-key']).toBe('caller-supplied-edit-1234');
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('preserves a caller-provided UPPERCASE IDEMPOTENCY-KEY on approve route', () => {
    const cfg: any = {
      method: 'post', url: `/pos/edit-requests/${REQ_ID}/approve`,
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-approve-1234' },
    };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-approve-1234');
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

// ── Coexistence with the existing checkout helper (POST /pos/invoices) ─
describe('coexistence with existing POS invoice create (checkout) helper', () => {
  it('checkout helper still attaches on POST /pos/invoices (this PR did NOT regress it)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateCheckoutIdempotencyKey(),
    );
  });

  it('this helper does NOT attach on POST /pos/invoices (checkout-only territory)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('checkout helper does NOT attach on /pos/invoices/:id/void (this helper-only territory)', () => {
    const cfg: any = { method: 'post', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('running BOTH helpers in interceptor order on POST /pos/invoices uses checkout key only', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreateCheckoutIdempotencyKey());
    expect(k).not.toBe(getOrCreatePosInvoiceVoidIdempotencyKey());
    expect(k).not.toBe(getOrCreatePosInvoiceEditIdempotencyKey());
  });

  it('running BOTH helpers on POST /pos/invoices/:id/edit uses this helper edit key only', () => {
    const cfg: any = { method: 'post', url: `/pos/invoices/${INV_ID}/edit`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreatePosInvoiceEditIdempotencyKey());
    expect(k).not.toBe(getOrCreateCheckoutIdempotencyKey());
  });
});

// ── Cross-route isolation against the 8 sibling helpers ───────────────
describe('cross-route isolation — pos-invoice helper vs the 8 sibling helpers', () => {
  it('pos-invoice helper does NOT attach to /cash-desk/* or /reservations/* or /returns/*', () => {
    for (const url of [
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/supplier-payments',
      `/reservations/${INV_ID}/cancel`,
      `/reservations/${INV_ID}/payments`,
      `/reservations/${INV_ID}/convert`,
      `/returns/${INV_ID}/approve`,
      `/returns/${INV_ID}/refund`,
      `/returns/${INV_ID}/cancel`,
      '/exchanges',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the sibling helpers do NOT attach to any of the 3 pos-invoice mutation routes', () => {
    const fns = [
      // Note: checkout is INTENTIONALLY excluded — it's the same family
      // as this helper (POS invoices) and is tested separately above.
      attachTransferIdempotencyKeyIfApplicable,
      attachCustomerPaymentIdempotencyKeyIfApplicable,
      attachSupplierPaymentIdempotencyKeyIfApplicable,
      attachCashDeskDepositIdempotencyKeyIfApplicable,
      attachReservationIdempotencyKeyIfApplicable,
      attachReturnsIdempotencyKeyIfApplicable,
    ];
    for (const url of [
      `/pos/invoices/${INV_ID}/void`,
      `/pos/invoices/${INV_ID}/edit`,
      `/pos/edit-requests/${REQ_ID}/approve`,
    ]) {
      for (const fn of fns) {
        const cfg: any = { method: 'post', url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('running ALL nine helpers in sequence on /pos/invoices/:id/void uses the void key only', () => {
    const cfg: any = { method: 'post', url: `/pos/invoices/${INV_ID}/void`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreatePosInvoiceVoidIdempotencyKey());
    // Must NOT be any unrelated POS invoice key.
    expect(k).not.toBe(getOrCreatePosInvoiceEditIdempotencyKey());
    expect(k).not.toBe(getOrCreatePosEditRequestApproveIdempotencyKey());
    // And must NOT be the checkout key.
    expect(k).not.toBe(getOrCreateCheckoutIdempotencyKey());
  });

  it('running ALL nine helpers on /pos/edit-requests/:id/approve uses the approve key only', () => {
    const cfg: any = { method: 'post', url: `/pos/edit-requests/${REQ_ID}/approve`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreatePosEditRequestApproveIdempotencyKey());
  });
});
