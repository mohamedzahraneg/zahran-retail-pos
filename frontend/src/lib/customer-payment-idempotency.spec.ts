/**
 * customer-payment-idempotency.spec.ts
 * — PR-AUDIT-IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS-FE
 *
 * Pins the FE half of the opt-in idempotency contract for the
 * customer-receipt route shipped in PR #281:
 *
 *   · POST /cash-desk/customer-payments
 *
 * Plus the allocation-array canonicalization (sort by invoice_id
 * ascending) implemented in `cashDeskApi.receive` to keep the
 * BE's payload-hash identical across legitimate retries.
 *
 * Behavior pinned (in 4 describe blocks):
 *
 *   1. Module key lifecycle (3 tests).
 *   2. Helper request-shape gate (12 tests).
 *   3. Cross-helper isolation across all four helpers (4 tests).
 *   4. cashDeskApi.receive payload canonicalization (5 tests):
 *      allocations sorted by invoice_id; undefined left as undefined;
 *      empty array preserved as empty; non-settle kinds untouched;
 *      sort is stable + deterministic.
 *
 * Total: 24 tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getOrCreateCustomerPaymentIdempotencyKey,
  resetCustomerPaymentIdempotencyKey,
  attachCustomerPaymentIdempotencyKeyIfApplicable,
  _resetCustomerPaymentIdempotencyKeyForTests,
} from './customer-payment-idempotency';
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
import { canonicalizeReceivePayload } from '@/api/cash-desk.api';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

beforeEach(() => {
  _resetCustomerPaymentIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetTransferIdempotencyKeyForTests();
  _resetExpenseIdempotencyKeyForTests();
});

// ─── 1. Module key lifecycle ──────────────────────────────────────────
describe('customer-payment idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same key on repeated calls within one intent', () => {
    const a = getOrCreateCustomerPaymentIdempotencyKey();
    const b = getOrCreateCustomerPaymentIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW key', () => {
    const a = getOrCreateCustomerPaymentIdempotencyKey();
    resetCustomerPaymentIdempotencyKey();
    const b = getOrCreateCustomerPaymentIdempotencyKey();
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
      _resetCustomerPaymentIdempotencyKeyForTests();
      const k = getOrCreateCustomerPaymentIdempotencyKey();
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
describe('attachCustomerPaymentIdempotencyKeyIfApplicable — request shape gate', () => {
  it('attaches the header on POST /cash-desk/customer-payments', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/customer-payments',
      headers: {},
    };
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('sends the SAME key on a second POST in the same modal intent', () => {
    const c1: any = { method: 'post', url: '/cash-desk/customer-payments', headers: {} };
    const c2: any = { method: 'post', url: '/cash-desk/customer-payments', headers: {} };
    attachCustomerPaymentIdempotencyKeyIfApplicable(c1);
    attachCustomerPaymentIdempotencyKeyIfApplicable(c2);
    expect(c1.headers['Idempotency-Key']).toBeDefined();
    expect(c1.headers['Idempotency-Key']).toBe(c2.headers['Idempotency-Key']);
  });

  it('after reset, the next POST uses a NEW key (simulates ReceiptModal mount cycle)', () => {
    const c1: any = { method: 'post', url: '/cash-desk/customer-payments', headers: {} };
    attachCustomerPaymentIdempotencyKeyIfApplicable(c1);
    const k1 = c1.headers['Idempotency-Key'];
    resetCustomerPaymentIdempotencyKey();
    const c2: any = { method: 'post', url: '/cash-desk/customer-payments', headers: {} };
    attachCustomerPaymentIdempotencyKeyIfApplicable(c2);
    expect(c2.headers['Idempotency-Key']).toBeDefined();
    expect(c2.headers['Idempotency-Key']).not.toBe(k1);
  });

  it('does NOT attach the header on GETs (any GET)', () => {
    for (const url of [
      '/cash-desk/customer-payments',
      '/cash-desk/cashboxes',
      '/customers',
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on /cash-desk/customer-payments/anything-else', () => {
    for (const url of [
      '/cash-desk/customer-payments/anything-else',
      '/cash-desk/customer-payments/abc-id',
      '/cash-desk/customer-payments-extra',
      '/cash-desk/customer-paymentsfoo',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on /cash-desk/customer-payments/:id/void', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/customer-payments/abc-id/void',
      headers: {},
    };
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on /cash-desk/supplier-payments', () => {
    for (const url of [
      '/cash-desk/supplier-payments',
      '/cash-desk/supplier-payments/abc-id/void',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
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
      attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
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
      attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on /sync/push', () => {
    const cfg: any = { method: 'post', url: '/sync/push', headers: {} };
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('preserves a caller-provided Idempotency-Key (any casing)', () => {
    const c1: any = {
      method: 'post',
      url: '/cash-desk/customer-payments',
      headers: { 'Idempotency-Key': 'caller-supplied-cp-1234' },
    };
    attachCustomerPaymentIdempotencyKeyIfApplicable(c1);
    expect(c1.headers['Idempotency-Key']).toBe('caller-supplied-cp-1234');

    const c2: any = {
      method: 'post',
      url: '/cash-desk/customer-payments',
      headers: { 'idempotency-key': 'caller-supplied-cp-lower-1234' },
    };
    attachCustomerPaymentIdempotencyKeyIfApplicable(c2);
    expect(c2.headers['idempotency-key']).toBe(
      'caller-supplied-cp-lower-1234',
    );
    expect(c2.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = {
      method: 'POST',
      url: '/cash-desk/customer-payments',
      headers: {},
    };
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

// ─── 3. Cross-helper isolation across all FOUR helpers ────────────────
describe('cross-helper isolation — checkout × transfer × expense × customer-payment', () => {
  it('customer-payment helper does NOT attach to /pos/invoices, /cash-desk/transfer, expense routes', () => {
    for (const url of [
      '/pos/invoices',
      '/cash-desk/transfer',
      '/accounting/expenses',
      '/accounting/expenses/daily',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the three sibling helpers do NOT attach to /cash-desk/customer-payments', () => {
    for (const attach of [
      attachCheckoutIdempotencyKeyIfApplicable,
      attachTransferIdempotencyKeyIfApplicable,
      attachExpenseIdempotencyKeyIfApplicable,
    ]) {
      const cfg: any = {
        method: 'post',
        url: '/cash-desk/customer-payments',
        headers: {},
      };
      attach(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('running ALL four helpers on /cash-desk/customer-payments → only customer-payment key wins', () => {
    const cfg: any = {
      method: 'post',
      url: '/cash-desk/customer-payments',
      headers: {},
    };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeDefined();
    // The header on the wire equals the customer-payment module's
    // current key — proves the customer-payment helper fired and the
    // other three did not overwrite.
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateCustomerPaymentIdempotencyKey(),
    );
  });

  it('running ALL four helpers on /pos/invoices → only checkout key wins (customer-payment helper is no-op)', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    attachCustomerPaymentIdempotencyKeyIfApplicable(cfg);
    const onWireKey = cfg.headers['Idempotency-Key'];
    expect(onWireKey).toBeDefined();
    // Customer-payment module's standalone key must be DIFFERENT
    // from the on-wire key (proves the customer-payment helper did
    // not overwrite — its URL gate refused).
    expect(onWireKey).not.toBe(getOrCreateCustomerPaymentIdempotencyKey());
  });
});

// ─── 4. canonicalizeReceivePayload — allocation-array canonicalization ─
describe('cashDeskApi.receive payload canonicalization (canonicalizeReceivePayload)', () => {
  const sampleAlloc = (id: string, amt: number) => ({
    invoice_id: id,
    amount: amt,
  });

  it('sorts allocations by invoice_id ascending', () => {
    const out = canonicalizeReceivePayload({
      customer_id: 'c-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 500,
      kind: 'settle_invoices',
      allocations: [
        sampleAlloc('cccc', 100),
        sampleAlloc('aaaa', 300),
        sampleAlloc('bbbb', 100),
      ],
    });
    expect(out.allocations).toEqual([
      sampleAlloc('aaaa', 300),
      sampleAlloc('bbbb', 100),
      sampleAlloc('cccc', 100),
    ]);
  });

  it('produces identical output regardless of input order (idempotent under reorder)', () => {
    const a = canonicalizeReceivePayload({
      customer_id: 'c-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 500,
      kind: 'settle_invoices',
      allocations: [sampleAlloc('aaaa', 300), sampleAlloc('bbbb', 200)],
    });
    const b = canonicalizeReceivePayload({
      customer_id: 'c-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 500,
      kind: 'settle_invoices',
      allocations: [sampleAlloc('bbbb', 200), sampleAlloc('aaaa', 300)],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('leaves undefined allocations untouched (refund / deposit kinds)', () => {
    const out = canonicalizeReceivePayload({
      customer_id: 'c-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 500,
      kind: 'deposit',
      // allocations omitted entirely
    });
    expect(out.allocations).toBeUndefined();
  });

  it('preserves an empty allocations array as []', () => {
    const out = canonicalizeReceivePayload({
      customer_id: 'c-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 500,
      kind: 'settle_invoices',
      allocations: [],
    });
    expect(out.allocations).toEqual([]);
  });

  it('does NOT mutate the input payload object', () => {
    const input = {
      customer_id: 'c-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash' as const,
      amount: 500,
      kind: 'settle_invoices' as const,
      allocations: [sampleAlloc('cccc', 100), sampleAlloc('aaaa', 100)],
    };
    const inputAllocSnapshot = [...input.allocations];
    canonicalizeReceivePayload(input);
    // Original array order is preserved (modal UI reflects insertion
    // order; sorting is request-payload-only).
    expect(input.allocations).toEqual(inputAllocSnapshot);
  });
});
