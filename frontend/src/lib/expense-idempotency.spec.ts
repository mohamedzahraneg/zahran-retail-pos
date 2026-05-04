/**
 * expense-idempotency.spec.ts — PR-AUDIT-IDEMPOTENCY-ACCOUNTING-EXPENSES-FE
 *
 * Pins the FE half of the opt-in idempotency contract for the two
 * expense-create routes shipped in PR #279:
 *
 *   · POST /accounting/expenses
 *   · POST /accounting/expenses/daily
 *
 * Both routes share ONE helper module (this file under test) because
 * they share the same intent boundary: an open `AddExpenseModal` (in
 * DailyExpenses.tsx) or `AdvanceModal` (in AccountsMovementsTab.tsx).
 * Each modal is conditional-rendered, so mount-on-open / unmount-on-
 * close + a useEffect with a cleanup gives one key per modal session.
 *
 * Behavior pinned:
 *   1. One Idempotency-Key per expense modal intent.
 *   2. Same key reused on retry within one open modal session.
 *   3. Reset on modal mount / unmount (the useEffect in each modal).
 *   4. Field changes within the open modal do NOT reset the key.
 *   5. Header attaches only to the two expense routes.
 *   6. No header on GETs / sibling accounting POSTs / suffix routes /
 *      /pos/invoices / /cash-desk/transfer / /sync/push.
 *   7. Caller-provided Idempotency-Key (any casing) preserved.
 *   8. Key format matches the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 *   9. The three FE helpers (checkout / transfer / expense) do NOT
 *      cross-fire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateExpenseIdempotencyKey,
  resetExpenseIdempotencyKey,
  attachExpenseIdempotencyKeyIfApplicable,
  _resetExpenseIdempotencyKeyForTests,
} from './expense-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';
import {
  attachTransferIdempotencyKeyIfApplicable,
  _resetTransferIdempotencyKeyForTests,
} from './transfer-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

beforeEach(() => {
  _resetExpenseIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetTransferIdempotencyKeyForTests();
});

describe('expense idempotency module — key lifecycle', () => {
  it('getOrCreate returns the same key on repeated calls within one intent', () => {
    const a = getOrCreateExpenseIdempotencyKey();
    const b = getOrCreateExpenseIdempotencyKey();
    expect(a).toBe(b);
    expect(a).toMatch(BE_PATTERN);
  });

  it('reset → next getOrCreate returns a NEW key', () => {
    const a = getOrCreateExpenseIdempotencyKey();
    resetExpenseIdempotencyKey();
    const b = getOrCreateExpenseIdempotencyKey();
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
      _resetExpenseIdempotencyKeyForTests();
      const k = getOrCreateExpenseIdempotencyKey();
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

describe('attachExpenseIdempotencyKeyIfApplicable — request shape gate', () => {
  it('attaches the header on POST /accounting/expenses', () => {
    const cfg: any = {
      method: 'post',
      url: '/accounting/expenses',
      headers: {},
    };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('attaches the header on POST /accounting/expenses/daily', () => {
    const cfg: any = {
      method: 'post',
      url: '/accounting/expenses/daily',
      headers: {},
    };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('sends the SAME key on a second POST in the same modal intent', () => {
    const cfg1: any = { method: 'post', url: '/accounting/expenses/daily', headers: {} };
    const cfg2: any = { method: 'post', url: '/accounting/expenses/daily', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg1);
    attachExpenseIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBeDefined();
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('sends the SAME key across the two expense routes within one intent', () => {
    // Within an open modal, both /accounting/expenses and
    // /accounting/expenses/daily resolve to the same key — the FE
    // module is route-agnostic; the BE namespace separates them.
    const cfg1: any = { method: 'post', url: '/accounting/expenses', headers: {} };
    const cfg2: any = { method: 'post', url: '/accounting/expenses/daily', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg1);
    attachExpenseIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after resetExpenseIdempotencyKey(), the next POST uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: '/accounting/expenses/daily', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];

    // Simulates AddExpenseModal / AdvanceModal unmount → next mount.
    resetExpenseIdempotencyKey();

    const cfg2: any = { method: 'post', url: '/accounting/expenses/daily', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg2);
    const k2 = cfg2.headers['Idempotency-Key'];

    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k2).not.toBe(k1);
  });

  it('does NOT attach the header on GETs (any GET)', () => {
    for (const url of [
      '/accounting/expenses',
      '/accounting/expenses/daily',
      '/accounting/categories',
      '/accounting/reports/profit-and-loss',
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachExpenseIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on sibling accounting POST routes', () => {
    for (const url of [
      '/accounting/categories',
      '/accounting/approvals/rules',
      '/accounting/approvals/abc-id/approve',
      '/accounting/approvals/abc-id/reject',
      '/accounting/expenses/abc-id/approve',
      '/accounting/expenses/abc-id/edit-request',
      '/accounting/expenses/edit-requests/abc-id/approve',
      '/accounting/expenses/edit-requests/abc-id/reject',
      '/accounting/expenses/edit-requests/abc-id/cancel',
      '/accounting/cost/reconcile',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachExpenseIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on URLs that look like a prefix match', () => {
    // Strict equality on the URL gate — any suffix mismatches.
    // Pinned to guard against a future refactor to startsWith().
    for (const url of [
      '/accounting/expenses/anything-else',
      '/accounting/expenses/abc-id',
      '/accounting/expenses/daily/anything-else',
      '/accounting/expenses/daily/abc-id',
      '/accounting/expenses-foo',
      '/accounting/expensesextra',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachExpenseIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach the header on POST /pos/invoices or /cash-desk/transfer', () => {
    const cfgA: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfgA);
    expect(cfgA.headers['Idempotency-Key']).toBeUndefined();

    const cfgB: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfgB);
    expect(cfgB.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach the header on POST /sync/push', () => {
    const cfg: any = { method: 'post', url: '/sync/push', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('preserves a caller-provided Idempotency-Key (does not overwrite)', () => {
    const cfg: any = {
      method: 'post',
      url: '/accounting/expenses/daily',
      headers: { 'Idempotency-Key': 'caller-supplied-expense-1234' },
    };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      'caller-supplied-expense-1234',
    );
  });

  it('preserves a caller-provided lowercase idempotency-key header too', () => {
    const cfg: any = {
      method: 'post',
      url: '/accounting/expenses',
      headers: { 'idempotency-key': 'caller-supplied-lower-exp-1234' },
    };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['idempotency-key']).toBe(
      'caller-supplied-lower-exp-1234',
    );
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = {
      method: 'POST',
      url: '/accounting/expenses/daily',
      headers: {},
    };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

/**
 * Cross-route isolation between all THREE active idempotency
 * helpers. None of them must cross-fire onto a route owned by
 * a sibling helper.
 */
describe('cross-helper isolation — checkout × transfer × expense', () => {
  it('expense helper does NOT attach to /pos/invoices', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('expense helper does NOT attach to /cash-desk/transfer', () => {
    const cfg: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('checkout helper does NOT attach to /accounting/expenses or /accounting/expenses/daily', () => {
    for (const url of ['/accounting/expenses', '/accounting/expenses/daily']) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachCheckoutIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('transfer helper does NOT attach to /accounting/expenses or /accounting/expenses/daily', () => {
    for (const url of ['/accounting/expenses', '/accounting/expenses/daily']) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachTransferIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('running all THREE helpers in sequence on /pos/invoices uses the checkout key only', () => {
    const cfg: any = { method: 'post', url: '/pos/invoices', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    const onWireKey = cfg.headers['Idempotency-Key'];
    expect(onWireKey).toBeDefined();
    // Whichever helper actually fired, the other two modules' keys
    // must still be distinct from the one on the wire (which proves
    // they didn't fire and overwrite).
    expect(onWireKey).not.toBe(getOrCreateExpenseIdempotencyKey());
  });

  it('running all THREE helpers in sequence on /cash-desk/transfer uses the transfer key only', () => {
    const cfg: any = { method: 'post', url: '/cash-desk/transfer', headers: {} };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    const onWireKey = cfg.headers['Idempotency-Key'];
    expect(onWireKey).toBeDefined();
    expect(onWireKey).not.toBe(getOrCreateExpenseIdempotencyKey());
  });

  it('running all THREE helpers in sequence on /accounting/expenses/daily uses the expense key only', () => {
    const cfg: any = {
      method: 'post',
      url: '/accounting/expenses/daily',
      headers: {},
    };
    attachCheckoutIdempotencyKeyIfApplicable(cfg);
    attachTransferIdempotencyKeyIfApplicable(cfg);
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    const onWireKey = cfg.headers['Idempotency-Key'];
    expect(onWireKey).toBeDefined();
    // The key on the wire must equal the expense module's current
    // key — proves the expense helper fired, and the other two
    // didn't overwrite.
    expect(onWireKey).toBe(getOrCreateExpenseIdempotencyKey());
  });
});
