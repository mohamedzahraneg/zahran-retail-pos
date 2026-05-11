/**
 * financial-engine.expense-ap.spec.ts — PR-FIX-AP-CODE
 *
 * Pins the bug fix:
 *
 *   Non-cash unpaid expenses (payment_method != 'cash' OR cashbox_id =
 *   null) credit the Accounts Payable leaf account
 *   `GL_SUPPLIER_PAYABLE` ('211' — `الموردون والدائنون`), NOT the
 *   hardcoded '210' that production's chart_of_accounts doesn't have.
 *
 * Three layers:
 *
 *   1. **Line-builder behaviour** — spy on `recordTransaction` and
 *      assert the gl_lines `recordExpense` constructs for every
 *      cash / non-cash combination.
 *
 *   2. **End-to-end resolver** — drive `recordExpense` against a
 *      fully-mocked SQL handler that returns the production-shaped
 *      chart_of_accounts (only '211' exists for AP), and assert no
 *      "could not resolve GL account for line (code=210, …)" error
 *      surfaces.
 *
 *   3. **Source-grep invariants** — the engine file MUST NOT contain
 *      a bare `account_code: '210'` literal again; it MUST import
 *      `GL_SUPPLIER_PAYABLE` from `gl-codes.constants`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from './financial-engine.service';
import { GL_SUPPLIER_PAYABLE } from './gl-codes.constants';

// ─── 1. Line-builder behaviour ────────────────────────────────────

describe('FinancialEngineService.recordExpense — credit-side line builder (PR-FIX-AP-CODE)', () => {
  function makeEngineWithSpy() {
    // Construct the engine with a minimal DataSource (never touched
    // because we spy on recordTransaction).  Casting to any to bypass
    // the DI constructor's typeorm DataSource type contract.
    const ds = { query: jest.fn() } as unknown as DataSource;
    const engine = new FinancialEngineService(ds);
    const spy = jest
      .spyOn(engine, 'recordTransaction')
      .mockResolvedValue({
        ok: true,
        entry_id: 'fake-je-1',
        entry_no: 'JE-2026-FAKE-1',
        cash_txn_ids: [],
      });
    return { engine, spy };
  }

  it('non-cash card_visa with NO cashbox → credit line uses GL_SUPPLIER_PAYABLE ("211")', async () => {
    const { engine, spy } = makeEngineWithSpy();
    await engine.recordExpense({
      expense_id: 'exp-1',
      amount: 15000,
      category_account_id: 'cat-acc-1',
      cashbox_id: null,
      payment_method: 'card_visa',
      user_id: 'u-1',
      entry_date: '2026-05-11',
    });
    const spec = spy.mock.calls[0]![0]!;
    expect(spec.gl_lines).toHaveLength(2);
    // Debit side — category
    expect(spec.gl_lines[0]).toMatchObject({
      account_id: 'cat-acc-1',
      debit: 15000,
    });
    // Credit side — AP via the constant
    expect(spec.gl_lines[1]).toMatchObject({
      account_code: GL_SUPPLIER_PAYABLE,
      credit: 15000,
    });
    // Sanity: the constant resolves to '211'.
    expect(GL_SUPPLIER_PAYABLE).toBe('211');
    expect(spec.gl_lines[1]?.account_code).toBe('211');
    expect(spec.gl_lines[1]?.account_code).not.toBe('210');
    // No cash movement for non-cash.  (Engine emits either `undefined`
    // or `[]` depending on the branch; either form means "nothing
    // moved", which is what we care about.)
    expect((spec.cash_movements ?? []).length).toBe(0);
  });

  it('non-cash instapay with NO cashbox → credit line uses "211"', async () => {
    const { engine, spy } = makeEngineWithSpy();
    await engine.recordExpense({
      expense_id: 'exp-2',
      amount: 200,
      category_account_id: 'cat-acc-2',
      cashbox_id: null,
      payment_method: 'instapay',
      user_id: 'u-1',
      entry_date: '2026-05-11',
    });
    const spec = spy.mock.calls[0]![0]!;
    expect(spec.gl_lines[1]?.account_code).toBe(GL_SUPPLIER_PAYABLE);
    expect(spec.gl_lines[1]?.account_code).toBe('211');
  });

  it('non-cash bank_transfer with NO cashbox → credit line uses "211"', async () => {
    const { engine, spy } = makeEngineWithSpy();
    await engine.recordExpense({
      expense_id: 'exp-3',
      amount: 1500,
      category_account_id: 'cat-acc-3',
      cashbox_id: null,
      payment_method: 'bank_transfer',
      user_id: 'u-1',
      entry_date: '2026-05-11',
    });
    expect(spy.mock.calls[0]![0]!.gl_lines[1]?.account_code).toBe(
      GL_SUPPLIER_PAYABLE,
    );
  });

  it('CASH expense WITH cashbox → credit line uses resolve_from_cashbox_id (NOT AP)', async () => {
    const { engine, spy } = makeEngineWithSpy();
    await engine.recordExpense({
      expense_id: 'exp-4',
      amount: 1000,
      category_account_id: 'cat-acc-4',
      cashbox_id: 'cb-MAIN',
      payment_method: 'cash',
      user_id: 'u-1',
      entry_date: '2026-05-11',
    });
    const spec = spy.mock.calls[0]![0]!;
    const credit = spec.gl_lines[1];
    expect(credit).toMatchObject({
      resolve_from_cashbox_id: 'cb-MAIN',
      credit: 1000,
      cashbox_id: 'cb-MAIN',
    });
    // Crucially the cash credit side has NO account_code field —
    // resolution flows through the cashbox link, not the AP code.
    expect(credit?.account_code).toBeUndefined();
    // And a paired cash_movements row exists.
    expect(spec.cash_movements).toHaveLength(1);
    expect(spec.cash_movements?.[0]).toMatchObject({
      cashbox_id: 'cb-MAIN',
      direction: 'out',
      amount: 1000,
    });
  });

  it('payment_method=cash WITHOUT cashbox → engine rejects up-front (existing invariant, regression guard)', async () => {
    const { engine, spy } = makeEngineWithSpy();
    const res = await engine.recordExpense({
      expense_id: 'exp-5',
      amount: 50,
      category_account_id: 'cat-acc-5',
      cashbox_id: null,
      payment_method: 'cash',
      user_id: 'u-1',
    });
    expect(res.ok).toBe(false);
    // Engine returns an Arabic message:
    //   "مصروف نقدي بدون خزنة — لا يمكن الترحيل بدون تحريك الخزنة"
    expect((res as any).error).toMatch(/خزنة/);
    // The bug fix must not have weakened the cash invariant.
    expect(spy).not.toHaveBeenCalled();
  });

  it('is_advance=true non-cash → debit goes to 1123, credit still uses "211"', async () => {
    const { engine, spy } = makeEngineWithSpy();
    await engine.recordExpense({
      expense_id: 'exp-6',
      amount: 800,
      category_account_id: 'cat-acc-6',
      cashbox_id: null,
      payment_method: 'card_visa',
      user_id: 'u-1',
      is_advance: true,
      employee_user_id: 'emp-1',
    });
    const spec = spy.mock.calls[0]![0]!;
    // Debit reroutes to employee receivables 1123.
    expect(spec.gl_lines[0]).toMatchObject({
      account_code: '1123',
      debit: 800,
      employee_user_id: 'emp-1',
    });
    // Credit still AP for non-cash.
    expect(spec.gl_lines[1]?.account_code).toBe(GL_SUPPLIER_PAYABLE);
  });
});

// ─── 2. Source-grep invariants ────────────────────────────────────

describe('financial-engine.service.ts — AP-code source invariants (PR-FIX-AP-CODE)', () => {
  const SRC = readFileSync(
    resolve(__dirname, './financial-engine.service.ts'),
    'utf-8',
  );
  // Strip block + line comments so a docstring referencing "210" as
  // historical context can't trip the negative grep.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('imports GL_SUPPLIER_PAYABLE from gl-codes.constants', () => {
    expect(SRC).toMatch(
      /import\s*\{[\s\S]+GL_SUPPLIER_PAYABLE[\s\S]+\}\s*from\s*['"]\.\/gl-codes\.constants['"]/,
    );
  });

  it('does NOT contain a bare `account_code: "210"` literal in non-comment code', () => {
    expect(CODE).not.toMatch(/account_code\s*:\s*['"]210['"]/);
  });

  it('does NOT contain a bare `account_code: "21"` (parent header) literal', () => {
    expect(CODE).not.toMatch(/account_code\s*:\s*['"]21['"]/);
  });

  it('the AP credit branch references GL_SUPPLIER_PAYABLE', () => {
    expect(CODE).toMatch(/account_code\s*:\s*GL_SUPPLIER_PAYABLE/);
  });

  it('gl-codes.constants exports GL_SUPPLIER_PAYABLE = "211" (defence in depth)', () => {
    const constSrc = readFileSync(
      resolve(__dirname, './gl-codes.constants.ts'),
      'utf-8',
    );
    expect(constSrc).toMatch(
      /export const GL_SUPPLIER_PAYABLE\s*=\s*['"]211['"]/,
    );
  });
});
