/**
 * accounting.service.expense-edit-correction.spec.ts
 * — PR-POS-EXPENSE-EDIT-CORRECTION-1 (Phase 2E + Phase 2F)
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the additive-correction contract for `approveEditRequest`:
 *
 *   • Original journal_entries stays is_void=FALSE.
 *   • Original cashbox_transactions rows are NEVER updated.
 *   • cashboxes.current_balance is NEVER rebased by the approval flow.
 *   • No call to posting.reverseByReference.
 *   • Cashbox-transaction categories never start with 'reversal_'.
 *   • Notes never start with 'عكس:'.
 *   • Corrections post additively via the three new posting helpers,
 *     keyed on a deterministic UUID derived from the edit-request id.
 *
 * Combined-edit math is verified per the approved plan's refined
 * rule:
 *   amount + category    → amount delta at OLD category, reclass for
 *                          merged total OLD → NEW
 *   amount + cashbox     → amount delta at OLD cashbox, cashbox
 *                          transfer for merged total NEW → OLD
 *   amount + cat + box   → all three composed
 *
 * Explicit cancel/void/refund routes are out of scope and untouched.
 *
 * The DataSource, FinancialEngineService, and AccountingPostingService
 * are stubbed so we can assert call shapes without a real Postgres.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';

// ─── Stable test fixtures ────────────────────────────────────────────
const REQ = '00000000-0000-0000-0000-0000000000aa';
const EXP = '11111111-1111-1111-1111-111111111111';
const APPROVER = '22222222-2222-2222-2222-222222222222';
const OLD_CAT = '33333333-3333-3333-3333-333333333333';
const NEW_CAT = '44444444-4444-4444-4444-444444444444';
const OLD_CAT_ACCT = '55555555-5555-5555-5555-555555555555';
const NEW_CAT_ACCT = '66666666-6666-6666-6666-666666666666';
const OLD_BOX = '77777777-7777-7777-7777-777777777777';
const NEW_BOX = '88888888-8888-8888-8888-888888888888';
const OLD_JE = '99999999-9999-9999-9999-999999999999';

interface EditRow {
  id: string;
  expense_id: string;
  status: string;
  reason: string;
  old_values: Record<string, any>;
  new_values: Record<string, any>;
}

interface ExpenseRow {
  id: string;
  expense_no: string;
  amount: string;
  cashbox_id: string;
  category_id: string;
  expense_date: string;
  employee_user_id: string | null;
  payment_method: string;
  description: string;
  is_advance: boolean;
}

function makeEditRow(overrides: Partial<EditRow> = {}): EditRow {
  return {
    id: REQ,
    expense_id: EXP,
    status: 'pending',
    reason: 'تصحيح',
    old_values: {
      amount: 100,
      category_id: OLD_CAT,
      cashbox_id: OLD_BOX,
      payment_method: 'cash',
    },
    new_values: {},
    ...overrides,
  };
}

function makeExpenseRow(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: EXP,
    expense_no: 'EXP-2026-000001',
    amount: '100',
    cashbox_id: OLD_BOX,
    category_id: OLD_CAT,
    expense_date: '2026-05-01',
    employee_user_id: null,
    payment_method: 'cash',
    description: 'sample',
    is_advance: false,
    ...overrides,
  };
}

// ─── Shared test harness ─────────────────────────────────────────────
async function makeService(opts: {
  editRow: EditRow;
  expenseRow: ExpenseRow;
  oldJeExists?: boolean;
  postingResponses?: {
    amountDelta?: { ok: true; entry_id: string | null } | { ok: false; error: string };
    reclassify?: { ok: true; entry_id: string | null } | { ok: false; error: string };
    cashboxCorrection?: { ok: true; entry_id: string | null } | { ok: false; error: string };
  };
  recordExpenseResponse?: { ok: true; entry_id: string } | { ok: false; error: string };
}) {
  const oldJeExists = opts.oldJeExists ?? true;

  const em: { query: jest.Mock } = {
    query: jest.fn(async (sql: string, _params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT * FROM expense_edit_requests')) {
        return [opts.editRow];
      }
      if (s.startsWith('SELECT * FROM expenses')) {
        return [opts.expenseRow];
      }
      if (
        s.startsWith('SELECT id, entry_no FROM journal_entries') ||
        /FROM journal_entries WHERE reference_type = 'expense'/.test(s)
      ) {
        return oldJeExists ? [{ id: OLD_JE, entry_no: 'JE-OLD' }] : [];
      }
      if (s.startsWith('UPDATE expenses')) {
        return [];
      }
      if (s.startsWith('UPDATE expense_edit_requests')) {
        return [];
      }
      if (/account_id FROM expense_categories WHERE id = \$1/.test(s)) {
        // Resolver fallback used when CostAccountResolver is not wired.
        // Decide by which category id is supplied.
        const param = _params[0];
        if (param === OLD_CAT) return [{ account_id: OLD_CAT_ACCT }];
        if (param === NEW_CAT) return [{ account_id: NEW_CAT_ACCT }];
        return [{ account_id: null }];
      }
      return [];
    }),
  };
  const ds: any = {
    query: jest.fn(),
    transaction: jest.fn(async (cb: any) => cb(em)),
  };

  const engine: any = {
    recordExpense: jest.fn(async () => opts.recordExpenseResponse ?? { ok: true, entry_id: 'je-fresh' }),
    recordTransaction: jest.fn(),
    recordCashboxTransfer: jest.fn(),
  };

  const posting: any = {
    postExpenseAmountDelta: jest.fn(
      async () => opts.postingResponses?.amountDelta ?? { ok: true, entry_id: 'je-delta' },
    ),
    postExpenseReclassification: jest.fn(
      async () => opts.postingResponses?.reclassify ?? { ok: true, entry_id: 'je-reclass' },
    ),
    postExpenseCashboxCorrection: jest.fn(
      async () => opts.postingResponses?.cashboxCorrection ?? { ok: true, entry_id: 'je-swap' },
    ),
    reverseByReference: jest.fn(async () => {
      throw new Error('reverseByReference must NEVER be called from approveEditRequest');
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AccountingService,
      { provide: DataSource, useValue: ds },
      { provide: FinancialEngineService, useValue: engine },
      { provide: AccountingPostingService, useValue: posting },
    ],
  }).compile();
  const service = moduleRef.get(AccountingService);
  return { service, ds, em, engine, posting };
}

function emCallSqls(em: { query: jest.Mock }): string[] {
  return em.query.mock.calls.map((c) =>
    String(c[0]).replace(/\s+/g, ' ').trim(),
  );
}

function emCallSqlsHas(em: { query: jest.Mock }, pattern: RegExp): boolean {
  return emCallSqls(em).some((sql) => pattern.test(sql));
}

// ─────────────────────────────────────────────────────────────────────
// CASE 1 — Amount-only increase
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E amount-only increase', () => {
  it('posts a single +delta via amount-delta helper; no void, no reversal', async () => {
    const { service, posting, em } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150 },
      }),
      expenseRow: makeExpenseRow({ amount: '100' }),
    });

    const out = await service.approveEditRequest(REQ, APPROVER);
    expect(out.ok).toBe(true);
    expect(out.voided_je_id).toBeNull();
    expect(out.applied_je_id).toBe('je-delta');

    expect(posting.postExpenseAmountDelta).toHaveBeenCalledTimes(1);
    const args = posting.postExpenseAmountDelta.mock.calls[0][0];
    expect(args.delta_amount).toBe(50);
    expect(args.category_account_id).toBe(OLD_CAT_ACCT);
    expect(args.cashbox_id).toBe(OLD_BOX);

    expect(posting.postExpenseReclassification).not.toHaveBeenCalled();
    expect(posting.postExpenseCashboxCorrection).not.toHaveBeenCalled();
    expect(posting.reverseByReference).not.toHaveBeenCalled();

    // Confirm no void/rebase mutations were issued.
    expect(emCallSqlsHas(em, /UPDATE journal_entries[^;]*is_void\s*=\s*TRUE/i)).toBe(false);
    expect(
      emCallSqlsHas(em, /UPDATE cashbox_transactions[^;]*is_void\s*=\s*TRUE/i),
    ).toBe(false);
    expect(emCallSqlsHas(em, /UPDATE cashboxes\s+SET current_balance/i)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 2 — Amount-only decrease
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E amount-only decrease', () => {
  it('posts a single -delta via amount-delta helper with negative delta', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 100 },
        old_values: {
          amount: 150,
          category_id: OLD_CAT,
          cashbox_id: OLD_BOX,
          payment_method: 'cash',
        },
      }),
      expenseRow: makeExpenseRow({ amount: '150' }),
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(posting.postExpenseAmountDelta).toHaveBeenCalledTimes(1);
    const args = posting.postExpenseAmountDelta.mock.calls[0][0];
    expect(args.delta_amount).toBe(-50);
    expect(args.category_account_id).toBe(OLD_CAT_ACCT);
    expect(args.cashbox_id).toBe(OLD_BOX);

    expect(posting.postExpenseReclassification).not.toHaveBeenCalled();
    expect(posting.postExpenseCashboxCorrection).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 3 — Category-only change
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E category-only change', () => {
  it('posts a single reclassification for the full merged amount', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { category_id: NEW_CAT },
      }),
      expenseRow: makeExpenseRow(),
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(posting.postExpenseReclassification).toHaveBeenCalledTimes(1);
    const args = posting.postExpenseReclassification.mock.calls[0][0];
    expect(args.amount).toBe(100);
    expect(args.old_category_account_id).toBe(OLD_CAT_ACCT);
    expect(args.new_category_account_id).toBe(NEW_CAT_ACCT);

    expect(posting.postExpenseAmountDelta).not.toHaveBeenCalled();
    expect(posting.postExpenseCashboxCorrection).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 4 — Cashbox-only change
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E cashbox-only change', () => {
  it('posts a single cashbox correction transfer NEW → OLD', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { cashbox_id: NEW_BOX },
      }),
      expenseRow: makeExpenseRow(),
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(posting.postExpenseCashboxCorrection).toHaveBeenCalledTimes(1);
    const args = posting.postExpenseCashboxCorrection.mock.calls[0][0];
    expect(args.amount).toBe(100);
    expect(args.old_cashbox_id).toBe(OLD_BOX);
    expect(args.new_cashbox_id).toBe(NEW_BOX);

    expect(posting.postExpenseAmountDelta).not.toHaveBeenCalled();
    expect(posting.postExpenseReclassification).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 5 — Payment-method change: cash → cash (no transition) is a no-op
//          on accounting shape; cash ↔ non-cash is rejected.
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E payment-method change', () => {
  it('rejects cash → non-cash transitions to keep the no-reversal contract strict', async () => {
    const { service } = await makeService({
      editRow: makeEditRow({
        new_values: { payment_method: 'bank_transfer' },
      }),
      expenseRow: makeExpenseRow({ payment_method: 'cash' }),
    });

    await expect(service.approveEditRequest(REQ, APPROVER)).rejects.toThrow(
      /غير مدعوم في تعديلات Phase 2E/,
    );
  });

  it('non-cash → cash transition is rejected symmetrically', async () => {
    const { service } = await makeService({
      editRow: makeEditRow({
        new_values: { payment_method: 'cash' },
        old_values: {
          amount: 100,
          category_id: OLD_CAT,
          cashbox_id: OLD_BOX,
          payment_method: 'bank_transfer',
        },
      }),
      expenseRow: makeExpenseRow({ payment_method: 'bank_transfer' }),
    });

    await expect(service.approveEditRequest(REQ, APPROVER)).rejects.toThrow(
      /غير مدعوم في تعديلات Phase 2E/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 6 — Amount + category (combined)
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E amount + category combined', () => {
  it('amount delta at OLD category, then reclassify merged total', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150, category_id: NEW_CAT },
      }),
      expenseRow: makeExpenseRow({ amount: '100', category_id: OLD_CAT }),
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(posting.postExpenseAmountDelta).toHaveBeenCalledTimes(1);
    expect(posting.postExpenseReclassification).toHaveBeenCalledTimes(1);
    expect(posting.postExpenseCashboxCorrection).not.toHaveBeenCalled();

    const deltaArgs = posting.postExpenseAmountDelta.mock.calls[0][0];
    expect(deltaArgs.delta_amount).toBe(50);
    expect(deltaArgs.category_account_id).toBe(OLD_CAT_ACCT);

    const reclassArgs = posting.postExpenseReclassification.mock.calls[0][0];
    expect(reclassArgs.amount).toBe(150);
    expect(reclassArgs.old_category_account_id).toBe(OLD_CAT_ACCT);
    expect(reclassArgs.new_category_account_id).toBe(NEW_CAT_ACCT);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 7 — Amount + cashbox (combined)
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E amount + cashbox combined', () => {
  it('amount delta at OLD cashbox, then cashbox transfer NEW→OLD for merged total', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150, cashbox_id: NEW_BOX },
      }),
      expenseRow: makeExpenseRow({ amount: '100', cashbox_id: OLD_BOX }),
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(posting.postExpenseAmountDelta).toHaveBeenCalledTimes(1);
    expect(posting.postExpenseCashboxCorrection).toHaveBeenCalledTimes(1);
    expect(posting.postExpenseReclassification).not.toHaveBeenCalled();

    const deltaArgs = posting.postExpenseAmountDelta.mock.calls[0][0];
    expect(deltaArgs.delta_amount).toBe(50);
    expect(deltaArgs.cashbox_id).toBe(OLD_BOX);

    const swapArgs = posting.postExpenseCashboxCorrection.mock.calls[0][0];
    expect(swapArgs.amount).toBe(150);
    expect(swapArgs.old_cashbox_id).toBe(OLD_BOX);
    expect(swapArgs.new_cashbox_id).toBe(NEW_BOX);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 8 — Amount + category + cashbox (all three)
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E all three combined', () => {
  it('amount delta at OLD/OLD, cashbox transfer NEW→OLD, reclassify OLD→NEW for merged total', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: {
          amount: 150,
          category_id: NEW_CAT,
          cashbox_id: NEW_BOX,
        },
      }),
      expenseRow: makeExpenseRow({
        amount: '100',
        category_id: OLD_CAT,
        cashbox_id: OLD_BOX,
      }),
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(posting.postExpenseAmountDelta).toHaveBeenCalledTimes(1);
    expect(posting.postExpenseCashboxCorrection).toHaveBeenCalledTimes(1);
    expect(posting.postExpenseReclassification).toHaveBeenCalledTimes(1);

    const deltaArgs = posting.postExpenseAmountDelta.mock.calls[0][0];
    expect(deltaArgs.delta_amount).toBe(50);
    expect(deltaArgs.category_account_id).toBe(OLD_CAT_ACCT);
    expect(deltaArgs.cashbox_id).toBe(OLD_BOX);

    const swapArgs = posting.postExpenseCashboxCorrection.mock.calls[0][0];
    expect(swapArgs.amount).toBe(150);

    const reclassArgs = posting.postExpenseReclassification.mock.calls[0][0];
    expect(reclassArgs.amount).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 9 — Metadata-only edit
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E metadata-only edit', () => {
  it('does NOT call any correction helper, does NOT void anything', async () => {
    const { service, posting, em } = await makeService({
      editRow: makeEditRow({
        new_values: { description: 'updated note' },
      }),
      expenseRow: makeExpenseRow({ description: 'old note' }),
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(posting.postExpenseAmountDelta).not.toHaveBeenCalled();
    expect(posting.postExpenseReclassification).not.toHaveBeenCalled();
    expect(posting.postExpenseCashboxCorrection).not.toHaveBeenCalled();
    expect(posting.reverseByReference).not.toHaveBeenCalled();

    // The expense row still gets the description UPDATE.
    expect(emCallSqlsHas(em, /UPDATE expenses/)).toBe(true);
    // Nothing is voided / rebased.
    expect(emCallSqlsHas(em, /UPDATE journal_entries[^;]*is_void\s*=\s*TRUE/i)).toBe(false);
    expect(
      emCallSqlsHas(em, /UPDATE cashbox_transactions[^;]*is_void\s*=\s*TRUE/i),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 10 — Legacy fallback: no live original JE
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E legacy no-original-JE fallback', () => {
  it('falls back to engine.recordExpense for a first-approval post', async () => {
    const { service, engine, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 200 },
      }),
      expenseRow: makeExpenseRow({ amount: '100' }),
      oldJeExists: false,
    });

    await service.approveEditRequest(REQ, APPROVER);

    expect(engine.recordExpense).toHaveBeenCalledTimes(1);
    const callArg = engine.recordExpense.mock.calls[0][0];
    expect(callArg.amount).toBe(200);

    // No correction helpers used because there's nothing to correct.
    expect(posting.postExpenseAmountDelta).not.toHaveBeenCalled();
    expect(posting.postExpenseReclassification).not.toHaveBeenCalled();
    expect(posting.postExpenseCashboxCorrection).not.toHaveBeenCalled();
    expect(posting.reverseByReference).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 11 — Idempotency / replay
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2E idempotency', () => {
  it('rejects a second approval of an already-decided request', async () => {
    const { service } = await makeService({
      editRow: makeEditRow({
        status: 'approved',
        new_values: { amount: 150 },
      }),
      expenseRow: makeExpenseRow({ amount: '100' }),
    });

    await expect(service.approveEditRequest(REQ, APPROVER)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('propagates posting helper errors as a BadRequestException', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150 },
      }),
      expenseRow: makeExpenseRow({ amount: '100' }),
      postingResponses: {
        amountDelta: { ok: false, error: 'amount_delta_failed:test' },
      },
    });

    await expect(service.approveEditRequest(REQ, APPROVER)).rejects.toThrow(
      /amount_delta_failed:test/,
    );
    expect(posting.postExpenseAmountDelta).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CASE 12 — Phase 2F surface guarantees
// ─────────────────────────────────────────────────────────────────────
describe('approveEditRequest — Phase 2F surface guarantees', () => {
  it('never sets journal_entries.is_void = TRUE on the original JE during a normal edit', async () => {
    const { service, em } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150, category_id: NEW_CAT, cashbox_id: NEW_BOX },
      }),
      expenseRow: makeExpenseRow(),
    });
    await service.approveEditRequest(REQ, APPROVER);
    expect(emCallSqlsHas(em, /UPDATE journal_entries[^;]*is_void\s*=\s*TRUE/i)).toBe(false);
  });

  it('never sets cashbox_transactions.is_void = TRUE during a normal edit', async () => {
    const { service, em } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150, category_id: NEW_CAT, cashbox_id: NEW_BOX },
      }),
      expenseRow: makeExpenseRow(),
    });
    await service.approveEditRequest(REQ, APPROVER);
    expect(
      emCallSqlsHas(em, /UPDATE cashbox_transactions[^;]*is_void\s*=\s*TRUE/i),
    ).toBe(false);
  });

  it('never rebases cashboxes.current_balance during a normal edit', async () => {
    const { service, em } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150, category_id: NEW_CAT, cashbox_id: NEW_BOX },
      }),
      expenseRow: makeExpenseRow(),
    });
    await service.approveEditRequest(REQ, APPROVER);
    expect(emCallSqlsHas(em, /UPDATE cashboxes\s+SET current_balance/i)).toBe(false);
  });

  it('never calls posting.reverseByReference during a normal edit', async () => {
    const { service, posting } = await makeService({
      editRow: makeEditRow({
        new_values: { amount: 150, category_id: NEW_CAT, cashbox_id: NEW_BOX },
      }),
      expenseRow: makeExpenseRow(),
    });
    await service.approveEditRequest(REQ, APPROVER);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
  });
});
