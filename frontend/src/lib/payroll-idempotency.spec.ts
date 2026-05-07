/**
 * payroll-idempotency.spec.ts — PR-FE-IDEM-PAYROLL-FAMILY
 *   (Sprint 5 / FE-IDEM PR 6)
 *
 * Pins the FE half of the opt-in idempotency contract for seven
 * payroll/employee financial routes already protected backend-side:
 *
 *   · POST /attendance/admin/approve-wage/:attendance_id  (BE: PR #312)
 *   · POST /attendance/admin/void-accrual/:payable_day_id (BE: PR #311)
 *   · POST /attendance/admin/approve-wage-override        (BE: PR #312)
 *   · POST /attendance/admin/pay-wage                     (BE: PR #312)
 *   · POST /employees/:id/bonuses                         (BE: PR #309)
 *   · POST /employees/:id/deductions                      (BE: PR #309)
 *   · POST /employees/:id/settlements                     (BE: PR #309)
 *
 *   1. One Idempotency-Key per ACTION TYPE — the seven keys are
 *      isolated.
 *   2. Same key reused on retry within one open modal session OR
 *      within one row-click.
 *   3. Reset only when the matching `reset*()` is called.
 *   4. Header is attached only to the seven exact patterns — not
 *      to attendance state routes (clock-in/out, mark-payable-day,
 *      admin/clock-*, PATCH /attendance/:id), not to employee
 *      request flows (me/requests, requests/:id/decide, me/tasks,
 *      tasks/*), not to GETs.
 *   5. A caller-provided Idempotency-Key (any casing) is preserved.
 *   6. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *
 * Cross-route isolation: this helper MUST not cross-fire with the
 * nine sibling helpers (checkout, transfer, expense,
 * customer-payment, supplier-payment, cash-desk-deposit,
 * reservation, returns, pos-invoice). Pinned in the final block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreatePayrollApproveWageIdempotencyKey,
  resetPayrollApproveWageIdempotencyKey,
  _resetPayrollApproveWageIdempotencyKeyForTests,
  getOrCreatePayrollVoidAccrualIdempotencyKey,
  resetPayrollVoidAccrualIdempotencyKey,
  _resetPayrollVoidAccrualIdempotencyKeyForTests,
  getOrCreatePayrollApproveWageOverrideIdempotencyKey,
  resetPayrollApproveWageOverrideIdempotencyKey,
  _resetPayrollApproveWageOverrideIdempotencyKeyForTests,
  getOrCreatePayrollPayWageIdempotencyKey,
  resetPayrollPayWageIdempotencyKey,
  _resetPayrollPayWageIdempotencyKeyForTests,
  getOrCreatePayrollBonusIdempotencyKey,
  resetPayrollBonusIdempotencyKey,
  _resetPayrollBonusIdempotencyKeyForTests,
  getOrCreatePayrollDeductionIdempotencyKey,
  resetPayrollDeductionIdempotencyKey,
  _resetPayrollDeductionIdempotencyKeyForTests,
  getOrCreatePayrollSettlementIdempotencyKey,
  resetPayrollSettlementIdempotencyKey,
  _resetPayrollSettlementIdempotencyKeyForTests,
  attachPayrollIdempotencyKeyIfApplicable,
} from './payroll-idempotency';
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

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ATT_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const PAYABLE_ID = 'pppp1111-qqqq-2222-rrrr-333344445555';
const EMP_ID = 'eeee1111-ffff-2222-aaaa-333344445555';

beforeEach(() => {
  _resetPayrollApproveWageIdempotencyKeyForTests();
  _resetPayrollVoidAccrualIdempotencyKeyForTests();
  _resetPayrollApproveWageOverrideIdempotencyKeyForTests();
  _resetPayrollPayWageIdempotencyKeyForTests();
  _resetPayrollBonusIdempotencyKeyForTests();
  _resetPayrollDeductionIdempotencyKeyForTests();
  _resetPayrollSettlementIdempotencyKeyForTests();
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
});

// ── Per-action key lifecycle ─────────────────────────────────────────
describe('payroll idempotency module — key lifecycle', () => {
  const cases: Array<[string, () => string, () => void]> = [
    ['approve-wage', getOrCreatePayrollApproveWageIdempotencyKey, resetPayrollApproveWageIdempotencyKey],
    ['void-accrual', getOrCreatePayrollVoidAccrualIdempotencyKey, resetPayrollVoidAccrualIdempotencyKey],
    ['approve-wage-override', getOrCreatePayrollApproveWageOverrideIdempotencyKey, resetPayrollApproveWageOverrideIdempotencyKey],
    ['pay-wage', getOrCreatePayrollPayWageIdempotencyKey, resetPayrollPayWageIdempotencyKey],
    ['bonus', getOrCreatePayrollBonusIdempotencyKey, resetPayrollBonusIdempotencyKey],
    ['deduction', getOrCreatePayrollDeductionIdempotencyKey, resetPayrollDeductionIdempotencyKey],
    ['settlement', getOrCreatePayrollSettlementIdempotencyKey, resetPayrollSettlementIdempotencyKey],
  ];
  it.each(cases)('%s: getOrCreate caches; reset mints fresh; matches BE_PATTERN', (_, get, reset) => {
    const a = get();
    expect(get()).toBe(a);
    expect(a).toMatch(BE_PATTERN);
    reset();
    expect(get()).not.toBe(a);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable (approve-wage path)', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetPayrollApproveWageIdempotencyKeyForTests();
      const k = getOrCreatePayrollApproveWageIdempotencyKey();
      expect(k).toMatch(BE_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

// ── Inter-action isolation ────────────────────────────────────────────
describe('inter-action isolation — seven keys are independent', () => {
  it('all seven keys are distinct from each other', () => {
    const a = getOrCreatePayrollApproveWageIdempotencyKey();
    const v = getOrCreatePayrollVoidAccrualIdempotencyKey();
    const o = getOrCreatePayrollApproveWageOverrideIdempotencyKey();
    const p = getOrCreatePayrollPayWageIdempotencyKey();
    const b = getOrCreatePayrollBonusIdempotencyKey();
    const d = getOrCreatePayrollDeductionIdempotencyKey();
    const s = getOrCreatePayrollSettlementIdempotencyKey();
    expect(new Set([a, v, o, p, b, d, s]).size).toBe(7);
  });

  it('reset on bonus does NOT affect any of the other 6 keys', () => {
    const a = getOrCreatePayrollApproveWageIdempotencyKey();
    const v = getOrCreatePayrollVoidAccrualIdempotencyKey();
    const o = getOrCreatePayrollApproveWageOverrideIdempotencyKey();
    const p = getOrCreatePayrollPayWageIdempotencyKey();
    getOrCreatePayrollBonusIdempotencyKey();
    const d = getOrCreatePayrollDeductionIdempotencyKey();
    const s = getOrCreatePayrollSettlementIdempotencyKey();
    resetPayrollBonusIdempotencyKey();
    expect(getOrCreatePayrollApproveWageIdempotencyKey()).toBe(a);
    expect(getOrCreatePayrollVoidAccrualIdempotencyKey()).toBe(v);
    expect(getOrCreatePayrollApproveWageOverrideIdempotencyKey()).toBe(o);
    expect(getOrCreatePayrollPayWageIdempotencyKey()).toBe(p);
    expect(getOrCreatePayrollDeductionIdempotencyKey()).toBe(d);
    expect(getOrCreatePayrollSettlementIdempotencyKey()).toBe(s);
  });

  it('reset on pay-wage does NOT affect any of the other 6 keys', () => {
    const a = getOrCreatePayrollApproveWageIdempotencyKey();
    const v = getOrCreatePayrollVoidAccrualIdempotencyKey();
    const o = getOrCreatePayrollApproveWageOverrideIdempotencyKey();
    getOrCreatePayrollPayWageIdempotencyKey();
    const b = getOrCreatePayrollBonusIdempotencyKey();
    const d = getOrCreatePayrollDeductionIdempotencyKey();
    const s = getOrCreatePayrollSettlementIdempotencyKey();
    resetPayrollPayWageIdempotencyKey();
    expect(getOrCreatePayrollApproveWageIdempotencyKey()).toBe(a);
    expect(getOrCreatePayrollVoidAccrualIdempotencyKey()).toBe(v);
    expect(getOrCreatePayrollApproveWageOverrideIdempotencyKey()).toBe(o);
    expect(getOrCreatePayrollBonusIdempotencyKey()).toBe(b);
    expect(getOrCreatePayrollDeductionIdempotencyKey()).toBe(d);
    expect(getOrCreatePayrollSettlementIdempotencyKey()).toBe(s);
  });
});

// ── URL gate — POST + exact pattern matches ───────────────────────────
describe('attachPayrollIdempotencyKeyIfApplicable — URL gate', () => {
  const routeCases: Array<[string, string, () => string]> = [
    ['approve-wage',           `/attendance/admin/approve-wage/${ATT_ID}`,         getOrCreatePayrollApproveWageIdempotencyKey],
    ['void-accrual',           `/attendance/admin/void-accrual/${PAYABLE_ID}`,     getOrCreatePayrollVoidAccrualIdempotencyKey],
    ['approve-wage-override',  `/attendance/admin/approve-wage-override`,          getOrCreatePayrollApproveWageOverrideIdempotencyKey],
    ['pay-wage',               `/attendance/admin/pay-wage`,                       getOrCreatePayrollPayWageIdempotencyKey],
    ['bonuses',                `/employees/${EMP_ID}/bonuses`,                     getOrCreatePayrollBonusIdempotencyKey],
    ['deductions',             `/employees/${EMP_ID}/deductions`,                  getOrCreatePayrollDeductionIdempotencyKey],
    ['settlements',            `/employees/${EMP_ID}/settlements`,                 getOrCreatePayrollSettlementIdempotencyKey],
  ];
  it.each(routeCases)('POST %s attaches the correct key', (_, url, getter) => {
    const cfg: any = { method: 'post', url, headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(getter());
  });

  it('SAME pay-wage key on second POST for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: '/attendance/admin/pay-wage', headers: {} };
    const cfg2: any = { method: 'post', url: '/attendance/admin/pay-wage', headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfg1);
    attachPayrollIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST pay-wage uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: '/attendance/admin/pay-wage', headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetPayrollPayWageIdempotencyKey();
    const cfg2: any = { method: 'post', url: '/attendance/admin/pay-wage', headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  it('different employee_ids on bonuses route SHARE the bonus key (intent boundary is the modal/click)', () => {
    const cfgA: any = { method: 'post', url: `/employees/aaaa-1111/bonuses`, headers: {} };
    const cfgB: any = { method: 'post', url: `/employees/bbbb-2222/bonuses`, headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfgA);
    attachPayrollIdempotencyKeyIfApplicable(cfgB);
    expect(cfgA.headers['Idempotency-Key']).toBe(cfgB.headers['Idempotency-Key']);
  });

  // ── Strict pattern: out-of-scope attendance + employee state routes ──
  it('does NOT attach on out-of-scope attendance state routes', () => {
    for (const url of [
      '/attendance/clock-in',
      '/attendance/clock-out',
      '/attendance/admin/clock-in',
      '/attendance/admin/clock-out',
      '/attendance/admin/mark-payable-day',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachPayrollIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PATCH /attendance/:id (admin edit, state-only)', () => {
    const cfg: any = { method: 'patch', url: `/attendance/${ATT_ID}`, headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on out-of-scope employee request/task routes', () => {
    for (const url of [
      '/employees/me/requests',
      '/employees/me/requests/advance',
      `/employees/requests/${EMP_ID}/decide`,
      `/employees/me/tasks/${EMP_ID}/acknowledge`,
      `/employees/me/tasks/${EMP_ID}/complete`,
      '/employees/tasks',
      `/employees/tasks/${EMP_ID}/cancel`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachPayrollIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PATCH /employees/:id/profile', () => {
    const cfg: any = { method: 'patch', url: `/employees/${EMP_ID}/profile`, headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on GETs for any /attendance/* or /employees/* path', () => {
    for (const url of [
      '/attendance',
      `/attendance/${ATT_ID}`,
      '/attendance/admin/payable-days',
      `/employees/${EMP_ID}`,
      `/employees/${EMP_ID}/bonuses`,
      `/employees/${EMP_ID}/dashboard`,
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachPayrollIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PATCH/PUT/DELETE on the seven target patterns', () => {
    for (const method of ['patch', 'put', 'delete']) {
      for (const url of [
        `/attendance/admin/approve-wage/${ATT_ID}`,
        `/attendance/admin/void-accrual/${PAYABLE_ID}`,
        '/attendance/admin/approve-wage-override',
        '/attendance/admin/pay-wage',
        `/employees/${EMP_ID}/bonuses`,
        `/employees/${EMP_ID}/deductions`,
        `/employees/${EMP_ID}/settlements`,
      ]) {
        const cfg: any = { method, url, headers: {} };
        attachPayrollIdempotencyKeyIfApplicable(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Suffix attacks
      `/attendance/admin/approve-wage/${ATT_ID}/anything-else`,
      `/attendance/admin/void-accrual/${PAYABLE_ID}/abc`,
      '/attendance/admin/approve-wage-override/abc',
      '/attendance/admin/pay-wage/abc',
      `/employees/${EMP_ID}/bonuses/abc`,
      // Plural/singular trap
      `/attendance/admin/approve-wages/${ATT_ID}`,
      `/employee/${EMP_ID}/bonuses`,
      // Adjacent collections
      `/employees/${EMP_ID}/profile`,
      `/employees/${EMP_ID}/ledger`,
      `/employees/${EMP_ID}/history`,
      // Cross-controller siblings
      '/pos/invoices',
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      `/reservations/${EMP_ID}/payments`,
      `/returns/${EMP_ID}/approve`,
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachPayrollIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key in 3 casing variants', () => {
    const cfg1: any = {
      method: 'post', url: '/attendance/admin/pay-wage',
      headers: { 'Idempotency-Key': 'caller-supplied-pay-1234' },
    };
    attachPayrollIdempotencyKeyIfApplicable(cfg1);
    expect(cfg1.headers['Idempotency-Key']).toBe('caller-supplied-pay-1234');

    const cfg2: any = {
      method: 'post', url: `/employees/${EMP_ID}/bonuses`,
      headers: { 'idempotency-key': 'caller-supplied-bonus-1234' },
    };
    attachPayrollIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['idempotency-key']).toBe('caller-supplied-bonus-1234');
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();

    const cfg3: any = {
      method: 'post', url: `/employees/${EMP_ID}/settlements`,
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-settlement-1234' },
    };
    attachPayrollIdempotencyKeyIfApplicable(cfg3);
    expect(cfg3.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-settlement-1234');
    expect(cfg3.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: '/attendance/admin/pay-wage', headers: {} };
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

// ── Cross-route isolation against the 9 sibling helpers ───────────────
describe('cross-route isolation — payroll helper vs the 9 sibling helpers', () => {
  it('payroll helper does NOT attach to /pos/* or /cash-desk/* or /reservations/* or /returns/*', () => {
    for (const url of [
      '/pos/invoices',
      `/pos/invoices/${EMP_ID}/void`,
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/supplier-payments',
      `/reservations/${EMP_ID}/cancel`,
      `/returns/${EMP_ID}/refund`,
      '/exchanges',
      '/accounting/expenses',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachPayrollIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the 9 sibling helpers do NOT attach to any of the 7 payroll routes', () => {
    const fns = [
      attachCheckoutIdempotencyKeyIfApplicable,
      attachTransferIdempotencyKeyIfApplicable,
      attachCustomerPaymentIdempotencyKeyIfApplicable,
      attachSupplierPaymentIdempotencyKeyIfApplicable,
      attachCashDeskDepositIdempotencyKeyIfApplicable,
      attachReservationIdempotencyKeyIfApplicable,
      attachReturnsIdempotencyKeyIfApplicable,
      attachPosInvoiceIdempotencyKeyIfApplicable,
    ];
    for (const url of [
      `/attendance/admin/approve-wage/${ATT_ID}`,
      `/attendance/admin/void-accrual/${PAYABLE_ID}`,
      '/attendance/admin/approve-wage-override',
      '/attendance/admin/pay-wage',
      `/employees/${EMP_ID}/bonuses`,
      `/employees/${EMP_ID}/deductions`,
      `/employees/${EMP_ID}/settlements`,
    ]) {
      for (const fn of fns) {
        const cfg: any = { method: 'post', url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('running ALL ten helpers in sequence on /attendance/admin/pay-wage uses pay-wage key only', () => {
    const cfg: any = { method: 'post', url: '/attendance/admin/pay-wage', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreatePayrollPayWageIdempotencyKey());
  });

  it('running ALL ten helpers on /employees/:id/bonuses uses bonus key only', () => {
    const cfg: any = { method: 'post', url: `/employees/${EMP_ID}/bonuses`, headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    attachCashDeskDepositIdempotencyKeyIfApplicable(cfg);
    attachReservationIdempotencyKeyIfApplicable(cfg);
    attachReturnsIdempotencyKeyIfApplicable(cfg);
    attachPosInvoiceIdempotencyKeyIfApplicable(cfg);
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreatePayrollBonusIdempotencyKey());
  });
});
