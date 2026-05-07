/**
 * shifts-idempotency.spec.ts — PR-FE-IDEM-SHIFTS-OPS
 *   (Sprint 5 / FE-IDEM PR 7A)
 *
 * Pins the FE half of the opt-in idempotency contract for three
 * shift mutation routes already protected backend-side:
 *
 *   · POST /shifts/:id/close          (BE: PR #312 / PR-11F)
 *   · POST /shifts/:id/approve-close  (BE: PR #312 / PR-11F)
 *   · POST /shifts/:id/adjust-count   (BE: PR #306 / PR-11A)
 *
 *   1. One Idempotency-Key per ACTION TYPE — the three keys are
 *      isolated.
 *   2. Same key reused on retry within one open modal session OR
 *      within one row-click.
 *   3. Reset only when the matching `reset*()` is called.
 *   4. Header is attached only to the three exact patterns — not
 *      to /shifts/:id/{request-close,reject-close} (state), not
 *      to /shifts/open, not to /shifts read paths, not to
 *      /shifts/reports/* aggregates, not to GETs.
 *   5. A caller-provided Idempotency-Key (any casing) is preserved.
 *   6. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *
 * Cross-route isolation: this helper MUST not cross-fire with the
 * ten sibling helpers (checkout, transfer, expense,
 * customer-payment, supplier-payment, cash-desk-deposit,
 * reservation, returns, pos-invoice, payroll). Pinned in the
 * final block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateShiftsCloseIdempotencyKey,
  resetShiftsCloseIdempotencyKey,
  _resetShiftsCloseIdempotencyKeyForTests,
  getOrCreateShiftsApproveCloseIdempotencyKey,
  resetShiftsApproveCloseIdempotencyKey,
  _resetShiftsApproveCloseIdempotencyKeyForTests,
  getOrCreateShiftsAdjustCountIdempotencyKey,
  resetShiftsAdjustCountIdempotencyKey,
  _resetShiftsAdjustCountIdempotencyKeyForTests,
  attachShiftsIdempotencyKeyIfApplicable,
} from './shifts-idempotency';
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
import {
  attachReturnsIdempotencyKeyIfApplicable,
  _resetReturnsApproveIdempotencyKeyForTests,
  _resetReturnsRefundIdempotencyKeyForTests,
  _resetReturnsCancelIdempotencyKeyForTests,
  _resetReturnsExchangeIdempotencyKeyForTests,
} from './returns-idempotency';
import {
  attachPosInvoiceIdempotencyKeyIfApplicable,
  _resetPosInvoiceVoidIdempotencyKeyForTests,
  _resetPosInvoiceEditIdempotencyKeyForTests,
  _resetPosEditRequestApproveIdempotencyKeyForTests,
} from './pos-invoice-idempotency';
import {
  attachPayrollIdempotencyKeyIfApplicable,
  _resetPayrollApproveWageIdempotencyKeyForTests,
  _resetPayrollVoidAccrualIdempotencyKeyForTests,
  _resetPayrollApproveWageOverrideIdempotencyKeyForTests,
  _resetPayrollPayWageIdempotencyKeyForTests,
  _resetPayrollBonusIdempotencyKeyForTests,
  _resetPayrollDeductionIdempotencyKeyForTests,
  _resetPayrollSettlementIdempotencyKeyForTests,
} from './payroll-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SHIFT_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';

beforeEach(() => {
  _resetShiftsCloseIdempotencyKeyForTests();
  _resetShiftsApproveCloseIdempotencyKeyForTests();
  _resetShiftsAdjustCountIdempotencyKeyForTests();
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
  _resetPosInvoiceVoidIdempotencyKeyForTests();
  _resetPosInvoiceEditIdempotencyKeyForTests();
  _resetPosEditRequestApproveIdempotencyKeyForTests();
  _resetPayrollApproveWageIdempotencyKeyForTests();
  _resetPayrollVoidAccrualIdempotencyKeyForTests();
  _resetPayrollApproveWageOverrideIdempotencyKeyForTests();
  _resetPayrollPayWageIdempotencyKeyForTests();
  _resetPayrollBonusIdempotencyKeyForTests();
  _resetPayrollDeductionIdempotencyKeyForTests();
  _resetPayrollSettlementIdempotencyKeyForTests();
});

// ── Per-action key lifecycle ─────────────────────────────────────────
describe('shifts idempotency module — key lifecycle', () => {
  const cases: Array<[string, () => string, () => void]> = [
    ['close',         getOrCreateShiftsCloseIdempotencyKey,        resetShiftsCloseIdempotencyKey],
    ['approve-close', getOrCreateShiftsApproveCloseIdempotencyKey, resetShiftsApproveCloseIdempotencyKey],
    ['adjust-count',  getOrCreateShiftsAdjustCountIdempotencyKey,  resetShiftsAdjustCountIdempotencyKey],
  ];
  it.each(cases)('%s: getOrCreate caches; reset mints fresh; matches BE_PATTERN', (_, get, reset) => {
    const a = get();
    expect(get()).toBe(a);
    expect(a).toMatch(BE_PATTERN);
    reset();
    expect(get()).not.toBe(a);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetShiftsCloseIdempotencyKeyForTests();
      _resetShiftsApproveCloseIdempotencyKeyForTests();
      _resetShiftsAdjustCountIdempotencyKeyForTests();
      expect(getOrCreateShiftsCloseIdempotencyKey()).toMatch(BE_PATTERN);
      expect(getOrCreateShiftsApproveCloseIdempotencyKey()).toMatch(BE_PATTERN);
      expect(getOrCreateShiftsAdjustCountIdempotencyKey()).toMatch(BE_PATTERN);
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
  it('all three keys are distinct from each other', () => {
    const c = getOrCreateShiftsCloseIdempotencyKey();
    const a = getOrCreateShiftsApproveCloseIdempotencyKey();
    const j = getOrCreateShiftsAdjustCountIdempotencyKey();
    expect(new Set([c, a, j]).size).toBe(3);
  });

  it('reset on close does NOT affect approve-close/adjust-count', () => {
    getOrCreateShiftsCloseIdempotencyKey();
    const a = getOrCreateShiftsApproveCloseIdempotencyKey();
    const j = getOrCreateShiftsAdjustCountIdempotencyKey();
    resetShiftsCloseIdempotencyKey();
    expect(getOrCreateShiftsApproveCloseIdempotencyKey()).toBe(a);
    expect(getOrCreateShiftsAdjustCountIdempotencyKey()).toBe(j);
  });

  it('reset on approve-close does NOT affect close/adjust-count', () => {
    const c = getOrCreateShiftsCloseIdempotencyKey();
    getOrCreateShiftsApproveCloseIdempotencyKey();
    const j = getOrCreateShiftsAdjustCountIdempotencyKey();
    resetShiftsApproveCloseIdempotencyKey();
    expect(getOrCreateShiftsCloseIdempotencyKey()).toBe(c);
    expect(getOrCreateShiftsAdjustCountIdempotencyKey()).toBe(j);
  });

  it('reset on adjust-count does NOT affect close/approve-close', () => {
    const c = getOrCreateShiftsCloseIdempotencyKey();
    const a = getOrCreateShiftsApproveCloseIdempotencyKey();
    getOrCreateShiftsAdjustCountIdempotencyKey();
    resetShiftsAdjustCountIdempotencyKey();
    expect(getOrCreateShiftsCloseIdempotencyKey()).toBe(c);
    expect(getOrCreateShiftsApproveCloseIdempotencyKey()).toBe(a);
  });
});

// ── URL gate — POST + exact pattern matches ───────────────────────────
describe('attachShiftsIdempotencyKeyIfApplicable — URL gate', () => {
  const routeCases: Array<[string, string, () => string]> = [
    ['close',         `/shifts/${SHIFT_ID}/close`,         getOrCreateShiftsCloseIdempotencyKey],
    ['approve-close', `/shifts/${SHIFT_ID}/approve-close`, getOrCreateShiftsApproveCloseIdempotencyKey],
    ['adjust-count',  `/shifts/${SHIFT_ID}/adjust-count`,  getOrCreateShiftsAdjustCountIdempotencyKey],
  ];
  it.each(routeCases)('POST %s attaches the correct key', (_, url, getter) => {
    const cfg: any = { method: 'post', url, headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(getter());
  });

  it('SAME close key on second POST close for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: `/shifts/${SHIFT_ID}/close`, headers: {} };
    const cfg2: any = { method: 'post', url: `/shifts/${SHIFT_ID}/close`, headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg1);
    attachShiftsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST close uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: `/shifts/${SHIFT_ID}/close`, headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetShiftsCloseIdempotencyKey();
    const cfg2: any = { method: 'post', url: `/shifts/${SHIFT_ID}/close`, headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  it('different shift_ids on /approve-close SHARE the approve-close key (intent boundary is the click)', () => {
    const cfgA: any = { method: 'post', url: '/shifts/aaaa-1111/approve-close', headers: {} };
    const cfgB: any = { method: 'post', url: '/shifts/bbbb-2222/approve-close', headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfgA);
    attachShiftsIdempotencyKeyIfApplicable(cfgB);
    expect(cfgA.headers['Idempotency-Key']).toBe(cfgB.headers['Idempotency-Key']);
  });

  // ── Strict pattern: out-of-scope shift state routes ──
  it('does NOT attach on POST /shifts/:id/request-close (state — out of scope)', () => {
    const cfg: any = { method: 'post', url: `/shifts/${SHIFT_ID}/request-close`, headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /shifts/:id/reject-close (state — out of scope)', () => {
    const cfg: any = { method: 'post', url: `/shifts/${SHIFT_ID}/reject-close`, headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /shifts/open (state)', () => {
    const cfg: any = { method: 'post', url: '/shifts/open', headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /shifts/reports/* (read-only aggregates)', () => {
    for (const url of [
      '/shifts/reports/list-live-summary',
      '/shifts/reports/aggregate-detail',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachShiftsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on GETs for any /shifts/* path', () => {
    for (const url of [
      '/shifts',
      '/shifts/current',
      `/shifts/${SHIFT_ID}`,
      `/shifts/${SHIFT_ID}/summary`,
      `/shifts/${SHIFT_ID}/adjustments`,
      '/shifts/pending-close',
      `/shifts/${SHIFT_ID}/close`,        // GET on same path — no match
      `/shifts/${SHIFT_ID}/approve-close`,
      `/shifts/${SHIFT_ID}/adjust-count`,
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachShiftsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PATCH/PUT/DELETE on the three target patterns', () => {
    for (const method of ['patch', 'put', 'delete']) {
      for (const url of [
        `/shifts/${SHIFT_ID}/close`,
        `/shifts/${SHIFT_ID}/approve-close`,
        `/shifts/${SHIFT_ID}/adjust-count`,
      ]) {
        const cfg: any = { method, url, headers: {} };
        attachShiftsIdempotencyKeyIfApplicable(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Suffix attacks
      `/shifts/${SHIFT_ID}/close/anything-else`,
      `/shifts/${SHIFT_ID}/approve-close/abc`,
      `/shifts/${SHIFT_ID}/adjust-count/xyz`,
      // Wrong action segment
      `/shifts/${SHIFT_ID}/void`,
      `/shifts/${SHIFT_ID}/reopen`,
      `/shifts/${SHIFT_ID}/summary`,
      // Plural/singular trap
      `/shift/${SHIFT_ID}/close`,
      // Adjacent collections
      '/shifts/pending-close',
      // Cross-controller siblings
      '/pos/invoices',
      '/cash-desk/transfer',
      `/reservations/${SHIFT_ID}/cancel`,
      `/returns/${SHIFT_ID}/refund`,
      '/attendance/admin/pay-wage',
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachShiftsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key in 3 casing variants', () => {
    const cfg1: any = {
      method: 'post', url: `/shifts/${SHIFT_ID}/close`,
      headers: { 'Idempotency-Key': 'caller-supplied-close-1234' },
    };
    attachShiftsIdempotencyKeyIfApplicable(cfg1);
    expect(cfg1.headers['Idempotency-Key']).toBe('caller-supplied-close-1234');

    const cfg2: any = {
      method: 'post', url: `/shifts/${SHIFT_ID}/approve-close`,
      headers: { 'idempotency-key': 'caller-supplied-approve-1234' },
    };
    attachShiftsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['idempotency-key']).toBe('caller-supplied-approve-1234');
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();

    const cfg3: any = {
      method: 'post', url: `/shifts/${SHIFT_ID}/adjust-count`,
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-adjust-1234' },
    };
    attachShiftsIdempotencyKeyIfApplicable(cfg3);
    expect(cfg3.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-adjust-1234');
    expect(cfg3.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: `/shifts/${SHIFT_ID}/close`, headers: {} };
    attachShiftsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

// ── Cross-route isolation against the 10 sibling helpers ──────────────
describe('cross-route isolation — shifts helper vs the 10 sibling helpers', () => {
  it('shifts helper does NOT attach to other controllers', () => {
    for (const url of [
      '/pos/invoices',
      `/pos/invoices/${SHIFT_ID}/void`,
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/supplier-payments',
      `/reservations/${SHIFT_ID}/cancel`,
      `/returns/${SHIFT_ID}/refund`,
      '/exchanges',
      '/accounting/expenses',
      '/attendance/admin/pay-wage',
      `/employees/${SHIFT_ID}/bonuses`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachShiftsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the 10 sibling helpers do NOT attach to any of the 3 shift routes', () => {
    const fns = [
      attachCheckoutIdempotencyKeyIfApplicable,
      attachTransferIdempotencyKeyIfApplicable,
      attachCustomerPaymentIdempotencyKeyIfApplicable,
      attachSupplierPaymentIdempotencyKeyIfApplicable,
      attachCashDeskDepositIdempotencyKeyIfApplicable,
      attachReservationIdempotencyKeyIfApplicable,
      attachReturnsIdempotencyKeyIfApplicable,
      attachPosInvoiceIdempotencyKeyIfApplicable,
      attachPayrollIdempotencyKeyIfApplicable,
    ];
    for (const url of [
      `/shifts/${SHIFT_ID}/close`,
      `/shifts/${SHIFT_ID}/approve-close`,
      `/shifts/${SHIFT_ID}/adjust-count`,
    ]) {
      for (const fn of fns) {
        const cfg: any = { method: 'post', url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('running ALL eleven helpers in sequence on /shifts/:id/close uses close key only', () => {
    const cfg: any = { method: 'post', url: `/shifts/${SHIFT_ID}/close`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    attachShiftsIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreateShiftsCloseIdempotencyKey());
  });

  it('running ALL eleven helpers on /shifts/:id/approve-close uses approve-close key only', () => {
    const cfg: any = { method: 'post', url: `/shifts/${SHIFT_ID}/approve-close`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    attachShiftsIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreateShiftsApproveCloseIdempotencyKey());
  });
});
