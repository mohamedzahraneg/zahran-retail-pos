/**
 * expense-invariants.spec.ts — PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD
 *
 * Pins the app-level guard that blocks `payment_method='cash' (or
 * default-cash) + cashbox_id=NULL` from sneaking through ANY of the
 * five expense write paths:
 *
 *   1. accounting.service.ts:updateExpense
 *   2. accounting.service.ts:approveExpense
 *   3. accounting.service.ts:approveEditRequest
 *   4. approval.service.ts:decide       (multi-level approval terminal)
 *   5. recurring-expenses.service.ts:runOne
 *
 * Plus the helper itself (positive + negative cases for the contexts
 * the call sites pass in). The createExpense path was already guarded
 * before this PR — it is now wired through the same helper, so its
 * existing behavior is also covered indirectly via the helper-level
 * tests.
 *
 * Strict scope: this spec asserts ONLY the guard behavior — no engine,
 * no DB, no migration. The DataSource / EntityManager are stubbed so
 * the tests assert what the service throws and (for the negative
 * paths) that NO INSERT / UPDATE / engine call leaks past the guard.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';

import {
  assertExpenseInvariants,
  EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE,
} from './expense-invariants';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';
import { RecurringExpensesService } from '../recurring-expenses/recurring-expenses.service';

const ADMIN = '00000000-0000-0000-0000-00000000ad00';
const EMP = '11111111-1111-1111-1111-111111111111';
const CASHBOX = '33333333-3333-3333-3333-333333333333';
const CATEGORY = '55555555-5555-5555-5555-555555555555';
const WAREHOUSE = '66666666-6666-6666-6666-666666666666';
const EXPENSE_ID = '77777777-7777-7777-7777-777777777777';
const APPROVAL_ID = '88888888-8888-8888-8888-888888888888';
const RECURRING_ID = '99999999-9999-9999-9999-999999999999';

/* ────────────────────────────────────────────────────────────────────
 * 1. The helper itself — pure function, no DI needed.
 * ──────────────────────────────────────────────────────────────────── */

describe('assertExpenseInvariants — PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD', () => {
  describe('throws on cash + missing cashbox', () => {
    it('throws when payment_method="cash" and cashbox_id is null', () => {
      expect(() =>
        assertExpenseInvariants('cash', null, 'create'),
      ).toThrow(BadRequestException);
      expect(() =>
        assertExpenseInvariants('cash', null, 'create'),
      ).toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
    });

    it('throws when payment_method="cash" and cashbox_id is undefined', () => {
      expect(() =>
        assertExpenseInvariants('cash', undefined, 'update'),
      ).toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
    });

    it('throws when payment_method="cash" and cashbox_id is empty string', () => {
      expect(() =>
        assertExpenseInvariants('cash', '', 'approve'),
      ).toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
    });

    it('throws when payment_method is null/undefined (DB default = cash) and cashbox_id is null', () => {
      // The DB column default is `'cash'::payment_method_code` so a
      // missing value behaves identically to explicit cash.
      expect(() =>
        assertExpenseInvariants(null, null, 'edit_approve'),
      ).toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
      expect(() =>
        assertExpenseInvariants(undefined, null, 'multilevel_approve'),
      ).toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
    });

    it('is case-insensitive for payment_method (CASH/Cash/cash all blocked)', () => {
      expect(() =>
        assertExpenseInvariants('CASH', null, 'recurring'),
      ).toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
      expect(() =>
        assertExpenseInvariants('Cash', undefined, 'recurring'),
      ).toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
    });
  });

  describe('passes for valid combos', () => {
    it('passes when payment_method="cash" AND cashbox_id is set', () => {
      expect(() =>
        assertExpenseInvariants('cash', CASHBOX, 'create'),
      ).not.toThrow();
    });

    it('passes for non-cash payment methods even without cashbox', () => {
      // Bank/ewallet/check expenses without a cashbox are valid (the
      // engine posts them against AP, which is the canonical workflow
      // for "vendor expense paid later").
      for (const pm of ['bank', 'ewallet', 'check', 'transfer']) {
        expect(() =>
          assertExpenseInvariants(pm, null, 'create'),
        ).not.toThrow();
        expect(() =>
          assertExpenseInvariants(pm, undefined, 'create'),
        ).not.toThrow();
      }
    });

    it('passes for non-cash + cashbox set (no false positives)', () => {
      expect(() =>
        assertExpenseInvariants('bank', CASHBOX, 'create'),
      ).not.toThrow();
    });
  });
});

/* ────────────────────────────────────────────────────────────────────
 * 2. AccountingService — updateExpense / approveExpense /
 *    approveEditRequest wire-in tests.
 * ──────────────────────────────────────────────────────────────────── */

describe('AccountingService — guard wire-in (PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD)', () => {
  let service: AccountingService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let em: { query: jest.Mock };
  let engine: { recordExpense: jest.Mock; recordTransaction: jest.Mock };

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = {
      recordExpense: jest.fn(),
      recordTransaction: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(AccountingService);
  });

  /* ── updateExpense ────────────────────────────────────────────── */

  describe('updateExpense', () => {
    it('throws when DTO sets cashbox_id=null on a stored cash expense', async () => {
      // DTO touches cashbox_id → service fetches stored row.
      ds.query.mockResolvedValueOnce([
        { payment_method: 'cash', cashbox_id: CASHBOX },
      ]);

      await expect(
        service.updateExpense(EXPENSE_ID, { cashbox_id: null } as any),
      ).rejects.toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);

      // No UPDATE issued — only the SELECT for invariant validation.
      const updateCalls = ds.query.mock.calls.filter((c) =>
        String(c[0]).includes('UPDATE expenses SET'),
      );
      expect(updateCalls).toHaveLength(0);
    });

    it('throws when DTO sets payment_method="cash" on a stored row with no cashbox', async () => {
      ds.query.mockResolvedValueOnce([
        { payment_method: 'bank', cashbox_id: null },
      ]);

      await expect(
        service.updateExpense(EXPENSE_ID, {
          payment_method: 'cash',
        } as any),
      ).rejects.toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);

      const updateCalls = ds.query.mock.calls.filter((c) =>
        String(c[0]).includes('UPDATE expenses SET'),
      );
      expect(updateCalls).toHaveLength(0);
    });

    it('passes when merged combo is valid (cash + cashbox)', async () => {
      ds.query.mockResolvedValueOnce([
        { payment_method: 'bank', cashbox_id: null },
      ]);
      // Then the actual UPDATE returns the row.
      ds.query.mockResolvedValueOnce([
        { id: EXPENSE_ID, payment_method: 'cash', cashbox_id: CASHBOX },
      ]);

      const out = await service.updateExpense(EXPENSE_ID, {
        payment_method: 'cash',
        cashbox_id: CASHBOX,
      } as any);
      expect(out).toMatchObject({ id: EXPENSE_ID });
    });

    it('skips the invariant pre-fetch when the DTO touches neither field (no perf regression)', async () => {
      // Pure description edit — no SELECT for invariant should fire.
      ds.query.mockResolvedValueOnce([
        { id: EXPENSE_ID, description: 'updated' },
      ]);
      await service.updateExpense(EXPENSE_ID, {
        description: 'updated',
      } as any);
      // Exactly one query: the UPDATE.
      expect(ds.query).toHaveBeenCalledTimes(1);
      expect(String(ds.query.mock.calls[0][0])).toMatch(/UPDATE expenses SET/);
    });
  });

  /* ── approveExpense ───────────────────────────────────────────── */

  describe('approveExpense', () => {
    it('throws when stored row is cash + null cashbox (legacy bypass row)', async () => {
      em.query.mockResolvedValueOnce([
        {
          id: EXPENSE_ID,
          payment_method: 'cash',
          cashbox_id: null,
          is_approved: false,
        },
      ]);

      await expect(
        service.approveExpense(EXPENSE_ID, ADMIN),
      ).rejects.toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);

      // No UPDATE flipping is_approved, no engine call.
      const updateCalls = em.query.mock.calls.filter((c) =>
        String(c[0]).includes('UPDATE expenses SET is_approved'),
      );
      expect(updateCalls).toHaveLength(0);
      expect(engine.recordExpense).not.toHaveBeenCalled();
    });

    it('passes for valid stored row (cash + cashbox)', async () => {
      // 1. SELECT * FROM expenses … FOR UPDATE
      em.query.mockResolvedValueOnce([
        {
          id: EXPENSE_ID,
          payment_method: 'cash',
          cashbox_id: CASHBOX,
          is_approved: false,
        },
      ]);
      // 2. UPDATE expenses SET is_approved = TRUE … RETURNING *
      em.query.mockResolvedValueOnce([
        {
          id: EXPENSE_ID,
          expense_no: 'EXP-2026-0001',
          amount: 100,
          payment_method: 'cash',
          cashbox_id: CASHBOX,
          category_id: CATEGORY,
        },
      ]);
      // 3. postViaEngine → no resolver wired in this test, falls back
      //    to SELECT account_id FROM expense_categories.
      em.query.mockResolvedValueOnce([{ account_id: 'acct-uuid' }]);
      // Engine accepts.
      engine.recordExpense.mockResolvedValueOnce({ ok: true });

      await expect(
        service.approveExpense(EXPENSE_ID, ADMIN),
      ).resolves.toBeTruthy();
      expect(engine.recordExpense).toHaveBeenCalledTimes(1);
    });
  });

  /* ── approveEditRequest ───────────────────────────────────────── */

  describe('approveEditRequest', () => {
    it('throws when the merged edit produces cash + null cashbox', async () => {
      const REQUEST_ID = 'edit-request-uuid';
      // 1. SELECT expense_edit_requests FOR UPDATE.
      em.query.mockResolvedValueOnce([
        {
          id: REQUEST_ID,
          expense_id: EXPENSE_ID,
          status: 'pending',
          reason: 'fix amount',
          old_values: { cashbox_id: CASHBOX },
          new_values: { cashbox_id: null },
        },
      ]);
      // 2. SELECT expenses FOR UPDATE.
      em.query.mockResolvedValueOnce([
        {
          id: EXPENSE_ID,
          expense_no: 'EXP-2026-0002',
          amount: 100,
          category_id: CATEGORY,
          cashbox_id: CASHBOX,
          payment_method: 'cash',
          expense_date: '2026-05-05',
          employee_user_id: null,
          description: 'old desc',
          is_advance: false,
        },
      ]);
      // 3. accountingChanged is true (cashbox_id changed) → SELECT
      //    journal_entries — return no row so the void branch is
      //    skipped and the merged-validation runs next.
      em.query.mockResolvedValueOnce([]); // no live JE

      await expect(
        service.approveEditRequest(REQUEST_ID, ADMIN),
      ).rejects.toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);

      // No UPDATE expenses SET …, no engine repost.
      const updateCalls = em.query.mock.calls.filter((c) =>
        String(c[0]).includes('UPDATE expenses\n            SET category_id'),
      );
      expect(updateCalls).toHaveLength(0);
      expect(engine.recordExpense).not.toHaveBeenCalled();
    });
  });
});

/* ────────────────────────────────────────────────────────────────────
 * 3. ExpenseApprovalService.decide — multi-level approval terminal.
 * ──────────────────────────────────────────────────────────────────── */

describe('ExpenseApprovalService.decide — guard wire-in (PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD)', () => {
  let service: ExpenseApprovalService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let em: { query: jest.Mock };
  let engine: { recordExpense: jest.Mock };

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = { recordExpense: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpenseApprovalService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(ExpenseApprovalService);
  });

  it('throws BEFORE engine.recordExpense when stored expense is cash + null cashbox', async () => {
    // 1. SELECT expense_approvals FOR UPDATE.
    em.query.mockResolvedValueOnce([
      {
        id: APPROVAL_ID,
        expense_id: EXPENSE_ID,
        status: 'pending',
      },
    ]);
    // 2. UPDATE expense_approvals SET status='approved' …
    em.query.mockResolvedValueOnce([]);
    // 3. SELECT … GROUP BY status — all approved (pending=0, rejected=0).
    em.query.mockResolvedValueOnce([{ status: 'approved', n: 1 }]);
    // 4. UPDATE expenses SET is_approved = TRUE …
    em.query.mockResolvedValueOnce([]);
    // 5. SELECT exp + ec.account_id — returns the BAD combo.
    em.query.mockResolvedValueOnce([
      {
        id: EXPENSE_ID,
        expense_no: 'EXP-2026-0003',
        amount: 100,
        payment_method: 'cash',
        cashbox_id: null,
        category_account_id: 'acct-uuid',
      },
    ]);

    await expect(
      service.approve(APPROVAL_ID, ADMIN),
    ).rejects.toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);

    expect(engine.recordExpense).not.toHaveBeenCalled();
  });
});

/* ────────────────────────────────────────────────────────────────────
 * 4. RecurringExpensesService.runOne — template-time guard.
 * ──────────────────────────────────────────────────────────────────── */

describe('RecurringExpensesService.runOne — guard wire-in (PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD)', () => {
  let service: RecurringExpensesService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let em: { query: jest.Mock };
  let engine: { recordExpense: jest.Mock };

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = { recordExpense: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecurringExpensesService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(RecurringExpensesService);
  });

  it('throws when template has payment_method="cash" + cashbox_id=null (no INSERT, no autopost)', async () => {
    // Template lookup returns a bad-shape row.
    ds.query.mockResolvedValueOnce([
      {
        id: RECURRING_ID,
        status: 'active',
        next_run_date: '2020-01-01', // already due
        end_date: null,
        payment_method: 'cash',
        cashbox_id: null,
        category_id: CATEGORY,
        warehouse_id: WAREHOUSE,
        amount: 100,
        name_ar: 'إيجار',
        auto_post: true,
        require_approval: false,
        auto_paid: true,
      },
    ]);

    await expect(
      service.runOne(RECURRING_ID, ADMIN),
    ).rejects.toThrow(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);

    // No transaction was opened — guard fires before ds.transaction.
    expect(ds.transaction).not.toHaveBeenCalled();
    expect(engine.recordExpense).not.toHaveBeenCalled();
  });

  it('passes when template has cash + cashbox (guard does not block valid templates)', async () => {
    ds.query.mockResolvedValueOnce([
      {
        id: RECURRING_ID,
        status: 'active',
        next_run_date: '2020-01-01',
        end_date: null,
        payment_method: 'cash',
        cashbox_id: CASHBOX,
        category_id: CATEGORY,
        warehouse_id: WAREHOUSE,
        amount: 100,
        name_ar: 'إيجار',
        auto_post: false, // skip auto-post path so we don't need to stub the engine
        require_approval: true,
        auto_paid: false,
        frequency: 'monthly',
        day_of_month: 1,
        custom_interval_days: null,
        vendor_name: null,
        description: null,
      },
    ]);
    // Inside the transaction:
    //   1. SELECT category code → 'GEN'
    em.query.mockResolvedValueOnce([{ code: 'GEN' }]);
    //   2. INSERT expenses → returns id
    em.query.mockResolvedValueOnce([{ id: EXPENSE_ID }]);
    //   3. INSERT recurring_expense_runs
    em.query.mockResolvedValueOnce([]);
    //   4. SELECT fn_recurring_next_run → next_d
    em.query.mockResolvedValueOnce([{ next_d: '2020-02-01' }]);
    //   5. UPDATE recurring_expenses SET next_run_date …
    em.query.mockResolvedValueOnce([]);

    const out = await service.runOne(RECURRING_ID, ADMIN);
    expect(out).toMatchObject({ generated: true });
  });

  it('passes when template has bank + null cashbox (non-cash never blocked)', async () => {
    ds.query.mockResolvedValueOnce([
      {
        id: RECURRING_ID,
        status: 'active',
        next_run_date: '2020-01-01',
        end_date: null,
        payment_method: 'bank',
        cashbox_id: null,
        category_id: CATEGORY,
        warehouse_id: WAREHOUSE,
        amount: 100,
        name_ar: 'فاتورة كهرباء',
        auto_post: false,
        require_approval: true,
        auto_paid: false,
        frequency: 'monthly',
        day_of_month: 1,
        custom_interval_days: null,
        vendor_name: null,
        description: null,
      },
    ]);
    em.query.mockResolvedValueOnce([{ code: 'GEN' }]);
    em.query.mockResolvedValueOnce([{ id: EXPENSE_ID }]);
    em.query.mockResolvedValueOnce([]);
    em.query.mockResolvedValueOnce([{ next_d: '2020-02-01' }]);
    em.query.mockResolvedValueOnce([]);

    const out = await service.runOne(RECURRING_ID, ADMIN);
    expect(out).toMatchObject({ generated: true });
  });
});

/* ────────────────────────────────────────────────────────────────────
 * 5. Direct-cashbox advance (intentional shift_id=NULL flow) is
 *    unaffected — the existing PR-EMP-ADVANCE-PAY-1 source_type
 *    behavior keeps working because the guard checks only
 *    payment_method + cashbox_id, not shift_id.
 * ──────────────────────────────────────────────────────────────────── */

describe('direct-cashbox advance compatibility — PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD', () => {
  it('passes the helper for cash + cashbox + (shift_id NULL is irrelevant)', () => {
    // The guard is intentionally agnostic to shift_id. Production
    // currently has 2 such rows (EXP-2026-000034/35) — they have
    // cashbox_id set and would not be blocked.
    expect(() =>
      assertExpenseInvariants('cash', CASHBOX, 'create'),
    ).not.toThrow();
  });
});
