/**
 * posSplitPayment.test.ts — PR-POS-PAY-1
 *
 * Pure helper tests for the POS split-payment validation + summary
 * logic. No DOM, no providers, no cart store — these guard the
 * accounting invariants the UI must enforce.
 *
 * Covered scenarios (mapped to the user's required test list):
 *   1. single payment still works                   → backwardCompat
 *   2. add second payment row sums correctly         → multiRowSum
 *   3. sum paid equals total enables confirm         → fullyPaid_ok
 *   4. overpay blocked (non-cash overage)            → nonCashOverage_blocked
 *   5. cash overpayment becomes change               → cashOverpay_change
 *   6. zero/negative payment row blocked             → zeroAmount_blocked / negative_blocked
 *   7. non-cash without account blocked when required → missingAccount_blocked
 *   8. payload contains multiple payment entries     → rowsToPaymentDrafts shape
 *
 * Plus partial-pay (آجل / credit sale) acceptance.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSplitPayments,
  summarizeSplitPayments,
  rowsToPaymentDrafts,
  makeRowUid,
  type SplitPaymentRow,
} from '../posSplitPayment';

const accountAlwaysRequired = () => true;
const accountNeverRequired = () => false;

const cashRow = (amount: number): SplitPaymentRow => ({
  uid: makeRowUid(),
  method: 'cash',
  amount,
  payment_account_id: null,
});

const instapayRow = (amount: number, accountId: string | null): SplitPaymentRow => ({
  uid: makeRowUid(),
  method: 'instapay',
  amount,
  payment_account_id: accountId,
  account_display_name: accountId ? 'InstaPay الأهلي' : null,
});

describe('validateSplitPayments — PR-POS-PAY-1', () => {
  it('rejects an empty rows array', () => {
    const r = validateSplitPayments([], 100, {
      isAccountRequired: accountNeverRequired,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/أضف وسيلة دفع/);
  });

  it('accepts a single cash row equal to grand total (legacy single-payment)', () => {
    const r = validateSplitPayments([cashRow(1000)], 1000, {
      isAccountRequired: accountAlwaysRequired,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('accepts split: 600 cash + 400 instapay = 1000 total', () => {
    const rows = [cashRow(600), instapayRow(400, 'acct-1')];
    const r = validateSplitPayments(rows, 1000, {
      isAccountRequired: accountAlwaysRequired,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a row with amount=0', () => {
    const r = validateSplitPayments([cashRow(0)], 100, {
      isAccountRequired: accountNeverRequired,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/المبلغ يجب أن يكون أكبر من صفر/);
  });

  it('rejects a row with negative amount', () => {
    const r = validateSplitPayments([cashRow(-50)], 100, {
      isAccountRequired: accountNeverRequired,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/أكبر من صفر/);
  });

  it('rejects NaN amounts', () => {
    const r = validateSplitPayments([cashRow(NaN)], 100, {
      isAccountRequired: accountNeverRequired,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-cash without payment_account_id when required', () => {
    const rows = [instapayRow(400, null)];
    const r = validateSplitPayments(rows, 400, {
      isAccountRequired: accountAlwaysRequired,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/تحتاج اختيار حساب الدفع/);
  });

  it('accepts non-cash without account when account is NOT required (e.g. method has no accounts catalogued)', () => {
    const rows = [instapayRow(400, null)];
    const r = validateSplitPayments(rows, 400, {
      isAccountRequired: accountNeverRequired,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when non-cash overage exceeds grand total + epsilon', () => {
    // 700 instapay on a 600 invoice — can\'t refund a card swipe via cash.
    const rows = [instapayRow(700, 'acct-1')];
    const r = validateSplitPayments(rows, 600, {
      isAccountRequired: accountAlwaysRequired,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/المدفوعات غير النقدية أكبر من إجمالي الفاتورة/);
  });

  it('accepts cash overage (the surplus is change to return)', () => {
    // 1500 cash on a 1000 invoice — change = 500.
    const rows = [cashRow(1500)];
    const r = validateSplitPayments(rows, 1000, {
      isAccountRequired: accountAlwaysRequired,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts partial pay (remaining > 0 → آجل)', () => {
    // 600 cash on a 1000 invoice — remaining 400 is credit / آجل.
    const rows = [cashRow(600)];
    const r = validateSplitPayments(rows, 1000, {
      isAccountRequired: accountAlwaysRequired,
    });
    expect(r.ok).toBe(true);
  });

  it('tolerates 1-cent rounding when validating non-cash overage', () => {
    const rows = [instapayRow(1000.005, 'acct-1')];
    const r = validateSplitPayments(rows, 1000, {
      isAccountRequired: accountAlwaysRequired,
    });
    expect(r.ok).toBe(true);
  });

  it('reports the FIRST violating row in the reason text', () => {
    const rows = [cashRow(100), cashRow(0), cashRow(200)];
    const r = validateSplitPayments(rows, 300, {
      isAccountRequired: accountNeverRequired,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/سطر #2/); // 1-based indexing
  });
});

describe('summarizeSplitPayments — PR-POS-PAY-1', () => {
  it('zero rows → all zeros', () => {
    const s = summarizeSplitPayments([], 100);
    expect(s).toEqual({
      totalPaid: 0,
      cashPaid: 0,
      nonCashPaid: 0,
      remaining: 100,
      change: 0,
      isFullyPaid: false,
      hasOverage: false,
    });
  });

  it('600 cash + 400 instapay on 1000 → fully paid, no change', () => {
    const rows = [cashRow(600), instapayRow(400, 'acct-1')];
    const s = summarizeSplitPayments(rows, 1000);
    expect(s.totalPaid).toBe(1000);
    expect(s.cashPaid).toBe(600);
    expect(s.nonCashPaid).toBe(400);
    expect(s.remaining).toBe(0);
    expect(s.change).toBe(0);
    expect(s.isFullyPaid).toBe(true);
    expect(s.hasOverage).toBe(false);
  });

  it('1500 cash on 1000 → change = 500', () => {
    const s = summarizeSplitPayments([cashRow(1500)], 1000);
    expect(s.change).toBe(500);
    expect(s.isFullyPaid).toBe(true);
    expect(s.hasOverage).toBe(true);
  });

  it('600 cash on 1000 → remaining = 400 (آجل)', () => {
    const s = summarizeSplitPayments([cashRow(600)], 1000);
    expect(s.remaining).toBe(400);
    expect(s.change).toBe(0);
    expect(s.isFullyPaid).toBe(false);
  });

  it('rounds totals to 2 decimals', () => {
    const s = summarizeSplitPayments(
      [cashRow(33.333), cashRow(66.666)],
      100,
    );
    expect(s.totalPaid).toBe(100);
    expect(s.cashPaid).toBe(100);
  });

  it('treats negative amounts as 0 in totals (defensive)', () => {
    const s = summarizeSplitPayments([cashRow(-50), cashRow(100)], 100);
    expect(s.totalPaid).toBe(100);
  });
});

describe('rowsToPaymentDrafts — PR-POS-PAY-1', () => {
  it('drops uid + rounds amounts + preserves method/account fields', () => {
    // Values chosen to avoid IEEE-754 half-rounding edge cases (e.g.
    // 600.555 doesn't round-trip exactly through *100 / 100 because
    // its binary representation is 600.5549999...). Using cleanly
    // representable cents avoids cross-platform flakes.
    const rows: SplitPaymentRow[] = [
      cashRow(600.564),
      {
        uid: 'x',
        method: 'instapay',
        amount: 399.444,
        payment_account_id: 'acct-7',
        account_display_name: 'InstaPay الأهلي',
        reference: 'IPY-1234',
      },
    ];
    const drafts = rowsToPaymentDrafts(rows);
    expect(drafts).toHaveLength(2);
    // No uid leakage
    drafts.forEach((d) => {
      expect((d as any).uid).toBeUndefined();
    });
    // Cash row — rounded to 2 decimals (600.564 → 600.56)
    expect(drafts[0]).toEqual({
      method: 'cash',
      amount: 600.56,
      payment_account_id: null,
      account_display_name: undefined,
      reference: undefined,
    });
    // InstaPay row preserves account fields (399.444 → 399.44)
    expect(drafts[1]).toEqual({
      method: 'instapay',
      amount: 399.44,
      payment_account_id: 'acct-7',
      account_display_name: 'InstaPay الأهلي',
      reference: 'IPY-1234',
    });
  });

  it('produces a single-element array for single-payment (legacy backward compat)', () => {
    const drafts = rowsToPaymentDrafts([cashRow(1000)]);
    expect(drafts).toEqual([
      {
        method: 'cash',
        amount: 1000,
        payment_account_id: null,
        account_display_name: undefined,
        reference: undefined,
      },
    ]);
  });

  it('produces N-element array matching N input rows', () => {
    const rows = [cashRow(100), cashRow(200), instapayRow(300, 'a-1')];
    const drafts = rowsToPaymentDrafts(rows);
    expect(drafts).toHaveLength(3);
    expect(drafts.map((d) => d.method)).toEqual(['cash', 'cash', 'instapay']);
  });
});

describe('makeRowUid — uniqueness', () => {
  it('generates unique uids on successive calls', () => {
    const uids = new Set([
      makeRowUid(),
      makeRowUid(),
      makeRowUid(),
      makeRowUid(),
    ]);
    expect(uids.size).toBe(4);
  });
});
