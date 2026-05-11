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

  // PR-A2 — these tests target the GL-mapping guard.  Set
  // payment_method='card_visa' (a real enum value) so the cashbox-
  // invariant guard (which fires before the GL guard for cash defaults)
  // does not interfere.  PR-A2-FIX additionally tightened the
  // payment-method whitelist so the legacy 'card' literal would now
  // be rejected too.
  const baseDto = {
    code: 'RENT-01',
    name_ar: 'إيجار',
    category_id: 'cat-1',
    warehouse_id: 'wh-1',
    amount: 5000,
    payment_method: 'card_visa',
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

// ─── Behavioural: payment_method whitelist (PR-A2-FIX) ────────────

describe('RecurringExpensesService — payment_method enum guard (PR-A2-FIX)', () => {
  const USER_ID = 'user-pm';

  const baseDto = {
    code: 'PM-01',
    name_ar: 'اشتراك',
    category_id: 'cat-1',
    warehouse_id: 'wh-1',
    amount: 100,
    frequency: 'monthly' as const,
    start_date: '2026-05-01',
    auto_post: false, // skip GL-mapping check
  };

  function makeHandler() {
    return ({ sql }: MockCall): any[] => {
      if (/SELECT id, account_id FROM expense_categories WHERE id = \$1/i.test(sql))
        return [{ id: 'cat-1', account_id: 'acc-1' }];
      if (/INSERT INTO recurring_expenses/i.test(sql))
        return [{ id: 'new-tpl-pm', ...baseDto }];
      return [];
    };
  }

  it('rejects payment_method="card" with Arabic 400 (the original screenshot bug)', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create(
        { ...baseDto, payment_method: 'card', cashbox_id: undefined },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(
        { ...baseDto, payment_method: 'card', cashbox_id: undefined },
        USER_ID,
      ),
    ).rejects.toMatchObject({ message: 'طريقة الدفع غير مدعومة.' });
  });

  it('rejects any out-of-enum payment_method before INSERT (no PG round-trip)', async () => {
    const { ds, calls } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create(
        { ...baseDto, payment_method: 'crypto', cashbox_id: undefined },
        USER_ID,
      ),
    ).rejects.toMatchObject({ message: 'طريقة الدفع غير مدعومة.' });
    // No INSERT was attempted — proves the guard fires upstream.
    expect(findAll(calls, /INSERT INTO recurring_expenses/i)).toHaveLength(0);
  });

  it('accepts each documented enum value', async () => {
    const goodValues = [
      'cash',
      'card_visa',
      'card_mastercard',
      'card_meeza',
      'instapay',
      'vodafone_cash',
      'orange_cash',
      'wallet',
      'bank_transfer',
      'credit',
      'other',
    ];
    for (const pm of goodValues) {
      const { ds } = makeMockDs(makeHandler());
      const svc = new RecurringExpensesService(ds);
      // PR-F-3 — cash also requires auto_paid=true; other methods are
      // valid with either flag.
      const out = await svc.create(
        {
          ...baseDto,
          payment_method: pm,
          cashbox_id: pm === 'cash' ? 'cb-MAIN' : undefined,
          ...(pm === 'cash' ? { auto_paid: true } : {}),
        },
        USER_ID,
      );
      expect(out).toMatchObject({ id: 'new-tpl-pm' });
    }
  });

  it('accepts null/undefined payment_method (DB default cash applies — but caller must supply auto_paid=true to satisfy F-3)', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    // payment_method omitted entirely → cash default → also needs
    // cashbox AND PR-F-3 needs auto_paid=true.
    const out = await svc.create(
      { ...baseDto, cashbox_id: 'cb-MAIN', auto_paid: true },
      USER_ID,
    );
    expect(out).toMatchObject({ id: 'new-tpl-pm' });
  });

  it('update() with payment_method="card" rejects before UPDATE fires', async () => {
    const existing = {
      id: 'tpl-PM',
      payment_method: 'cash',
      cashbox_id: 'cb-MAIN',
      auto_post: false,
      category_id: 'cat-1',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.update('tpl-PM', { payment_method: 'card' }),
    ).rejects.toMatchObject({ message: 'طريقة الدفع غير مدعومة.' });
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(0);
  });

  it('update() that omits payment_method skips the whitelist check', async () => {
    const existing = {
      id: 'tpl-PM2',
      payment_method: 'cash',
      cashbox_id: 'cb-MAIN',
      auto_post: false,
      category_id: 'cat-1',
    };
    const { ds } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/^UPDATE recurring_expenses SET/i.test(sql))
        return [{ ...existing, amount: 200 }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    const out = await svc.update('tpl-PM2', { amount: 200 });
    expect(out).toMatchObject({ amount: 200 });
  });
});

// ─── Behavioural: cashbox invariant on create/update (PR-A2) ──────

describe('RecurringExpensesService.create — cashbox invariant (PR-A2)', () => {
  const USER_ID = 'user-A2';

  const baseDto = {
    code: 'CB-01',
    name_ar: 'إيجار',
    category_id: 'cat-1',
    warehouse_id: 'wh-1',
    amount: 5000,
    frequency: 'monthly' as const,
    start_date: '2026-05-01',
  };

  function makeHandler(catAccountId: string | null = 'acc-529') {
    return ({ sql }: MockCall): any[] => {
      if (/SELECT id, account_id FROM expense_categories WHERE id = \$1/i.test(sql))
        return [{ id: 'cat-1', account_id: catAccountId }];
      if (/INSERT INTO recurring_expenses/i.test(sql))
        return [{ id: 'new-tpl-1', ...baseDto }];
      return [];
    };
  }

  it('rejects cash + null cashbox_id', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create({ ...baseDto, payment_method: 'cash', cashbox_id: undefined }, USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create({ ...baseDto, payment_method: 'cash', cashbox_id: undefined }, USER_ID),
    ).rejects.toMatchObject({
      message: 'الخزنة مطلوبة عند اختيار الدفع النقدي للمصروف الدوري.',
    });
  });

  it('rejects when payment_method is omitted (defaults to cash) and cashbox is missing', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    await expect(svc.create(baseDto, USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts cash + cashbox_id + auto_paid=true', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    // PR-F-3 — cash now also requires auto_paid=true (a cash template
    // without auto-deduction is internally meaningless).
    const out = await svc.create(
      {
        ...baseDto,
        payment_method: 'cash',
        cashbox_id: 'cb-MAIN',
        auto_paid: true,
      },
      USER_ID,
    );
    expect(out).toMatchObject({ id: 'new-tpl-1' });
  });

  it('accepts non-cash (card_visa) without cashbox_id', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    const out = await svc.create(
      { ...baseDto, payment_method: 'card_visa', cashbox_id: undefined },
      USER_ID,
    );
    expect(out).toMatchObject({ id: 'new-tpl-1' });
  });

  it('cashbox invariant fires BEFORE the GL-mapping check (template never INSERTed when cash+null)', async () => {
    const { ds, calls } = makeMockDs(makeHandler(null));
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create(
        { ...baseDto, payment_method: 'cash', cashbox_id: undefined, auto_post: true },
        USER_ID,
      ),
    ).rejects.toMatchObject({
      message: 'الخزنة مطلوبة عند اختيار الدفع النقدي للمصروف الدوري.',
    });
    // No SELECT against the categories table — cashbox guard short-
    // circuited before the GL-mapping helper was reached.
    expect(
      findAll(calls, /SELECT id, account_id FROM expense_categories/i),
    ).toHaveLength(0);
    expect(findAll(calls, /INSERT INTO recurring_expenses/i)).toHaveLength(0);
  });
});

describe('RecurringExpensesService.update — cashbox invariant (PR-A2)', () => {
  it('rejects update that flips payment_method to cash when no cashbox is set', async () => {
    const existing = {
      id: 'tpl-A2',
      payment_method: 'card_visa',
      cashbox_id: null,
      auto_post: false,
      category_id: 'cat-1',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.update('tpl-A2', { payment_method: 'cash' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // No UPDATE issued.
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(0);
  });

  it('accepts update that flips payment_method to cash + sets cashbox_id + sets auto_paid=true', async () => {
    const existing = {
      id: 'tpl-A2b',
      payment_method: 'card_visa',
      cashbox_id: null,
      auto_post: false,
      auto_paid: false,
      category_id: 'cat-1',
    };
    const { ds } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/^UPDATE recurring_expenses SET/i.test(sql))
        return [{
          ...existing,
          payment_method: 'cash',
          cashbox_id: 'cb-MAIN',
          auto_paid: true,
        }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    // PR-F-3 — flipping to cash must come with `auto_paid: true` in
    // the same call or the behaviour-consistency guard rejects.
    const out = await svc.update('tpl-A2b', {
      payment_method: 'cash',
      cashbox_id: 'cb-MAIN',
      auto_paid: true,
    });
    expect(out).toMatchObject({
      payment_method: 'cash',
      cashbox_id: 'cb-MAIN',
      auto_paid: true,
    });
  });

  it('accepts update from cash → card_visa without cashbox (cashbox no longer required)', async () => {
    const existing = {
      id: 'tpl-A2c',
      payment_method: 'cash',
      cashbox_id: 'cb-old',
      auto_post: false,
      category_id: 'cat-1',
    };
    const { ds } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/^UPDATE recurring_expenses SET/i.test(sql))
        return [{ ...existing, payment_method: 'card_visa' }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    const out = await svc.update('tpl-A2c', { payment_method: 'card_visa' });
    expect(out).toMatchObject({ payment_method: 'card_visa' });
  });

  it('rejects update that drops cashbox_id while payment_method stays cash', async () => {
    const existing = {
      id: 'tpl-A2d',
      payment_method: 'cash',
      cashbox_id: 'cb-MAIN',
      auto_post: false,
      category_id: 'cat-1',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.update('tpl-A2d', { cashbox_id: null as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(0);
  });

  it('skips the cashbox check when neither payment_method nor cashbox_id is in the DTO', async () => {
    // Editing an unrelated field (e.g. amount) on a row that happens
    // to be misconfigured shouldn't suddenly start failing.  The
    // pre-existing row was accepted under the older rules; this
    // PR only validates NEW changes that touch the cashbox semantics.
    const existing = {
      id: 'tpl-A2e',
      payment_method: 'cash',
      cashbox_id: null, // legacy bad row
      auto_post: false,
      category_id: 'cat-1',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/^UPDATE recurring_expenses SET/i.test(sql))
        return [{ ...existing, amount: 7000 }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    const out = await svc.update('tpl-A2e', { amount: 7000 });
    expect(out).toMatchObject({ amount: 7000 });
    // UPDATE did fire — proves we did NOT short-circuit on the
    // legacy bad row.
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(1);
  });
});

// ─── Behavioural: PR-F-3 behaviour-consistency guard ──────────────

describe('RecurringExpensesService — behaviour consistency (cash ↔ auto_paid) — PR-F-3', () => {
  const USER_ID = 'user-f3';

  const baseDto = {
    code: 'F3-01',
    name_ar: 'اختبار سلوك',
    category_id: 'cat-1',
    warehouse_id: 'wh-1',
    amount: 500,
    frequency: 'monthly' as const,
    start_date: '2026-05-11',
    auto_post: false, // skip GL-mapping check
  };

  function makeHandler() {
    return ({ sql }: MockCall): any[] => {
      if (/SELECT id, account_id FROM expense_categories WHERE id = \$1/i.test(sql))
        return [{ id: 'cat-1', account_id: 'acc-1' }];
      if (/INSERT INTO recurring_expenses/i.test(sql))
        return [{ id: 'new-tpl-f3', ...baseDto }];
      return [];
    };
  }

  // ─── create() rejections ─────────────────────────────────────────

  it('rejects cash + explicit auto_paid=false at create()', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create(
        {
          ...baseDto,
          payment_method: 'cash',
          cashbox_id: 'cb-MAIN',
          auto_paid: false,
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(
        {
          ...baseDto,
          payment_method: 'cash',
          cashbox_id: 'cb-MAIN',
          auto_paid: false,
        },
        USER_ID,
      ),
    ).rejects.toMatchObject({
      message:
        'سلوك التوليد غير متناغم: لا يمكن تسجيل مصروف نقدي بدون خصم تلقائي من الخزنة.',
    });
  });

  it('rejects cash + auto_paid omitted (defaults to false at DB) at create()', async () => {
    const { ds, calls } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create(
        {
          ...baseDto,
          payment_method: 'cash',
          cashbox_id: 'cb-MAIN',
          // auto_paid intentionally omitted → undefined → treated as false
        },
        USER_ID,
      ),
    ).rejects.toMatchObject({
      message:
        'سلوك التوليد غير متناغم: لا يمكن تسجيل مصروف نقدي بدون خصم تلقائي من الخزنة.',
    });
    // No INSERT — guard fires before the DB write.
    expect(findAll(calls, /INSERT INTO recurring_expenses/i)).toHaveLength(0);
  });

  // ─── create() acceptances ────────────────────────────────────────

  it('accepts cash + auto_paid=true + cashbox at create()', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    const out = await svc.create(
      {
        ...baseDto,
        payment_method: 'cash',
        cashbox_id: 'cb-MAIN',
        auto_paid: true,
      },
      USER_ID,
    );
    expect(out).toMatchObject({ id: 'new-tpl-f3' });
  });

  it('accepts card_visa + auto_paid=false at create() (non-cash AP path)', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    const out = await svc.create(
      {
        ...baseDto,
        payment_method: 'card_visa',
        cashbox_id: undefined,
        auto_paid: false,
      },
      USER_ID,
    );
    expect(out).toMatchObject({ id: 'new-tpl-f3' });
  });

  it('accepts card_visa + auto_paid=true (functionally a no-op for non-cash, but valid)', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    const out = await svc.create(
      {
        ...baseDto,
        payment_method: 'card_visa',
        cashbox_id: undefined,
        auto_paid: true,
      },
      USER_ID,
    );
    expect(out).toMatchObject({ id: 'new-tpl-f3' });
  });

  // ─── ordering vs. other guards ───────────────────────────────────

  it('cashbox-required guard fires BEFORE the behaviour-consistency guard (cash + no cashbox + no auto_paid)', async () => {
    const { ds } = makeMockDs(makeHandler());
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.create(
        {
          ...baseDto,
          payment_method: 'cash',
          cashbox_id: undefined,
          auto_paid: false,
        },
        USER_ID,
      ),
    ).rejects.toMatchObject({
      // The cashbox guard's message takes precedence.
      message: 'الخزنة مطلوبة عند اختيار الدفع النقدي للمصروف الدوري.',
    });
  });

  // ─── update() flows ──────────────────────────────────────────────

  it('rejects update that flips card_visa/auto_paid=false → cash without setting auto_paid=true', async () => {
    const existing = {
      id: 'tpl-F3-flip',
      payment_method: 'card_visa',
      cashbox_id: null,
      auto_post: false,
      auto_paid: false,
      category_id: 'cat-1',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.update('tpl-F3-flip', {
        payment_method: 'cash',
        cashbox_id: 'cb-MAIN',
        // auto_paid intentionally omitted → effPaid falls back to
        // cur.auto_paid=false → rejected by behaviour guard.
      }),
    ).rejects.toMatchObject({
      message:
        'سلوك التوليد غير متناغم: لا يمكن تسجيل مصروف نقدي بدون خصم تلقائي من الخزنة.',
    });
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(0);
  });

  it('rejects update that flips a cash/auto_paid=true row to auto_paid=false', async () => {
    const existing = {
      id: 'tpl-F3-drop',
      payment_method: 'cash',
      cashbox_id: 'cb-MAIN',
      auto_post: true,
      auto_paid: true,
      category_id: 'cat-1',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    await expect(
      svc.update('tpl-F3-drop', { auto_paid: false }),
    ).rejects.toMatchObject({
      message:
        'سلوك التوليد غير متناغم: لا يمكن تسجيل مصروف نقدي بدون خصم تلقائي من الخزنة.',
    });
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(0);
  });

  it('accepts update that flips cash → card_visa without auto_paid changes (non-cash → no longer needs auto_paid=true)', async () => {
    const existing = {
      id: 'tpl-F3-back',
      payment_method: 'cash',
      cashbox_id: 'cb-MAIN',
      auto_post: true,
      auto_paid: true,
      category_id: 'cat-1',
    };
    const { ds } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/^UPDATE recurring_expenses SET/i.test(sql))
        return [{ ...existing, payment_method: 'card_visa' }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    const out = await svc.update('tpl-F3-back', { payment_method: 'card_visa' });
    expect(out).toMatchObject({ payment_method: 'card_visa' });
  });

  it('amount-only update on a legacy bad row does NOT re-trigger the behaviour guard', async () => {
    // A row that was saved BEFORE PR-F-3 with cash + auto_paid=false
    // exists in production (the smoke-test bad B row).  Bumping an
    // unrelated field shouldn't force the operator to also fix the
    // behaviour combo in the same call.
    const existing = {
      id: 'tpl-F3-legacy',
      payment_method: 'cash',
      cashbox_id: 'cb-OLD',
      auto_post: true,
      auto_paid: false,
      category_id: 'cat-1',
    };
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (/^SELECT \* FROM recurring_expenses WHERE id = \$1/i.test(sql))
        return [existing];
      if (/^UPDATE recurring_expenses SET/i.test(sql))
        return [{ ...existing, amount: 1234 }];
      return [];
    });
    const svc = new RecurringExpensesService(ds);
    const out = await svc.update('tpl-F3-legacy', { amount: 1234 });
    expect(out).toMatchObject({ amount: 1234 });
    // UPDATE fired — no spurious re-validation rejection.
    expect(findAll(calls, /^UPDATE recurring_expenses SET/i)).toHaveLength(1);
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
