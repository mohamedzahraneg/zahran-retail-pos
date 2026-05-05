/**
 * supplier-payment-idempotency.spec.ts
 * — PR-AUDIT-IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS-FE
 *
 * Pins the FE half of the opt-in idempotency contract for the
 * supplier-payment route shipped in PR #283:
 *
 *   · POST /cash-desk/supplier-payments
 *
 * Plus the defensive-future-proof allocation-array canonicalization
 * (sort by invoice_id ascending) implemented in `cashDeskApi.pay`.
 * The current SupplierPayModal does NOT send allocations today, but
 * the helper is in place so a future allocations-supporting UI gets
 * the correct request-payload canonicalization automatically.
 *
 * Behavior pinned (in 4 describe blocks):
 *
 *   1. Module key lifecycle (3 tests).
 *   2. Helper request-shape gate (12 tests).
 *   3. Cross-helper isolation across all FIVE helpers (4 tests).
 *   4. cashDeskApi.pay payload canonicalization (5 tests):
 *      sorts by invoice_id; stable under reorder; undefined
 *      untouched; empty array preserved; does not mutate input.
 *
 * Total: 24 tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateSupplierPaymentIdempotencyKey,
  resetSupplierPaymentIdempotencyKey,
  attachSupplierPaymentIdempotencyKeyIfApplicable,
  _resetSupplierPaymentIdempotencyKeyForTests,
} from './supplier-payment-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';
import {
  attachTransferIdempotencyKeyIfApplicable,
  _resetTransferIdempotencyKeyForTests,
} from './transfer-idempotency';
import {
  attachExpenseIdempotencyKeyIfApplicable,
  _resetExpenseIdempotencyKeyForTests,
} from './expense-idempotency';
import {
  attachCustomerPaymentIdempotencyKeyIfApplicable,
  _resetCustomerPaymentIdempotencyKeyForTests,
} from './customer-payment-idempotency';
import { canonicalizePayPayload } from '@/api/cash-desk.api';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

beforeEach(() => {
  _resetSupplierPaymentIdempotencyKeyForTests();
  _resetCustomerPaymentIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetTransferIdempotencyKeyForTests();
  _resetExpenseIdempotencyKeyForTests();
});

// ─── 1. Module key lifecycle ──────────────────────────────────────────
describe('supplier-payment idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same key on repeated calls within one intent', () => {
    const a = getOrCreateSupplierPaymentIdempotencyKey();
    const b = getOrCreateSupplierPaymentIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW key', () => {
    const a = getOrCreateSupplierPaymentIdempotencyKey();
    resetSupplierPaymentIdempotencyKey();
    const b = getOrCreateSupplierPaymentIdempotencyKey();
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
      _resetSupplierPaymentIdempotencyKeyForTests();
      const k = getOrCreateSupplierPaymentIdempotencyKey();
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

// ─── 2. Helper request-shape gate ─────────────────────────────────────
describe('attachSupplierPaymentIdempotencyKeyIfApplicable — request shape gate', () => {
  it('attaches the header on POST /cash-desk/supplier-payments', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/supplier-payments',
      headers: {},
    };
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('sends the SAME key on a second POST in the same modal intent', () => {
    const c1: any = { method: 'post', url: '/cash-desk/supplier-payments', headers: {} };
    const c2: any = { method: 'post', url: '/cash-desk/supplier-payments', headers: {} };
    attachSupplierPaymentIdempotencyKeyIfApplicable(c1);
    attachSupplierPaymentIdempotencyKeyIfApplicable(c2);
    expect(c1.headers['Idempotency-Key']).toBeDefined();
    expect(c1.headers['Idempotency-Key']).toBe(c2.headers['Idempotency-Key']);
  });

  it('after reset, the next POST uses a NEW key (simulates SupplierPayModal mount cycle)', () => {
    const c1: any = { method: 'post', url: '/cash-desk/supplier-payments', headers: {} };
    attachSupplierPaymentIdempotencyKeyIfApplicable(c1);
    const k1 = c1.headers['Idempotency-Key'];
    resetSupplierPaymentIdempotencyKey();
    const c2: any = { method: 'post', url: '/cash-desk/supplier-payments', headers: {} };
    attachSupplierPaymentIdempotencyKeyIfApplicable(c2);
    expect(c2.headers['Idempotency-Key']).toBeDefined();
    expect(c2.headers['Idempotency-Key']).not.toBe(k1);
  });

  it('does NOT attach the header on GETs (any GET)', () => {
    for (const url of [
      '/cash-desk/supplier-payments',
      '/cash-desk/cashboxes',
      '/suppliers',
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on /cash-desk/supplier-payments/anything-else', () => {
    for (const url of [
      '/cash-desk/supplier-payments/anything-else',
      '/cash-desk/supplier-payments/abc-id',
      '/cash-desk/supplier-payments-extra',
      '/cash-desk/supplier-paymentsfoo',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on /cash-desk/supplier-payments/:id/void', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/supplier-payments/abc-id/void',
      headers: {},
    };
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on /cash-desk/customer-payments', () => {
    for (const url of [
      '/cash-desk/customer-payments',
      '/cash-desk/customer-payments/abc-id/void',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on other cash-desk POST routes', () => {
    for (const url of [
      '/cash-desk/cashboxes',
      '/cash-desk/cashboxes/abc-id',
      '/cash-desk/cashboxes/abc-id/delete',
      '/cash-desk/deposit',
      '/cash-desk/transfer',
      '/cash-desk/reconciliation/mark',
      '/cash-desk/reconciliation/unmark',
      '/cash-desk/reconciliation/auto-match',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on /pos/invoices, /accounting/expenses, /accounting/expenses/daily', () => {
    for (const url of [
      '/pos/invoices',
      '/accounting/expenses',
      '/accounting/expenses/daily',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on /sync/push', () => {
    const cfg: any = { method: 'post', url: '/sync/push', headers: {} };
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on /suppliers/:id/pay (different controller)', () => {
    for (const url of [
      '/suppliers/abc-id/pay',
      '/suppliers/abc-id',
      '/suppliers',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key (any casing)', () => {
    const c1: any = {
      method: 'post',
      url: '/cash-desk/supplier-payments',
      headers: { 'Idempotency-Key': 'caller-supplied-sp-1234' },
    };
    attachSupplierPaymentIdempotencyKeyIfApplicable(c1);
    expect(c1.headers['Idempotency-Key']).toBe('caller-supplied-sp-1234');

    const c2: any = {
      method: 'post',
      url: '/cash-desk/supplier-payments',
      headers: { 'idempotency-key': 'caller-supplied-sp-lower-1234' },
    };
    attachSupplierPaymentIdempotencyKeyIfApplicable(c2);
    expect(c2.headers['idempotency-key']).toBe(
      'caller-supplied-sp-lower-1234',
    );
    expect(c2.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = {
      method: 'POST',
      url: '/cash-desk/supplier-payments',
      headers: {},
    };
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

// ─── 3. Cross-helper isolation across all FIVE helpers ────────────────
describe('cross-helper isolation — checkout × transfer × expense × customer-payment × supplier-payment', () => {
  it('supplier-payment helper does NOT attach to /pos/invoices, /cash-desk/transfer, expense routes, /cash-desk/customer-payments', () => {
    for (const url of [
      '/pos/invoices',
      '/cash-desk/transfer',
      '/accounting/expenses',
      '/accounting/expenses/daily',
      '/cash-desk/customer-payments',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the four sibling helpers do NOT attach to /cash-desk/supplier-payments', () => {
    for (const attach of [
      attachCheckoutIdempotencyKeyIfApplicable,
      attachTransferIdempotencyKeyIfApplicable,
      attachExpenseIdempotencyKeyIfApplicable,
      attachCustomerPaymentIdempotencyKeyIfApplicable,
    ]) {
      const cfg: any = {
        method: 'post',
        url: '/cash-desk/supplier-payments',
        headers: {},
      };
      attach(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('running ALL five helpers on /cash-desk/supplier-payments → only supplier-payment key wins', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/supplier-payments',
      headers: {},
    };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeDefined();
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateSupplierPaymentIdempotencyKey(),
    );
  });

  it('running ALL five helpers on /cash-desk/customer-payments → supplier-payment helper is no-op', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/customer-payments',
      headers: {},
    };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    attachSupplierPaymentIdempotencyKeyIfApplicable(cfg);
    const onWireKey = cfg.headers['Idempotency-Key'];
    expect(onWireKey).toBeDefined();
    // The supplier-payment module's standalone key MUST be different
    // from the on-wire key (proves the supplier-payment helper did
    // not overwrite — its URL gate refused).
    expect(onWireKey).not.toBe(getOrCreateSupplierPaymentIdempotencyKey());
  });
});

// ─── 4. canonicalizePayPayload — defensive future-proof allocation sort ─
describe('cashDeskApi.pay payload canonicalization (canonicalizePayPayload)', () => {
  const sampleAlloc = (id: string, amt: number) => ({
    invoice_id: id,
    amount: amt,
  });

  it('sorts allocations by invoice_id ascending (when allocations are present)', () => {
    const out = canonicalizePayPayload({
      supplier_id: 's-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 1500,
      allocations: [
        sampleAlloc('cccc', 300),
        sampleAlloc('aaaa', 900),
        sampleAlloc('bbbb', 300),
      ],
    });
    expect(out.allocations).toEqual([
      sampleAlloc('aaaa', 900),
      sampleAlloc('bbbb', 300),
      sampleAlloc('cccc', 300),
    ]);
  });

  it('produces identical output regardless of input order (idempotent under reorder)', () => {
    const a = canonicalizePayPayload({
      supplier_id: 's-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 1500,
      allocations: [sampleAlloc('aaaa', 900), sampleAlloc('bbbb', 600)],
    });
    const b = canonicalizePayPayload({
      supplier_id: 's-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 1500,
      allocations: [sampleAlloc('bbbb', 600), sampleAlloc('aaaa', 900)],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('leaves undefined allocations untouched (current SupplierPayModal flat-payload path)', () => {
    const out = canonicalizePayPayload({
      supplier_id: 's-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 1500,
      // allocations omitted entirely — this is what SupplierPayModal
      // sends today. The helper is a defensive future-proof step;
      // when allocations are absent, the payload passes through.
    });
    expect(out.allocations).toBeUndefined();
  });

  it('preserves an empty allocations array as []', () => {
    const out = canonicalizePayPayload({
      supplier_id: 's-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 1500,
      allocations: [],
    });
    expect(out.allocations).toEqual([]);
  });

  it('does NOT mutate the input payload object', () => {
    const input = {
      supplier_id: 's-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash' as const,
      amount: 1500,
      allocations: [sampleAlloc('cccc', 300), sampleAlloc('aaaa', 300)],
    };
    const inputAllocSnapshot = [...input.allocations];
    canonicalizePayPayload(input);
    // Original array order preserved (modal UI display order would
    // be unaffected if a future UI ever surfaces allocations;
    // sorting is request-payload-only).
    expect(input.allocations).toEqual(inputAllocSnapshot);
  });
});
