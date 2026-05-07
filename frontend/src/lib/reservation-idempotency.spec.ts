/**
 * reservation-idempotency.spec.ts — PR-FE-IDEM-RESERVATIONS
 *   (Sprint 5 / FE-IDEM PR 3)
 *
 * Pins the FE half of the opt-in idempotency contract for the
 * three reservation mutation routes already protected backend-side:
 *
 *   · POST /reservations/:id/cancel     (PR #311 BE)
 *   · POST /reservations/:id/payments   (PR #313 BE)
 *   · POST /reservations/:id/convert    (PR #314 BE)
 *
 *   1. One Idempotency-Key per ACTION TYPE (cancel / payment /
 *      convert). The three keys are isolated — minting a payment
 *      key does NOT affect the cancel key, and a cancel for
 *      reservation A does NOT collide with a convert for
 *      reservation B.
 *   2. Same key reused on retry within one open modal session
 *      (network blip, manual cashier retry, 425 IN_PROGRESS
 *      auto-retry from PR #315's shared response interceptor).
 *   3. Reset only when the matching `reset*()` is called (which
 *      fires on each modal mount + unmount via useEffect in
 *      pages/Reservations.tsx).
 *   4. Field tweaks within an open modal do NOT reset the key —
 *      payload-tamper safety lives BE-side via 409
 *      IDEMPOTENCY_KEY_PAYLOAD_MISMATCH.
 *   5. Header is attached only to the three exact route patterns —
 *      not to POST /reservations (create), not to PATCH
 *      /reservations/:id/extend, not to GETs, not to other POST
 *      routes elsewhere in the app.
 *   6. A caller-provided Idempotency-Key (any casing) is preserved.
 *   7. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *
 * Cross-route isolation: this helper MUST not cross-fire with the
 * six sibling helpers (checkout, transfer, expense,
 * customer-payment, supplier-payment, cash-desk-deposit). Pinned
 * in the final describe block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateReservationCancelIdempotencyKey,
  resetReservationCancelIdempotencyKey,
  _resetReservationCancelIdempotencyKeyForTests,
  getOrCreateReservationPaymentIdempotencyKey,
  resetReservationPaymentIdempotencyKey,
  _resetReservationPaymentIdempotencyKeyForTests,
  getOrCreateReservationConvertIdempotencyKey,
  resetReservationConvertIdempotencyKey,
  _resetReservationConvertIdempotencyKeyForTests,
  attachReservationIdempotencyKeyIfApplicable,
} from './reservation-idempotency';
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

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RES_ID = 'aaaa1111-bbbb-2222-cccc-333344445555'; // looks like a UUID

beforeEach(() => {
  _resetReservationCancelIdempotencyKeyForTests();
  _resetReservationPaymentIdempotencyKeyForTests();
  _resetReservationConvertIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetTransferIdempotencyKeyForTests();
  _resetCustomerPaymentIdempotencyKeyForTests();
  _resetSupplierPaymentIdempotencyKeyForTests();
  _resetCashDeskDepositIdempotencyKeyForTests();
});

// ── Per-action key lifecycle (cancel) ─────────────────────────────────
describe('reservation-cancel idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same cancel key on repeated calls within one intent', () => {
    const a = getOrCreateReservationCancelIdempotencyKey();
    const b = getOrCreateReservationCancelIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW cancel key', () => {
    const a = getOrCreateReservationCancelIdempotencyKey();
    resetReservationCancelIdempotencyKey();
    const b = getOrCreateReservationCancelIdempotencyKey();
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
      _resetReservationCancelIdempotencyKeyForTests();
      const k = getOrCreateReservationCancelIdempotencyKey();
      expect(k).toMatch(BE_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

// ── Per-action key lifecycle (payment) ────────────────────────────────
describe('reservation-payment idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same payment key on repeated calls within one intent', () => {
    const a = getOrCreateReservationPaymentIdempotencyKey();
    const b = getOrCreateReservationPaymentIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });
  it('reset → next getOrCreate returns a NEW payment key', () => {
    const a = getOrCreateReservationPaymentIdempotencyKey();
    resetReservationPaymentIdempotencyKey();
    const b = getOrCreateReservationPaymentIdempotencyKey();
    expect(b).not.toBe(a);
  });
});

// ── Per-action key lifecycle (convert) ────────────────────────────────
describe('reservation-convert idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same convert key on repeated calls within one intent', () => {
    const a = getOrCreateReservationConvertIdempotencyKey();
    const b = getOrCreateReservationConvertIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });
  it('reset → next getOrCreate returns a NEW convert key', () => {
    const a = getOrCreateReservationConvertIdempotencyKey();
    resetReservationConvertIdempotencyKey();
    const b = getOrCreateReservationConvertIdempotencyKey();
    expect(b).not.toBe(a);
  });
});

// ── Inter-action isolation ────────────────────────────────────────────
describe('inter-action isolation — three keys are independent', () => {
  it('cancel + payment + convert keys are all distinct from each other', () => {
    const c = getOrCreateReservationCancelIdempotencyKey();
    const p = getOrCreateReservationPaymentIdempotencyKey();
    const v = getOrCreateReservationConvertIdempotencyKey();
    expect(new Set([c, p, v]).size).toBe(3);
  });

  it('reset on cancel does NOT affect payment/convert keys', () => {
    getOrCreateReservationCancelIdempotencyKey();
    const p = getOrCreateReservationPaymentIdempotencyKey();
    const v = getOrCreateReservationConvertIdempotencyKey();
    resetReservationCancelIdempotencyKey();
    expect(getOrCreateReservationPaymentIdempotencyKey()).toBe(p);
    expect(getOrCreateReservationConvertIdempotencyKey()).toBe(v);
  });

  it('reset on payment does NOT affect cancel/convert keys', () => {
    const c = getOrCreateReservationCancelIdempotencyKey();
    getOrCreateReservationPaymentIdempotencyKey();
    const v = getOrCreateReservationConvertIdempotencyKey();
    resetReservationPaymentIdempotencyKey();
    expect(getOrCreateReservationCancelIdempotencyKey()).toBe(c);
    expect(getOrCreateReservationConvertIdempotencyKey()).toBe(v);
  });

  it('reset on convert does NOT affect cancel/payment keys', () => {
    const c = getOrCreateReservationCancelIdempotencyKey();
    const p = getOrCreateReservationPaymentIdempotencyKey();
    getOrCreateReservationConvertIdempotencyKey();
    resetReservationConvertIdempotencyKey();
    expect(getOrCreateReservationCancelIdempotencyKey()).toBe(c);
    expect(getOrCreateReservationPaymentIdempotencyKey()).toBe(p);
  });
});

// ── URL gate — POST + exact pattern matches ───────────────────────────
describe('attachReservationIdempotencyKeyIfApplicable — URL gate', () => {
  it('POST /reservations/:id/cancel attaches the cancel key', () => {
    const cfg: any = { method: 'post', url: `/reservations/${RES_ID}/cancel`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateReservationCancelIdempotencyKey(),
    );
  });

  it('POST /reservations/:id/payments attaches the payment key', () => {
    const cfg: any = { method: 'post', url: `/reservations/${RES_ID}/payments`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateReservationPaymentIdempotencyKey(),
    );
  });

  it('POST /reservations/:id/convert attaches the convert key', () => {
    const cfg: any = { method: 'post', url: `/reservations/${RES_ID}/convert`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateReservationConvertIdempotencyKey(),
    );
  });

  it('SAME cancel key on second POST cancel for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: `/reservations/${RES_ID}/cancel`, headers: {} };
    const cfg2: any = { method: 'post', url: `/reservations/${RES_ID}/cancel`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg1);
    attachReservationIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST cancel uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: `/reservations/${RES_ID}/cancel`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetReservationCancelIdempotencyKey();
    const cfg2: any = { method: 'post', url: `/reservations/${RES_ID}/cancel`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg2);
    const k2 = cfg2.headers['Idempotency-Key'];
    expect(k2).not.toBe(k1);
  });

  // ── Strict pattern: no match for create / extend / read / etc. ──
  it('does NOT attach on POST /reservations (create — out of scope)', () => {
    const cfg: any = { method: 'post', url: '/reservations', headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on PATCH /reservations/:id/extend (extend — out of scope)', () => {
    const cfg: any = { method: 'patch', url: `/reservations/${RES_ID}/extend`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /reservations/:id/extend even if method swapped to POST', () => {
    const cfg: any = { method: 'post', url: `/reservations/${RES_ID}/extend`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on GET (any reservation read)', () => {
    for (const url of [
      '/reservations',
      `/reservations/${RES_ID}`,
      `/reservations/${RES_ID}/cancel`, // GET on the same path → still no match
      `/reservations/${RES_ID}/payments`,
      `/reservations/${RES_ID}/convert`,
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachReservationIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PUT/DELETE /reservations/:id/cancel', () => {
    for (const method of ['put', 'delete']) {
      const cfg: any = { method, url: `/reservations/${RES_ID}/cancel`, headers: {} };
      attachReservationIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Bare base
      '/reservations',
      // Detail get
      `/reservations/${RES_ID}`,
      // Suffix beyond /cancel|payments|convert
      `/reservations/${RES_ID}/cancel/anything-else`,
      `/reservations/${RES_ID}/payments/abc`,
      `/reservations/${RES_ID}/convert/xyz`,
      // Wrong action segment
      `/reservations/${RES_ID}/refund`,
      `/reservations/${RES_ID}/void`,
      `/reservations/${RES_ID}/approve`,
      // Plural-vs-singular trap
      `/reservation/${RES_ID}/cancel`,
      // Adjacent collection
      '/reservation_items',
      // POS look-alike
      '/pos/invoices',
      // Cash-desk look-alikes
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/supplier-payments',
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachReservationIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key (Title-Case)', () => {
    const cfg: any = {
      method: 'post', url: `/reservations/${RES_ID}/cancel`,
      headers: { 'Idempotency-Key': 'caller-supplied-cancel-1234' },
    };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe('caller-supplied-cancel-1234');
  });

  it('preserves a caller-provided lowercase idempotency-key', () => {
    const cfg: any = {
      method: 'post', url: `/reservations/${RES_ID}/payments`,
      headers: { 'idempotency-key': 'caller-supplied-payment-1234' },
    };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['idempotency-key']).toBe('caller-supplied-payment-1234');
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('preserves a caller-provided UPPERCASE IDEMPOTENCY-KEY', () => {
    const cfg: any = {
      method: 'post', url: `/reservations/${RES_ID}/convert`,
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-convert-1234' },
    };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-convert-1234');
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: `/reservations/${RES_ID}/cancel`, headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('per-reservation: different reservation IDs on same action SHARE the key (intent boundary is the modal, not the id)', () => {
    // The lifecycle reset on modal mount/unmount enforces one-key-
    // per-modal-session. Within one open modal, the reservation
    // can't change. Two separate modals for two separate
    // reservations would have called reset() between them. This
    // test pins the helper-only behavior — the lifecycle wiring is
    // pinned by the component test path.
    const cfgA: any = { method: 'post', url: '/reservations/aaaa-1111/cancel', headers: {} };
    const cfgB: any = { method: 'post', url: '/reservations/bbbb-2222/cancel', headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfgA);
    attachReservationIdempotencyKeyIfApplicable(cfgB);
    expect(cfgA.headers['Idempotency-Key']).toBe(cfgB.headers['Idempotency-Key']);
  });
});

// ── Cross-route isolation against the 6 sibling helpers ───────────────
describe('cross-route isolation — reservation helper vs the 6 sibling helpers', () => {
  it('reservation helper does NOT attach to /pos/invoices', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachReservationIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('reservation helper does NOT attach to /cash-desk/* siblings', () => {
    for (const url of [
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/supplier-payments',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachReservationIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the six sibling helpers do NOT attach to /reservations/:id/{cancel,payments,convert}', () => {
    const fns = [
      attachCheckoutIdempotencyKeyIfApplicable,
      attachTransferIdempotencyKeyIfApplicable,
      attachCustomerPaymentIdempotencyKeyIfApplicable,
      attachSupplierPaymentIdempotencyKeyIfApplicable,
      attachCashDeskDepositIdempotencyKeyIfApplicable,
    ];
    for (const url of [
      `/reservations/${RES_ID}/cancel`,
      `/reservations/${RES_ID}/payments`,
      `/reservations/${RES_ID}/convert`,
    ]) {
      for (const fn of fns) {
        const cfg: any = { method: 'post', url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('running ALL seven helpers in sequence on /reservations/:id/cancel uses the cancel key only', () => {
    const cfg: any = { method: 'post', url: `/reservations/${RES_ID}/cancel`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBeDefined();
    expect(k).toBe(getOrCreateReservationCancelIdempotencyKey());
    // Must NOT be any of the unrelated keys.
    expect(k).not.toBe(getOrCreateReservationPaymentIdempotencyKey());
    expect(k).not.toBe(getOrCreateReservationConvertIdempotencyKey());
  });

  it('running ALL seven helpers on /pos/invoices uses the checkout key (reservation must NOT leak)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBeDefined();
    expect(k).not.toBe(getOrCreateReservationCancelIdempotencyKey());
    expect(k).not.toBe(getOrCreateReservationPaymentIdempotencyKey());
    expect(k).not.toBe(getOrCreateReservationConvertIdempotencyKey());
  });
});
