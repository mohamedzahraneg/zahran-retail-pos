/**
 * accounting-ops-idempotency.spec.ts — PR-FE-IDEM-ACCOUNTING-OPS
 *   (Sprint 5 / FE-IDEM PR 7B)
 *
 * Pins the FE half of the opt-in idempotency contract for seven
 * accounting + chart-of-accounts mutation routes already protected
 * backend-side:
 *
 *   · POST /accounting/approvals/:id/approve              (BE: PR #312)
 *   · POST /accounting/expenses/:id/approve               (BE: PR #312)
 *   · POST /accounting/expenses/edit-requests/:id/approve (BE: PR #312)
 *   · POST /accounts/journal                              (BE: PR #312)
 *   · POST /accounts/journal/:id/void                     (BE: PR #312)
 *   · POST /accounts/close-year                           (BE: PR #312)
 *   · POST /accounts/depreciation/run                     (BE: PR #312)
 *
 * URL note: the BE chart-of-accounts controller is
 * `@Controller('accounts')` — the deployed routes use `/accounts/*`,
 * NOT `/chart-of-accounts/*`. Tests assert against the actual
 * deployed paths.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateAccountingOpsApprovalApproveIdempotencyKey,
  resetAccountingOpsApprovalApproveIdempotencyKey,
  _resetAccountingOpsApprovalApproveIdempotencyKeyForTests,
  getOrCreateAccountingOpsExpenseApproveIdempotencyKey,
  resetAccountingOpsExpenseApproveIdempotencyKey,
  _resetAccountingOpsExpenseApproveIdempotencyKeyForTests,
  getOrCreateAccountingOpsEditRequestApproveIdempotencyKey,
  resetAccountingOpsEditRequestApproveIdempotencyKey,
  _resetAccountingOpsEditRequestApproveIdempotencyKeyForTests,
  getOrCreateAccountingOpsJournalCreateIdempotencyKey,
  resetAccountingOpsJournalCreateIdempotencyKey,
  _resetAccountingOpsJournalCreateIdempotencyKeyForTests,
  getOrCreateAccountingOpsJournalVoidIdempotencyKey,
  resetAccountingOpsJournalVoidIdempotencyKey,
  _resetAccountingOpsJournalVoidIdempotencyKeyForTests,
  getOrCreateAccountingOpsCloseYearIdempotencyKey,
  resetAccountingOpsCloseYearIdempotencyKey,
  _resetAccountingOpsCloseYearIdempotencyKeyForTests,
  getOrCreateAccountingOpsRunDepreciationIdempotencyKey,
  resetAccountingOpsRunDepreciationIdempotencyKey,
  _resetAccountingOpsRunDepreciationIdempotencyKeyForTests,
  attachAccountingOpsIdempotencyKeyIfApplicable,
} from './accounting-ops-idempotency';
import {
  attachExpenseIdempotencyKeyIfApplicable,
  getOrCreateExpenseIdempotencyKey,
  _resetExpenseIdempotencyKeyForTests,
} from './expense-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';
import {
  attachShiftsIdempotencyKeyIfApplicable,
  _resetShiftsCloseIdempotencyKeyForTests,
  _resetShiftsApproveCloseIdempotencyKeyForTests,
  _resetShiftsAdjustCountIdempotencyKeyForTests,
} from './shifts-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const APPROVAL_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const EXPENSE_ID = 'eeee1111-ffff-2222-aaaa-333344445555';
const REQUEST_ID = 'rrrr1111-ssss-2222-tttt-333344445555';
const ENTRY_ID = 'jjjj1111-kkkk-2222-llll-333344445555';

beforeEach(() => {
  _resetAccountingOpsApprovalApproveIdempotencyKeyForTests();
  _resetAccountingOpsExpenseApproveIdempotencyKeyForTests();
  _resetAccountingOpsEditRequestApproveIdempotencyKeyForTests();
  _resetAccountingOpsJournalCreateIdempotencyKeyForTests();
  _resetAccountingOpsJournalVoidIdempotencyKeyForTests();
  _resetAccountingOpsCloseYearIdempotencyKeyForTests();
  _resetAccountingOpsRunDepreciationIdempotencyKeyForTests();
  _resetExpenseIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetShiftsCloseIdempotencyKeyForTests();
  _resetShiftsApproveCloseIdempotencyKeyForTests();
  _resetShiftsAdjustCountIdempotencyKeyForTests();
});

// ── Per-action key lifecycle ─────────────────────────────────────────
describe('accounting-ops idempotency module — key lifecycle', () => {
  const cases: Array<[string, () => string, () => void]> = [
    ['approval-approve',     getOrCreateAccountingOpsApprovalApproveIdempotencyKey,     resetAccountingOpsApprovalApproveIdempotencyKey],
    ['expense-approve',      getOrCreateAccountingOpsExpenseApproveIdempotencyKey,      resetAccountingOpsExpenseApproveIdempotencyKey],
    ['edit-request-approve', getOrCreateAccountingOpsEditRequestApproveIdempotencyKey, resetAccountingOpsEditRequestApproveIdempotencyKey],
    ['journal-create',       getOrCreateAccountingOpsJournalCreateIdempotencyKey,       resetAccountingOpsJournalCreateIdempotencyKey],
    ['journal-void',         getOrCreateAccountingOpsJournalVoidIdempotencyKey,         resetAccountingOpsJournalVoidIdempotencyKey],
    ['close-year',           getOrCreateAccountingOpsCloseYearIdempotencyKey,           resetAccountingOpsCloseYearIdempotencyKey],
    ['run-depreciation',     getOrCreateAccountingOpsRunDepreciationIdempotencyKey,     resetAccountingOpsRunDepreciationIdempotencyKey],
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
      _resetAccountingOpsJournalCreateIdempotencyKeyForTests();
      const k = getOrCreateAccountingOpsJournalCreateIdempotencyKey();
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
  it('all 7 keys are distinct from each other', () => {
    const keys = [
      getOrCreateAccountingOpsApprovalApproveIdempotencyKey(),
      getOrCreateAccountingOpsExpenseApproveIdempotencyKey(),
      getOrCreateAccountingOpsEditRequestApproveIdempotencyKey(),
      getOrCreateAccountingOpsJournalCreateIdempotencyKey(),
      getOrCreateAccountingOpsJournalVoidIdempotencyKey(),
      getOrCreateAccountingOpsCloseYearIdempotencyKey(),
      getOrCreateAccountingOpsRunDepreciationIdempotencyKey(),
    ];
    expect(new Set(keys).size).toBe(7);
  });

  it('reset on journal-create does NOT affect any of the other 6 keys', () => {
    const a = getOrCreateAccountingOpsApprovalApproveIdempotencyKey();
    const e = getOrCreateAccountingOpsExpenseApproveIdempotencyKey();
    const r = getOrCreateAccountingOpsEditRequestApproveIdempotencyKey();
    getOrCreateAccountingOpsJournalCreateIdempotencyKey();
    const v = getOrCreateAccountingOpsJournalVoidIdempotencyKey();
    const c = getOrCreateAccountingOpsCloseYearIdempotencyKey();
    const d = getOrCreateAccountingOpsRunDepreciationIdempotencyKey();
    resetAccountingOpsJournalCreateIdempotencyKey();
    expect(getOrCreateAccountingOpsApprovalApproveIdempotencyKey()).toBe(a);
    expect(getOrCreateAccountingOpsExpenseApproveIdempotencyKey()).toBe(e);
    expect(getOrCreateAccountingOpsEditRequestApproveIdempotencyKey()).toBe(r);
    expect(getOrCreateAccountingOpsJournalVoidIdempotencyKey()).toBe(v);
    expect(getOrCreateAccountingOpsCloseYearIdempotencyKey()).toBe(c);
    expect(getOrCreateAccountingOpsRunDepreciationIdempotencyKey()).toBe(d);
  });

  it('reset on close-year does NOT affect any of the other 6 keys', () => {
    const a = getOrCreateAccountingOpsApprovalApproveIdempotencyKey();
    const e = getOrCreateAccountingOpsExpenseApproveIdempotencyKey();
    const r = getOrCreateAccountingOpsEditRequestApproveIdempotencyKey();
    const cr = getOrCreateAccountingOpsJournalCreateIdempotencyKey();
    const v = getOrCreateAccountingOpsJournalVoidIdempotencyKey();
    getOrCreateAccountingOpsCloseYearIdempotencyKey();
    const d = getOrCreateAccountingOpsRunDepreciationIdempotencyKey();
    resetAccountingOpsCloseYearIdempotencyKey();
    expect(getOrCreateAccountingOpsApprovalApproveIdempotencyKey()).toBe(a);
    expect(getOrCreateAccountingOpsExpenseApproveIdempotencyKey()).toBe(e);
    expect(getOrCreateAccountingOpsEditRequestApproveIdempotencyKey()).toBe(r);
    expect(getOrCreateAccountingOpsJournalCreateIdempotencyKey()).toBe(cr);
    expect(getOrCreateAccountingOpsJournalVoidIdempotencyKey()).toBe(v);
    expect(getOrCreateAccountingOpsRunDepreciationIdempotencyKey()).toBe(d);
  });
});

// ── URL gate — POST + exact pattern matches ───────────────────────────
describe('attachAccountingOpsIdempotencyKeyIfApplicable — URL gate', () => {
  const routeCases: Array<[string, string, () => string]> = [
    ['approval-approve',     `/accounting/approvals/${APPROVAL_ID}/approve`,                         getOrCreateAccountingOpsApprovalApproveIdempotencyKey],
    ['expense-approve',      `/accounting/expenses/${EXPENSE_ID}/approve`,                           getOrCreateAccountingOpsExpenseApproveIdempotencyKey],
    ['edit-request-approve', `/accounting/expenses/edit-requests/${REQUEST_ID}/approve`,             getOrCreateAccountingOpsEditRequestApproveIdempotencyKey],
    ['journal-create',       `/accounts/journal`,                                                    getOrCreateAccountingOpsJournalCreateIdempotencyKey],
    ['journal-void',         `/accounts/journal/${ENTRY_ID}/void`,                                   getOrCreateAccountingOpsJournalVoidIdempotencyKey],
    ['close-year',           `/accounts/close-year`,                                                 getOrCreateAccountingOpsCloseYearIdempotencyKey],
    ['run-depreciation',     `/accounts/depreciation/run`,                                           getOrCreateAccountingOpsRunDepreciationIdempotencyKey],
  ];
  it.each(routeCases)('POST %s attaches the correct key', (_, url, getter) => {
    const cfg: any = { method: 'post', url, headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(getter());
  });

  it('SAME journal-create key on second POST for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: '/accounts/journal', headers: {} };
    const cfg2: any = { method: 'post', url: '/accounts/journal', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg1);
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST journal-create uses a NEW key', () => {
    const cfg1: any = { method: 'post', url: '/accounts/journal', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetAccountingOpsJournalCreateIdempotencyKey();
    const cfg2: any = { method: 'post', url: '/accounts/journal', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  it('different approval IDs on /approvals/:id/approve SHARE the approval-approve key (intent boundary is the click)', () => {
    const cfgA: any = { method: 'post', url: '/accounting/approvals/aaaa-1111/approve', headers: {} };
    const cfgB: any = { method: 'post', url: '/accounting/approvals/bbbb-2222/approve', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfgA);
    attachAccountingOpsIdempotencyKeyIfApplicable(cfgB);
    expect(cfgA.headers['Idempotency-Key']).toBe(cfgB.headers['Idempotency-Key']);
  });

  // ── Strict pattern: out-of-scope routes ──
  it('does NOT attach on POST /accounting/expenses (create — owned by expense-idempotency)', () => {
    const cfg: any = { method: 'post', url: '/accounting/expenses', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /accounting/expenses/daily (owned by expense-idempotency)', () => {
    const cfg: any = { method: 'post', url: '/accounting/expenses/daily', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on reject/cancel/state-only routes', () => {
    for (const url of [
      `/accounting/approvals/${APPROVAL_ID}/reject`,
      `/accounting/expenses/edit-requests/${REQUEST_ID}/reject`,
      `/accounting/expenses/edit-requests/${REQUEST_ID}/cancel`,
      `/accounting/expenses/${EXPENSE_ID}/edit-request`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on accounting CRUD/admin routes', () => {
    for (const url of [
      '/accounting/approvals/rules',
      `/accounting/approvals/rules/${APPROVAL_ID}`,
      '/accounting/categories',
      `/accounting/categories/${EXPENSE_ID}`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on /accounts/* CRUD/admin routes', () => {
    for (const url of [
      '/accounts/chart',
      `/accounts/chart/${APPROVAL_ID}`,
      '/accounts/journal/backfill',
      '/accounts/fixed-assets',
      `/accounts/fixed-assets/${APPROVAL_ID}`,
      '/accounts/budgets',
      '/accounts/cost-centers',
      '/accounts/fx/rates',
      '/accounts/fx/revalue',
      '/accounts/audit/opening-balance',
      `/accounts/audit/rebuild-cashbox-balance/${APPROVAL_ID}`,
      '/accounts/audit/drift-cleanup/historical',
      '/accounts/reports/trial-balance-comparison',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on GETs for any /accounting/* or /accounts/* path', () => {
    for (const url of [
      '/accounting/approvals/inbox',
      '/accounting/expenses',
      `/accounting/expenses/${EXPENSE_ID}`,
      `/accounting/expenses/${EXPENSE_ID}/approve`,  // GET on same path
      '/accounts/journal',
      `/accounts/journal/${ENTRY_ID}`,
      '/accounts/close-year',
      '/accounts/depreciation/run',
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PATCH/PUT/DELETE on the seven target patterns', () => {
    for (const method of ['patch', 'put', 'delete']) {
      for (const url of [
        `/accounting/approvals/${APPROVAL_ID}/approve`,
        `/accounting/expenses/${EXPENSE_ID}/approve`,
        `/accounting/expenses/edit-requests/${REQUEST_ID}/approve`,
        '/accounts/journal',
        `/accounts/journal/${ENTRY_ID}/void`,
        '/accounts/close-year',
        '/accounts/depreciation/run',
      ]) {
        const cfg: any = { method, url, headers: {} };
        attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Suffix attacks
      `/accounting/approvals/${APPROVAL_ID}/approve/anything-else`,
      `/accounts/journal/${ENTRY_ID}/void/abc`,
      '/accounts/close-year/abc',
      '/accounts/depreciation/run/abc',
      // Plural/singular trap
      `/accounting/approval/${APPROVAL_ID}/approve`,
      // Cross-controller siblings
      '/pos/invoices',
      '/cash-desk/transfer',
      '/shifts/abc-id/close',
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key in 3 casing variants', () => {
    const cfg1: any = {
      method: 'post', url: '/accounts/close-year',
      headers: { 'Idempotency-Key': 'caller-supplied-close-1234' },
    };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg1);
    expect(cfg1.headers['Idempotency-Key']).toBe('caller-supplied-close-1234');

    const cfg2: any = {
      method: 'post', url: '/accounts/journal',
      headers: { 'idempotency-key': 'caller-supplied-journal-1234' },
    };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['idempotency-key']).toBe('caller-supplied-journal-1234');
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();

    const cfg3: any = {
      method: 'post', url: `/accounting/approvals/${APPROVAL_ID}/approve`,
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-approval-1234' },
    };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg3);
    expect(cfg3.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-approval-1234');
    expect(cfg3.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg: any = { method: 'POST', url: '/accounts/journal', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });
});

// ── Coexistence with the existing expense-idempotency helper ─────────
describe('coexistence with expense-idempotency (POST /accounting/expenses + daily)', () => {
  it('expense helper still attaches on POST /accounting/expenses (no regression)', () => {
    const cfg: any = { method: 'post', url: '/accounting/expenses', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreateExpenseIdempotencyKey(),
    );
  });

  it('expense helper still attaches on POST /accounting/expenses/daily', () => {
    const cfg: any = { method: 'post', url: '/accounting/expenses/daily', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('this helper does NOT attach on /accounting/expenses (expense territory)', () => {
    const cfg: any = { method: 'post', url: '/accounting/expenses', headers: {} };
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('expense helper does NOT attach on /accounting/expenses/:id/approve (this helper-only territory)', () => {
    const cfg: any = { method: 'post', url: `/accounting/expenses/${EXPENSE_ID}/approve`, headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('running BOTH on /accounting/expenses uses expense key only', () => {
    const cfg: any = { method: 'post', url: '/accounting/expenses', headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreateExpenseIdempotencyKey());
  });

  it('running BOTH on /accounting/expenses/:id/approve uses this helper expense-approve key only', () => {
    const cfg: any = { method: 'post', url: `/accounting/expenses/${EXPENSE_ID}/approve`, headers: {} };
    attachExpenseIdempotencyKeyIfApplicable(cfg);
    attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreateAccountingOpsExpenseApproveIdempotencyKey());
    expect(k).not.toBe(getOrCreateExpenseIdempotencyKey());
  });
});

// ── Cross-route isolation against unrelated sibling helpers ──────────
describe('cross-route isolation — accounting-ops helper vs unrelated siblings', () => {
  it('accounting-ops helper does NOT attach to other controllers', () => {
    for (const url of [
      '/pos/invoices',
      `/pos/invoices/${ENTRY_ID}/void`,
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      `/reservations/${ENTRY_ID}/cancel`,
      `/returns/${ENTRY_ID}/refund`,
      '/exchanges',
      '/attendance/admin/pay-wage',
      `/employees/${ENTRY_ID}/bonuses`,
      `/shifts/${ENTRY_ID}/close`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachAccountingOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the checkout/shifts helpers do NOT attach to any of the 7 accounting-ops routes', () => {
    const fns = [attachCheckoutIdempotencyKeyIfApplicable, attachShiftsIdempotencyKeyIfApplicable];
    for (const url of [
      `/accounting/approvals/${APPROVAL_ID}/approve`,
      `/accounting/expenses/${EXPENSE_ID}/approve`,
      `/accounting/expenses/edit-requests/${REQUEST_ID}/approve`,
      '/accounts/journal',
      `/accounts/journal/${ENTRY_ID}/void`,
      '/accounts/close-year',
      '/accounts/depreciation/run',
    ]) {
      for (const fn of fns) {
        const cfg: any = { method: 'post', url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });
});
