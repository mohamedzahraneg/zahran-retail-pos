/**
 * shifts.service.adjust-opening-balance.spec.ts
 * PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST (migration 128)
 *
 * Pins the ShiftsService.adjustOpeningBalance + listOpeningBalanceAdjustments
 * contract.  Covers:
 *
 *   · Validation:
 *       - reason < 5 chars rejected
 *       - non-finite / negative new value rejected (NaN, Infinity, -1)
 *       - no-op delta < 0.005 rejected
 *   · Lifecycle:
 *       - shift not found → 404
 *       - status='closed' → 400 with the spec'd Arabic copy
 *       - status='pending_close' → same 400 (post-submission, before
 *         manager approval; same reasoning as 'closed')
 *   · Movement-aware UPDATE:
 *       - open + no movements → BOTH opening_balance and
 *         expected_closing rewritten (single UPDATE)
 *       - open + has movements → opening_balance ONLY rewritten;
 *         expected_closing left alone (live summary recomputes)
 *   · Audit:
 *       - shift_opening_balance_adjustments row inserted with the
 *         full snapshot (old/new opening + expected, status,
 *         has_movements, reason, notes, adjusted_by)
 *       - activity_logs row inserted with kind='shift_opening_balance_adjust'
 *   · No JE/CT/SM writes anywhere in the method (defence-in-depth
 *     source-grep on the service file).
 *   · listOpeningBalanceAdjustments joins users(adjusted_by_name) and
 *     orders by adjusted_at DESC.
 *
 * No real Postgres — DataSource and EntityManager are stubbed.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

const SHIFT_ID = '5f128c2d-29eb-4332-999b-770b310a0729';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CASHBOX_ID = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

interface FakeShiftRow {
  id: string;
  shift_no: string;
  status: 'open' | 'pending_close' | 'closed';
  opening_balance: string;
  expected_closing: string;
  cashbox_id: string;
  opened_at: string;
}

const baseOpenShift: FakeShiftRow = {
  id: SHIFT_ID,
  shift_no: 'SHF-2026-00099',
  status: 'open',
  opening_balance: '500.00',
  expected_closing: '500.00',
  cashbox_id: CASHBOX_ID,
  opened_at: '2026-05-09T08:00:00+00:00',
};

/**
 * Builds a stubbed EntityManager whose `query()` walks the supplied
 * row plan in order.  The rows array is a sequence of return values
 * for successive `em.query()` calls.  Tests assert the captured SQL
 * + params via the `calls` array.
 */
function makeEm(rowsByCall: any[][] = []) {
  const calls: QueryCall[] = [];
  let i = 0;
  const em: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return rowsByCall[i++] ?? [];
    },
  };
  return { em, calls };
}

/**
 * Stubs DataSource so `transaction(cb)` invokes cb() with our
 * EntityManager and `query()` works for the listOpeningBalanceAdjustments
 * read path.
 */
function makeService(emPlan: any[][] = [], dsPlan: any[][] = []) {
  const { em, calls: emCalls } = makeEm(emPlan);
  const dsCalls: QueryCall[] = [];
  let dsI = 0;
  const ds: any = {
    transaction: async (cb: (em: any) => Promise<any>) => cb(em),
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      return dsPlan[dsI++] ?? [];
    },
  };
  const svc = new ShiftsService(ds);
  return { svc, em, emCalls, dsCalls };
}

describe('ShiftsService.adjustOpeningBalance — validation guards', () => {
  it('rejects reason shorter than 5 characters', async () => {
    const { svc } = makeService();
    await expect(
      svc.adjustOpeningBalance(
        SHIFT_ID,
        { new_opening_balance: 1000, reason: 'كم', notes: undefined },
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects negative new_opening_balance', async () => {
    const { svc } = makeService();
    await expect(
      svc.adjustOpeningBalance(
        SHIFT_ID,
        { new_opening_balance: -1, reason: 'سبب صحيح', notes: undefined },
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects NaN new_opening_balance', async () => {
    const { svc } = makeService();
    await expect(
      svc.adjustOpeningBalance(
        SHIFT_ID,
        { new_opening_balance: Number.NaN, reason: 'سبب صحيح', notes: undefined },
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects Infinity new_opening_balance', async () => {
    const { svc } = makeService();
    await expect(
      svc.adjustOpeningBalance(
        SHIFT_ID,
        {
          new_opening_balance: Number.POSITIVE_INFINITY,
          reason: 'سبب صحيح',
          notes: undefined,
        },
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns 404 when the shift does not exist', async () => {
    // First em.query (SELECT FOR UPDATE) returns empty.
    const { svc } = makeService([[]]);
    await expect(
      svc.adjustOpeningBalance(
        SHIFT_ID,
        { new_opening_balance: 1000, reason: 'سبب صحيح', notes: undefined },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ShiftsService.adjustOpeningBalance — closed / pending_close shifts blocked', () => {
  const closedCopy =
    'لا يمكن تعديل الرصيد الافتتاحي لوردية مغلقة. ' +
    'استخدم تعديل العد للوردية المغلقة بدلاً من ذلك.';

  it('rejects closed shift with the spec\'d Arabic copy', async () => {
    const { svc } = makeService([
      [{ ...baseOpenShift, status: 'closed' }], // SELECT FOR UPDATE
    ]);
    let caught: any;
    try {
      await svc.adjustOpeningBalance(
        SHIFT_ID,
        { new_opening_balance: 1000, reason: 'سبب صحيح', notes: undefined },
        USER_ID,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toBe(closedCopy);
  });

  it('rejects pending_close shift with the same Arabic copy', async () => {
    const { svc } = makeService([
      [{ ...baseOpenShift, status: 'pending_close' }],
    ]);
    let caught: any;
    try {
      await svc.adjustOpeningBalance(
        SHIFT_ID,
        { new_opening_balance: 1000, reason: 'سبب صحيح', notes: undefined },
        USER_ID,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toBe(closedCopy);
  });
});

describe('ShiftsService.adjustOpeningBalance — no-op delta guard', () => {
  it('rejects when |new − old| < 0.005', async () => {
    const { svc } = makeService([
      [{ ...baseOpenShift, opening_balance: '500.00' }],
    ]);
    await expect(
      svc.adjustOpeningBalance(
        SHIFT_ID,
        { new_opening_balance: 500.001, reason: 'سبب صحيح', notes: undefined },
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ShiftsService.adjustOpeningBalance — happy paths', () => {
  it('open + no movements → updates BOTH opening_balance and expected_closing in a single UPDATE', async () => {
    const { svc, emCalls } = makeService([
      [{ ...baseOpenShift, opening_balance: '500.00', expected_closing: '500.00' }],
      [{ has_movements: false }],
      [], // UPDATE shifts ...
      [{ id: 'audit-1', shift_id: SHIFT_ID }], // INSERT INTO shift_opening_balance_adjustments
      [], // INSERT INTO activity_logs
      [{ ...baseOpenShift, opening_balance: '1000.00', expected_closing: '1000.00' }], // SELECT updated row
    ]);
    const out = await svc.adjustOpeningBalance(
      SHIFT_ID,
      {
        new_opening_balance: 1000,
        reason: 'تصحيح بعد إعادة العد اليدوي',
        notes: 'تأكيد بصري من الكاشير',
      },
      USER_ID,
    );

    // The UPDATE call must rewrite BOTH fields together.
    const updateCall = emCalls.find(
      (c) =>
        /UPDATE shifts SET opening_balance/.test(c.sql) &&
        /expected_closing\s*=\s*\$1/.test(c.sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.params[0]).toBe(1000);
    expect(updateCall!.params[1]).toBe(SHIFT_ID);

    // Audit row INSERT carries the full snapshot.
    const auditCall = emCalls.find((c) =>
      /INSERT INTO shift_opening_balance_adjustments/.test(c.sql),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall!.params).toEqual([
      SHIFT_ID,
      500,                         // old_opening_balance
      1000,                        // new_opening_balance
      500,                         // old_expected_closing
      1000,                        // new_expected_closing (synced because no movements)
      'open',                      // shift_status_at_adjust
      false,                       // has_movements_at_adjust
      'تصحيح بعد إعادة العد اليدوي',
      'تأكيد بصري من الكاشير',
      USER_ID,
    ]);

    expect(out.adjustment).toBeTruthy();
    expect(out.shift).toBeTruthy();
  });

  it('open + has movements → updates opening_balance ONLY (expected_closing untouched)', async () => {
    const { svc, emCalls } = makeService([
      [{ ...baseOpenShift, opening_balance: '500.00', expected_closing: '500.00' }],
      [{ has_movements: true }],
      [], // UPDATE shifts ... (opening_balance only)
      [{ id: 'audit-2', shift_id: SHIFT_ID }],
      [],
      [{ ...baseOpenShift, opening_balance: '750.00' }],
    ]);
    await svc.adjustOpeningBalance(
      SHIFT_ID,
      { new_opening_balance: 750, reason: 'سبب صحيح للتوضيح', notes: undefined },
      USER_ID,
    );

    // The UPDATE must NOT mention expected_closing — only opening_balance.
    const movementsUpdate = emCalls.find(
      (c) =>
        /UPDATE shifts SET opening_balance/.test(c.sql) &&
        !/expected_closing/.test(c.sql),
    );
    expect(movementsUpdate).toBeDefined();
    expect(movementsUpdate!.params).toEqual([750, SHIFT_ID]);

    // Audit row carries has_movements_at_adjust=true and
    // new_expected_closing=old (not rewritten).
    const auditCall = emCalls.find((c) =>
      /INSERT INTO shift_opening_balance_adjustments/.test(c.sql),
    );
    expect(auditCall).toBeDefined();
    // [shift_id, old_open, new_open, old_exp, new_exp, status, has_movements, reason, notes, user]
    expect(auditCall!.params[3]).toBe(500); // old_expected_closing
    expect(auditCall!.params[4]).toBe(500); // new_expected_closing — preserved
    expect(auditCall!.params[5]).toBe('open');
    expect(auditCall!.params[6]).toBe(true); // has_movements_at_adjust
  });

  it('writes the activity_logs row with kind=shift_opening_balance_adjust', async () => {
    const { svc, emCalls } = makeService([
      [baseOpenShift],
      [{ has_movements: false }],
      [],
      [{ id: 'audit-3' }],
      [],
      [baseOpenShift],
    ]);
    await svc.adjustOpeningBalance(
      SHIFT_ID,
      { new_opening_balance: 1000, reason: 'سبب التعديل التحقق', notes: undefined },
      USER_ID,
    );
    const activityCall = emCalls.find((c) =>
      /INSERT INTO activity_logs/.test(c.sql),
    );
    expect(activityCall).toBeDefined();
    // The insert uses jsonb_build_object with the kind discriminator
    // and includes the old/new values + reason for downstream
    // shift-timeline rendering.
    expect(activityCall!.sql).toMatch(/'kind'.*'shift_opening_balance_adjust'/);
    expect(activityCall!.sql).toMatch(/old_opening_balance/);
    expect(activityCall!.sql).toMatch(/new_opening_balance/);
    expect(activityCall!.sql).toMatch(/has_movements_at_adjust/);
    // Entity is shift, action is update.
    expect(activityCall!.sql).toMatch(/'update'::activity_action/);
    expect(activityCall!.sql).toMatch(/'shift'::entity_type/);
  });
});

describe('ShiftsService.listOpeningBalanceAdjustments', () => {
  it('joins users for adjusted_by_name and orders by adjusted_at DESC', async () => {
    const { svc, dsCalls } = makeService(
      [],
      [
        [
          {
            id: 'a-1',
            shift_id: SHIFT_ID,
            adjusted_by: USER_ID,
            adjusted_by_name: 'مدير النظام',
            old_opening_balance: '500.00',
            new_opening_balance: '1000.00',
            reason: 'سبب صحيح',
            adjusted_at: '2026-05-09T08:00:00Z',
          },
        ],
      ],
    );
    const out = await svc.listOpeningBalanceAdjustments(SHIFT_ID);
    expect(out).toHaveLength(1);
    expect(out[0].adjusted_by_name).toBe('مدير النظام');
    expect(dsCalls).toHaveLength(1);
    expect(dsCalls[0].sql).toMatch(
      /FROM\s+shift_opening_balance_adjustments/,
    );
    expect(dsCalls[0].sql).toMatch(/LEFT JOIN users u ON u\.id = a\.adjusted_by/);
    expect(dsCalls[0].sql).toMatch(/ORDER BY a\.adjusted_at DESC/);
    expect(dsCalls[0].params).toEqual([SHIFT_ID]);
  });
});

// ─── Source-grep — no JE / CT / SM writes ahead of the audit row ────

describe('ShiftsService.adjustOpeningBalance — read-only over financial ledgers', () => {
  // Read the exact code body of the new method so a future regression
  // that adds a JE/CT/SM mutation inside fails this guard immediately.
  const SRC = readFileSync(
    resolve(__dirname, './shifts.service.ts'),
    'utf-8',
  );
  // Strip JS comments so the negative-grep doesn't false-positive on
  // prose that mentions the forbidden keywords.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  function methodBody(name: string): string {
    const idx = CODE.indexOf(`async ${name}`);
    expect(idx).toBeGreaterThan(-1);
    // Generous 6000-char window — covers the new method body safely.
    return CODE.substring(idx, idx + 6000);
  }

  it('adjustOpeningBalance() body has zero INSERT INTO journal_entries / journal_lines', () => {
    const body = methodBody('adjustOpeningBalance');
    expect(body).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
  });

  it('adjustOpeningBalance() body has zero INSERT INTO cashbox_transactions', () => {
    const body = methodBody('adjustOpeningBalance');
    expect(body).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions/i);
  });

  it('adjustOpeningBalance() body has zero INSERT/UPDATE on stock_movements', () => {
    const body = methodBody('adjustOpeningBalance');
    expect(body).not.toMatch(/INSERT\s+INTO\s+stock_movements/i);
    expect(body).not.toMatch(/UPDATE\s+stock_movements/i);
  });

  it('adjustOpeningBalance() does NOT call FinancialEngine / posting service / accounting_only', () => {
    const body = methodBody('adjustOpeningBalance');
    expect(body).not.toMatch(/this\.engine\./);
    expect(body).not.toMatch(/this\.posting\./);
    expect(body).not.toMatch(/recordTransaction/);
    expect(body).not.toMatch(/recordExpense/);
    expect(body).not.toMatch(/postReturn/);
    expect(body).not.toMatch(/recordCashOnlyMovement/);
    expect(body).not.toMatch(/\baccounting_only\b/);
  });

  it('listOpeningBalanceAdjustments() is a pure SELECT (no DML)', () => {
    // The method body is short — capture from `async list…` to the
    // first closing-brace-on-its-own-line so the DML negative-grep
    // doesn't sweep into the next method.
    const idx = CODE.indexOf('async listOpeningBalanceAdjustments');
    expect(idx).toBeGreaterThan(-1);
    const tail = CODE.substring(idx);
    const closing = tail.indexOf('\n  }');
    const body = tail.substring(0, closing > 0 ? closing : 1000);
    expect(body).not.toMatch(/INSERT\s/i);
    expect(body).not.toMatch(/UPDATE\s/i);
    expect(body).not.toMatch(/DELETE\s/i);
    expect(body).toMatch(/SELECT a\.\*/);
  });
});
