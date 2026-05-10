/**
 * recurring-expenses.v2.spec.ts — PR-A
 *
 * Pins the PR-A hardening on top of the existing v1 recurring
 * pipeline.  Three layers:
 *
 *   1. Behavioural — drive `runOne()` + `create()` + `update()`
 *      against a mock DataSource and a spy ExpenseApprovalService
 *      so we can assert:
 *        a. `spawnForExpense()` is called exactly once when
 *           require_approval=TRUE
 *        b. It is NOT called when require_approval=FALSE
 *        c. The engine is NOT called when require_approval=TRUE
 *           (expense waits in inbox; engine fires on approval)
 *        d. The engine IS called when auto_post=TRUE AND
 *           require_approval=FALSE
 *        e. `create()` rejects when auto_post=TRUE and the category
 *           has no `account_id`
 *        f. `create()` accepts when auto_post=FALSE even if mapping
 *           missing (operator may post manually later)
 *
 *   2. Source-grep invariants — the service file MUST NOT contain
 *      direct INSERT/UPDATE/DELETE against journal_entries,
 *      journal_lines, cashbox_transactions, stock_movements, or
 *      `accounting_only` escapes; all write paths MUST flow through
 *      `engine.recordExpense(...)`.
 *
 *   3. Module wiring — RecurringExpensesModule imports
 *      AccountingModule so ExpenseApprovalService is available as a
 *      singleton across the app.
 */

import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RecurringExpensesService } from './recurring-expenses.service';

// ─── Mocks ────────────────────────────────────────────────────────

interface MockCall {
  sql: string;
  params?: any[];
}

type Handler = (call: MockCall) => any[] | Promise<any[]>;

/**
 * Builds a DataSource mock that captures every SQL call (top-level
 * and inside `ds.transaction(em => …)`) into a shared `calls` array
 * and routes them through a single handler.  Mirrors the pattern
 * used by `financial-health.resolve.spec.ts`.
 */
function makeMockDs(handler: Handler) {
  const calls: MockCall[] = [];
  const em = {
    query: async (sql: string, params?: any[]) => {
      const call = { sql, params };
      calls.push(call);
      return await handler(call);
    },
  };
  const ds: any = {
    transaction: async <T,>(fn: (em: any) => Promise<T>): Promise<T> =>
      await fn(em),
    query: async (sql: string, params?: any[]) => {
      const call = { sql, params };
      calls.push(call);
      return await handler(call);
    },
  };
  return { ds, em, calls };
}

function findCall(calls: MockCall[], re: RegExp): MockCall | undefined {
  return calls.find((c) => re.test(c.sql));
}

function findAll(calls: MockCall[], re: RegExp): MockCall[] {
  return calls.filter((c) => re.test(c.sql));
}

// ─── Behavioural: runOne approval spawn ───────────────────────────

describe('RecurringExpensesService.runOne — approval spawn (PR-A)', () => {
  const TPL_ID = 'tpl-1';
  const USER_ID = 'user-1';

  function makeTemplate(overrides: Record<string, any> = {}) {
    return {
      id: TPL_ID,
      code: 'RENT-01',
      name_ar: 'إيجار',
      category_id: 'cat-1',
      warehouse_id: 'wh-1',
      cashbox_id: 'cb-1',
      amount: 5000,
      payment_method: 'cash',
      vendor_name: 'مالك العقار',
      description: null,
      frequency: 'monthly',
      day_of_month: 1,
      custom_interval_days: null,
      next_run_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), // yesterday → due
      end_date: null,
      auto_post: true,
      auto_paid: false,
      require_approval: false,
      status: 'active',
      ...overrides,
    };
  }

  function makeHandler(template: any) {
    return ({ sql }: MockCall): any[] => {
      // SELECT template
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [template];
      // SELECT expense_categories code (used to seed expense_no)
      if (/SELECT code FROM expense_categories/i.test(sql))
        return [{ code: 'RENT' }];
      // INSERT into expenses
      if (/INSERT INTO expenses/i.test(sql))
        return [{ id: 'new-exp-1' }];
      // INSERT into recurring_expense_runs
      if (/INSERT INTO recurring_expense_runs/i.test(sql))
        return [];
      // fn_recurring_next_run advance
      if (/fn_recurring_next_run/i.test(sql))
        return [{ next_d: '2026-06-01' }];
      // UPDATE recurring_expenses (advance last_run + next_run)
      if (/^UPDATE recurring_expenses SET[\s\S]+last_run_date/i.test(sql))
        return [];
      // SELECT account_id for engine path
      if (/SELECT account_id FROM expense_categories/i.test(sql))
        return [{ account_id: 'acc-529' }];
      return [];
    };
  }

  function makeEngineSpy() {
    return {
      recordExpense: jest.fn().mockResolvedValue({ ok: true }),
    } as any;
  }

  function makeApprovalSpy() {
    return {
      spawnForExpense: jest.fn().mockResolvedValue({ spawned: 2, rules: [] }),
    };
  }

  it('require_approval=TRUE → spawnForExpense is called exactly once, engine is NOT called', async () => {
    const tpl = makeTemplate({ require_approval: true, auto_post: true });
    const { ds } = makeMockDs(makeHandler(tpl));
    const engine = makeEngineSpy();
    const approvals = makeApprovalSpy();

    const svc = new RecurringExpensesService(ds, undefined, engine, approvals as any);
    const res = await svc.runOne(TPL_ID, USER_ID);

    expect(res).toMatchObject({ generated: true, expense_id: 'new-exp-1' });
    expect(approvals.spawnForExpense).toHaveBeenCalledTimes(1);
    expect(approvals.spawnForExpense).toHaveBeenCalledWith('new-exp-1', 5000, expect.anything());
    // Engine MUST NOT fire — the expense is waiting in the approval
    // inbox; engine.recordExpense() will be invoked by approval.decide()
    // once all levels approve.
    expect(engine.recordExpense).not.toHaveBeenCalled();
  });

  it('require_approval=FALSE + auto_post=TRUE → engine.recordExpense IS called, spawn is NOT', async () => {
    const tpl = makeTemplate({ require_approval: false, auto_post: true });
    const { ds } = makeMockDs(makeHandler(tpl));
    const engine = makeEngineSpy();
    const approvals = makeApprovalSpy();

    const svc = new RecurringExpensesService(ds, undefined, engine, approvals as any);
    await svc.runOne(TPL_ID, USER_ID);

    expect(approvals.spawnForExpense).not.toHaveBeenCalled();
    expect(engine.recordExpense).toHaveBeenCalledTimes(1);
    expect(engine.recordExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        expense_id: 'new-exp-1',
        amount: 5000,
        category_account_id: 'acc-529',
        user_id: USER_ID,
      }),
    );
  });

  it('require_approval=TRUE + auto_post=FALSE → expense inserted, spawn called once, no engine', async () => {
    const tpl = makeTemplate({ require_approval: true, auto_post: false });
    const { ds } = makeMockDs(makeHandler(tpl));
    const engine = makeEngineSpy();
    const approvals = makeApprovalSpy();

    const svc = new RecurringExpensesService(ds, undefined, engine, approvals as any);
    await svc.runOne(TPL_ID, USER_ID);

    expect(approvals.spawnForExpense).toHaveBeenCalledTimes(1);
    expect(engine.recordExpense).not.toHaveBeenCalled();
  });

  it('spawnForExpense receives the EntityManager (same transaction) — not the bare DataSource', async () => {
    const tpl = makeTemplate({ require_approval: true });
    const { ds, em } = makeMockDs(makeHandler(tpl));
    const engine = makeEngineSpy();
    const approvals = makeApprovalSpy();

    const svc = new RecurringExpensesService(ds, undefined, engine, approvals as any);
    await svc.runOne(TPL_ID, USER_ID);

    // Third arg of spawnForExpense should be the `em` object — proof
    // that the spawn participates in the same transaction as the
    // expense INSERT.  If the transaction rolls back, the spawned
    // expense_approvals rows roll back too.
    const thirdArg = approvals.spawnForExpense.mock.calls[0]![2];
    expect(thirdArg).toBe(em);
  });

  it('when approvals provider is undefined, runOne still succeeds (graceful degradation)', async () => {
    const tpl = makeTemplate({ require_approval: true });
    const { ds } = makeMockDs(makeHandler(tpl));
    const engine = makeEngineSpy();

    // No approvals injected — simulate a minimal-module bootstrap.
    const svc = new RecurringExpensesService(ds, undefined, engine);
    const res = await svc.runOne(TPL_ID, USER_ID);

    expect(res).toMatchObject({ generated: true });
    // Engine still NOT called (because require_approval=true).
    expect(engine.recordExpense).not.toHaveBeenCalled();
  });

  it('dry-run does NOT spawn approvals (no expense was created)', async () => {
    const tpl = makeTemplate({ require_approval: true });
    const { ds } = makeMockDs(makeHandler(tpl));
    const engine = makeEngineSpy();
    const approvals = makeApprovalSpy();

    const svc = new RecurringExpensesService(ds, undefined, engine, approvals as any);
    const res = await svc.runOne(TPL_ID, USER_ID, { dryRun: true });

    expect(res).toMatchObject({ generated: false, reason: 'dry-run' });
    expect(approvals.spawnForExpense).not.toHaveBeenCalled();
  });
});

// ─── Behavioural: auto_post category-GL validation ────────────────

describe('RecurringExpensesService.create — auto_post category-GL validation (PR-A)', () => {
  const USER_ID = 'user-1';

  const baseDto = {
    code: 'RENT-01',
    name_ar: 'إيجار',
    category_id: 'cat-1',
    warehouse_id: 'wh-1',
    amount: 5000,
    frequency: 'monthly' as const,
    start_date: '2026-05-01',
  };

  function makeCategoryHandler(account_id: string | null) {
    return ({ sql }: MockCall): any[] => {
      if (/SELECT id, account_id FROM expense_categories WHERE id = \$1/i.test(sql))
        return [{ id: 'cat-1', account_id }];
      if (/INSERT INTO recurring_expenses/i.test(sql))
        return [{ id: 'new-tpl-1', ...baseDto, auto_post: true }];
      return [];
    };
  }

  it('rejects when auto_post=TRUE and the category has NULL account_id', async () => {
    const { ds } = makeMockDs(makeCategoryHandler(null));
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create({ ...baseDto, auto_post: true }, USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create({ ...baseDto, auto_post: true }, USER_ID),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/حساب محاسبي مرتبط/),
    });
  });

  it('rejects when auto_post is unset (defaults TRUE) and the category has NULL account_id', async () => {
    const { ds } = makeMockDs(makeCategoryHandler(null));
    const svc = new RecurringExpensesService(ds);
    // auto_post omitted → service default is TRUE → guard still fires
    await expect(svc.create(baseDto, USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts when auto_post=FALSE even if the category has NULL account_id', async () => {
    const { ds } = makeMockDs(makeCategoryHandler(null));
    const svc = new RecurringExpensesService(ds);
    const out = await svc.create({ ...baseDto, auto_post: false }, USER_ID);
    expect(out).toMatchObject({ id: 'new-tpl-1' });
  });

  it('accepts when auto_post=TRUE and the category has a valid account_id', async () => {
    const { ds } = makeMockDs(makeCategoryHandler('acc-529'));
    const svc = new RecurringExpensesService(ds);
    const out = await svc.create({ ...baseDto, auto_post: true }, USER_ID);
    expect(out).toMatchObject({ id: 'new-tpl-1' });
  });

  it('rejects when the category does not exist at all', async () => {
    const { ds } = makeMockDs(({ sql }) => {
      if (/SELECT id, account_id FROM expense_categories/i.test(sql)) return [];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create({ ...baseDto, auto_post: true }, USER_ID),
    ).rejects.toMatchObject({
      message: 'فئة المصروف غير موجودة.',
    });
  });
});

describe('RecurringExpensesService.update — auto_post category-GL validation (PR-A)', () => {
  it('rejects an update that flips auto_post=TRUE when category has no GL mapping', async () => {
    const existing = {
      id: 'tpl-X',
      auto_post: false,
      category_id: 'cat-broken',
    };
    const { ds } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/SELECT id, account_id FROM expense_categories/i.test(sql))
        return [{ id: 'cat-broken', account_id: null }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.update('tpl-X', { auto_post: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an update that changes the category when auto_post is already TRUE and the new category has no GL mapping', async () => {
    const existing = {
      id: 'tpl-Y',
      auto_post: true,
      category_id: 'cat-old-good',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/SELECT id, account_id FROM expense_categories/i.test(sql))
        return [{ id: 'cat-new-broken', account_id: null }];
      if (/^UPDATE recurring_expenses SET/i.test(sql)) return [existing];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.update('tpl-Y', { category_id: 'cat-new-broken' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The UPDATE statement must NOT have fired.
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(0);
  });

  it('skips the validation when auto_post is unchanged AND category is unchanged', async () => {
    // e.g. operator just bumps `amount` — no GL revalidation needed.
    const existing = {
      id: 'tpl-Z',
      auto_post: true,
      category_id: 'cat-good',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/^UPDATE recurring_expenses SET/i.test(sql))
        return [{ ...existing, amount: 7000 }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    const out = await svc.update('tpl-Z', { amount: 7000 });
    expect(out).toMatchObject({ amount: 7000 });
    // No SELECT against expense_categories.account_id — validation
    // was skipped because neither auto_post nor category_id changed.
    expect(
      findAll(calls, /SELECT id, account_id FROM expense_categories/i),
    ).toHaveLength(0);
  });
});

// ─── Source-grep: write-surface invariants ────────────────────────

describe('recurring-expenses.service.ts — write-surface invariants (PR-A)', () => {
  const SRC = readFileSync(
    resolve(__dirname, './recurring-expenses.service.ts'),
    'utf-8',
  );
  // Strip block + line comments before grepping for forbidden write
  // patterns; comments may cite the bad patterns as examples and we
  // don't want them to trip the guard.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('does NOT write to journal_entries / journal_lines anywhere', () => {
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+journal_entries\\b`, 'i'));
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+journal_lines\\b`, 'i'));
    }
  });

  it('does NOT write to cashbox_transactions / stock_movements anywhere', () => {
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+cashbox_transactions\\b`, 'i'));
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+stock_movements\\b`, 'i'));
    }
  });

  it('does NOT directly UPDATE cashboxes balance (engine is the single writer)', () => {
    expect(CODE).not.toMatch(/UPDATE\s+cashboxes\b/i);
  });

  it('does NOT use the accounting_only escape hatch', () => {
    expect(CODE).not.toMatch(/\baccounting_only\b/);
  });

  it('routes auto-posting through engine.recordExpense (the canonical write path)', () => {
    expect(CODE).toMatch(/this\.engine\.recordExpense\s*\(/);
  });

  it('spawns expense_approvals via approval service, not by direct SQL', () => {
    expect(CODE).toMatch(/this\.approvals\.spawnForExpense\s*\(/);
    // No direct INSERT INTO expense_approvals from this file.
    expect(CODE).not.toMatch(/INSERT\s+INTO\s+expense_approvals\b/i);
  });

  it('asserts cashbox invariants BEFORE any expenses INSERT (defence in depth)', () => {
    expect(CODE).toMatch(/assertExpenseInvariants\s*\(/);
  });
});

// ─── Module wiring ────────────────────────────────────────────────

describe('RecurringExpensesModule — wiring (PR-A)', () => {
  const MODULE_SRC = readFileSync(
    resolve(__dirname, './recurring-expenses.module.ts'),
    'utf-8',
  );

  it('imports AccountingModule so ExpenseApprovalService is a singleton', () => {
    expect(MODULE_SRC).toMatch(/from\s+['"]\.\.\/accounting\/accounting\.module['"]/);
    expect(MODULE_SRC).toMatch(/imports\s*:\s*\[\s*AccountingModule\s*\]/);
  });
});
