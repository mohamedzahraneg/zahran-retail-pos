/**
 * cashboxBalanceDisplay.test.ts — PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE
 *
 * Pins the single source of truth that decides which balance figure
 * a cashbox row renders. The helper exists because the stored
 * `cashboxes.current_balance` only changes via `cashbox_transactions`
 * writes — and non-cash payments (wallet/instapay/card/bank_transfer)
 * deliberately don't write CTs (per posting.service.ts:260). Without
 * the helper, ewallet/bank/check cashboxes display 0.00 forever and
 * the operator can't see the wallet/bank money sitting in the GL.
 *
 * Contract:
 *   cash    → current_balance (canonical drawer figure), kind='cash'
 *   ewallet
 *   bank    → accounting_balance via GL net (1114/1113/1115),
 *   check     kind='accounting' + glCode set
 *
 *   non-cash w/o accounting_balance → graceful fallback to
 *     current_balance with kind='cash' (older API without the new
 *     column never breaks the FE)
 *
 *   non-cash w/o accounting_gl_code → kind='unlinked' so the FE
 *     can render a "غير مربوط" warning instead of pretending it has
 *     a balance
 */
import { describe, it, expect } from 'vitest';
import { displayCashboxBalance } from '../cashboxBalanceDisplay';

describe('displayCashboxBalance — kind=cash', () => {
  it('returns current_balance with kind="cash" and glCode=null (numeric input)', () => {
    expect(
      displayCashboxBalance({
        kind: 'cash',
        current_balance: 1500,
        accounting_balance: null,
        accounting_gl_code: null,
      }),
    ).toEqual({ amount: 1500, kind: 'cash', glCode: null });
  });

  it('coerces a string current_balance ("1500.00") into the numeric amount', () => {
    expect(
      displayCashboxBalance({
        kind: 'cash',
        current_balance: '1500.00',
      }),
    ).toEqual({ amount: 1500, kind: 'cash', glCode: null });
  });

  it('null/undefined current_balance defaults to 0 (no NaN leak to the UI)', () => {
    expect(displayCashboxBalance({ kind: 'cash', current_balance: null })).toEqual({
      amount: 0,
      kind: 'cash',
      glCode: null,
    });
    expect(
      displayCashboxBalance({ kind: 'cash', current_balance: undefined }),
    ).toEqual({ amount: 0, kind: 'cash', glCode: null });
  });

  it('IGNORES accounting_balance for cash kind even if BE accidentally sends one', () => {
    // Defensive: cash drawer figure is canonical. If the BE shipped a
    // non-null accounting_balance for a cash cashbox (it shouldn't —
    // see settings.service.ts CASE expression), the helper must still
    // return current_balance.
    expect(
      displayCashboxBalance({
        kind: 'cash',
        current_balance: 1500,
        accounting_balance: '999.99',
        accounting_gl_code: '1111',
      }),
    ).toEqual({ amount: 1500, kind: 'cash', glCode: null });
  });

  it('omitted kind defaults to cash semantics (legacy rows without kind never break)', () => {
    expect(displayCashboxBalance({ current_balance: 200 })).toEqual({
      amount: 200,
      kind: 'cash',
      glCode: null,
    });
  });
});

describe('displayCashboxBalance — kind=ewallet/bank/check (GL-derived)', () => {
  it('ewallet → accounting_balance + glCode 1114 + kind="accounting"', () => {
    // Production fixture-shape: GL 1114 net = +2,190.00 EGP from
    // wallet/instapay invoice payments, while the stored
    // current_balance on خزنة التحويلات is still 0.
    expect(
      displayCashboxBalance({
        kind: 'ewallet',
        current_balance: '0',
        accounting_balance: '2190.00',
        accounting_gl_code: '1114',
      }),
    ).toEqual({ amount: 2190, kind: 'accounting', glCode: '1114' });
  });

  it('bank → accounting_balance + glCode 1113 + kind="accounting"', () => {
    expect(
      displayCashboxBalance({
        kind: 'bank',
        current_balance: '0',
        accounting_balance: '5000.00',
        accounting_gl_code: '1113',
      }),
    ).toEqual({ amount: 5000, kind: 'accounting', glCode: '1113' });
  });

  it('check → accounting_balance + glCode 1115 + kind="accounting"', () => {
    expect(
      displayCashboxBalance({
        kind: 'check',
        current_balance: '0',
        accounting_balance: '750.00',
        accounting_gl_code: '1115',
      }),
    ).toEqual({ amount: 750, kind: 'accounting', glCode: '1115' });
  });

  it('numeric accounting_balance is honored (not just string form)', () => {
    expect(
      displayCashboxBalance({
        kind: 'ewallet',
        current_balance: 0,
        accounting_balance: 2190 as any,
        accounting_gl_code: '1114',
      }),
    ).toEqual({ amount: 2190, kind: 'accounting', glCode: '1114' });
  });

  it('NEVER falls back to current_balance for non-cash kinds when accounting_balance IS set', () => {
    // If we ever silently used the stored current_balance for ewallet,
    // we'd be back to displaying 0 — exactly the bug this PR fixes.
    const out = displayCashboxBalance({
      kind: 'ewallet',
      current_balance: '999.99',
      accounting_balance: '2190.00',
      accounting_gl_code: '1114',
    });
    expect(out.amount).toBe(2190);
    expect(out.amount).not.toBe(999.99);
  });
});

describe('displayCashboxBalance — graceful fallbacks', () => {
  it('non-cash kind with accounting_balance == null falls back to current_balance with kind=cash (older BE)', () => {
    // The new column is optional on the wire — if the BE hasn't
    // shipped accounting_balance yet (or a query path returned NULL),
    // the FE should NOT throw; it degrades to the legacy display.
    expect(
      displayCashboxBalance({
        kind: 'ewallet',
        current_balance: '0',
        accounting_balance: null,
        accounting_gl_code: null,
      }),
    ).toEqual({ amount: 0, kind: 'cash', glCode: null });

    expect(
      displayCashboxBalance({
        kind: 'bank',
        current_balance: '125.50',
        // accounting_balance omitted entirely
      }),
    ).toEqual({ amount: 125.5, kind: 'cash', glCode: null });
  });

  it('non-cash kind WITH accounting_balance but NO gl_code → kind="unlinked" (warns the operator)', () => {
    // Defensive — the BE CASE shouldn't produce this, but if a row
    // ever lacks a GL link the FE should not pretend it has a real
    // accounting balance.
    expect(
      displayCashboxBalance({
        kind: 'ewallet',
        current_balance: '0',
        accounting_balance: '0',
        accounting_gl_code: null,
      }),
    ).toEqual({ amount: 0, kind: 'unlinked', glCode: null });
  });

  it('null/undefined accounting_balance amount defaults to 0 once kind is decided', () => {
    // Edge case: glCode set but accounting_balance string is empty.
    expect(
      displayCashboxBalance({
        kind: 'bank',
        current_balance: '0',
        accounting_balance: '' as any,
        accounting_gl_code: '1113',
      }).amount,
    ).toBe(0);
  });
});

describe('displayCashboxBalance — NaN defense (PR-FIX-CASHBOX-NAN)', () => {
  // Production incident: «الخزينة الرئيسية» rendered "NaN" because the
  // stored `cashboxes.current_balance` was the pg numeric NaN literal
  // (serialized to JSON as the string "NaN").  The naive
  // `Number(x) || 0` idiom does NOT catch NaN — NaN is truthy in JS,
  // so `NaN || 0 === NaN`.  These tests pin the `Number.isFinite`
  // defense at every branch so a corrupted source value renders 0,
  // never the literal "NaN".

  it('cash kind: current_balance="NaN" string coerces to 0', () => {
    expect(
      displayCashboxBalance({ kind: 'cash', current_balance: 'NaN' }),
    ).toEqual({ amount: 0, kind: 'cash', glCode: null });
  });

  it('cash kind: numeric NaN coerces to 0', () => {
    expect(
      displayCashboxBalance({ kind: 'cash', current_balance: Number.NaN as any }),
    ).toEqual({ amount: 0, kind: 'cash', glCode: null });
  });

  it('cash kind: Infinity coerces to 0 (defensive against any non-finite)', () => {
    expect(
      displayCashboxBalance({
        kind: 'cash',
        current_balance: Number.POSITIVE_INFINITY as any,
      }),
    ).toEqual({ amount: 0, kind: 'cash', glCode: null });
  });

  it('non-cash kind: accounting_balance="NaN" coerces to 0', () => {
    expect(
      displayCashboxBalance({
        kind: 'ewallet',
        current_balance: '0',
        accounting_balance: 'NaN',
        accounting_gl_code: '1114',
      }),
    ).toEqual({ amount: 0, kind: 'accounting', glCode: '1114' });
  });

  it('unlinked kind: accounting_balance="NaN" coerces to 0', () => {
    expect(
      displayCashboxBalance({
        kind: 'ewallet',
        current_balance: '0',
        accounting_balance: 'NaN',
        accounting_gl_code: null,
      }),
    ).toEqual({ amount: 0, kind: 'unlinked', glCode: null });
  });

  it('non-cash fallback (accounting_balance null) with NaN current_balance coerces to 0', () => {
    expect(
      displayCashboxBalance({
        kind: 'bank',
        current_balance: 'NaN',
        accounting_balance: null,
      }),
    ).toEqual({ amount: 0, kind: 'cash', glCode: null });
  });

  it('arbitrary non-numeric strings still coerce to 0 (no NaN leak)', () => {
    expect(
      displayCashboxBalance({ kind: 'cash', current_balance: 'abc' }),
    ).toEqual({ amount: 0, kind: 'cash', glCode: null });
  });
});
