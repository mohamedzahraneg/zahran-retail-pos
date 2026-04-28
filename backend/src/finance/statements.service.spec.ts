/**
 * statements.service.spec.ts — PR-FIN-3
 *
 * Five concerns covered:
 *   1. Opening + running + closing balance math holds for each
 *      statement type (closing = opening + Σ debit − Σ credit).
 *   2. Voided GL rows are listed but excluded from the running
 *      balance (transparency without affecting totals).
 *   3. Empty states surface the correct dynamic note (no
 *      hardcoded counts — comes from the DB context query).
 *   4. NotFoundException when the entity id doesn't exist.
 *   5. No-write invariant: the service NEVER issues anything other
 *      than SELECT.
 *
 * Plus a concurrency cap test (peak in-flight DB queries ≤ 1)
 * carried forward from PR-FIN-2-HOTFIX-2.
 */

import { NotFoundException } from '@nestjs/common';
import { StatementsService } from './statements.service';

interface QueryStub {
  test: (sql: string) => boolean;
  rows: any;
}

function buildSvc(stubs: QueryStub[] = [], defaultRows: any = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const ds = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const matched = stubs.find((s) => s.test(sql));
      return matched ? matched.rows : defaultRows;
    }),
  };
  const svc = new StatementsService(ds as any);
  return { svc, ds, calls };
}

describe('StatementsService — PR-FIN-3', () => {
  // ─── GL account ─────────────────────────────────────────────────
  describe('glAccountStatement', () => {
    it('throws NotFoundException when the account id does not exist', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM chart_of_accounts/.test(s),
          rows: [],
        },
      ]);
      await expect(
        svc.glAccountStatement('missing', { from: '2026-04-01', to: '2026-04-28' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('computes opening + closing + running balance correctly', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM chart_of_accounts WHERE id/.test(s),
          rows: [{ id: 'acc-1', code: '1111', name_ar: 'الخزينة', name_en: null, account_type: 'asset', normal_balance: 'debit', is_leaf: true }],
        },
        {
          // opening: debit=200, credit=50 → opening=150
          test: (s) => /entry_date < /.test(s),
          rows: [{ d: '200', c: '50' }],
        },
        {
          test: (s) => /journal_lines jl/.test(s) && /entry_date >= /.test(s),
          rows: [
            { entry_no: 'JE-001', entry_date: '2026-04-05', created_at: '2026-04-05T10:00:00Z',
              is_void: false, reference_type: 'invoice', reference_id: 'inv-1',
              je_desc: 'sale', debit: '100', credit: '0', line_desc: null, cashbox_id: null },
            { entry_no: 'JE-002', entry_date: '2026-04-06', created_at: '2026-04-06T10:00:00Z',
              is_void: false, reference_type: 'expense', reference_id: 'exp-1',
              je_desc: 'expense', debit: '0', credit: '30', line_desc: null, cashbox_id: null },
          ],
        },
      ]);
      const r = await svc.glAccountStatement('acc-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.opening_balance).toBe(150);
      expect(r.totals.debit).toBe(100);
      expect(r.totals.credit).toBe(30);
      expect(r.totals.net).toBe(70);
      expect(r.totals.lines).toBe(2);
      // Running balance: 150 → 250 → 220
      expect(r.rows[0].running_balance).toBe(250);
      expect(r.rows[1].running_balance).toBe(220);
      expect(r.closing_balance).toBe(220);
      // closing = opening + net
      expect(r.closing_balance).toBe(r.opening_balance + r.totals.net);
      expect(r.confidence.has_data).toBe(true);
      expect(r.confidence.note).toBeNull();
    });

    it('voided rows are listed but do NOT affect running balance or totals', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM chart_of_accounts WHERE id/.test(s),
          rows: [{ id: 'acc-1', code: '1111', name_ar: 'الخزينة', name_en: null, account_type: 'asset', normal_balance: 'debit', is_leaf: true }],
        },
        {
          test: (s) => /entry_date < /.test(s),
          rows: [{ d: '0', c: '0' }],
        },
        {
          test: (s) => /journal_lines jl/.test(s) && /entry_date >= /.test(s),
          rows: [
            { entry_no: 'JE-A', entry_date: '2026-04-05', created_at: '2026-04-05T10:00:00Z',
              is_void: false, reference_type: null, reference_id: null,
              je_desc: 'live', debit: '100', credit: '0', line_desc: null, cashbox_id: null },
            { entry_no: 'JE-B', entry_date: '2026-04-06', created_at: '2026-04-06T10:00:00Z',
              is_void: true,  reference_type: null, reference_id: null,
              je_desc: 'voided', debit: '500', credit: '0', line_desc: null, cashbox_id: null },
          ],
        },
      ]);
      const r = await svc.glAccountStatement('acc-1', {
        from: '2026-04-01', to: '2026-04-28', include_voided: true,
      });
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0].is_voided).toBe(false);
      expect(r.rows[1].is_voided).toBe(true);
      // Voided row is_voided=true and running_balance NOT advanced
      expect(r.rows[1].running_balance).toBe(100);
      expect(r.totals.debit).toBe(100); // voided 500 not counted
      expect(r.totals.lines).toBe(1);   // count excludes voided
    });

    it('empty range returns has_data=false with the correct note', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM chart_of_accounts WHERE id/.test(s),
          rows: [{ id: 'acc-1', code: '1111', name_ar: 'الخزينة', name_en: null, account_type: 'asset', normal_balance: 'debit', is_leaf: true }],
        },
        { test: (s) => /entry_date < /.test(s), rows: [{ d: '0', c: '0' }] },
        { test: (s) => /journal_lines jl/.test(s), rows: [] },
      ]);
      const r = await svc.glAccountStatement('acc-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.confidence.has_data).toBe(false);
      expect(r.confidence.note).toMatch(/لا توجد حركات/);
    });
  });

  // ─── Cashbox ────────────────────────────────────────────────────
  describe('cashboxStatement', () => {
    it('opening uses cashbox.opening_balance + signed CT before range', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM cashboxes WHERE id/.test(s),
          rows: [{ id: 'cb-1', name_ar: 'الخزينة الرئيسية', name_en: null,
                   kind: 'cash', currency: 'EGP', opening_balance: '100',
                   current_balance: '500' }],
        },
        {
          // CT before range: net_before = 200 (200 in - 0 out)
          test: (s) => /SUM\([\s\S]*?direction='in'/.test(s) && /created_at < /.test(s),
          rows: [{ net_before: '200' }],
        },
        {
          test: (s) => /v_cashbox_movements/.test(s),
          rows: [
            { id: 1, direction: 'in',  amount: '50',  category: 'sale', reference_type: 'invoice',
              reference_id: 'inv-1', balance_after: null, notes: null, user_name: 'cashier',
              kind_ar: 'مبيعات', reference_no: 'INV-1', counterparty_name: null,
              created_at: '2026-04-10T10:00:00Z' },
            { id: 2, direction: 'out', amount: '20',  category: 'expense', reference_type: 'expense',
              reference_id: 'exp-1', balance_after: null, notes: null, user_name: 'cashier',
              kind_ar: 'مصروف', reference_no: 'EXP-1', counterparty_name: 'مورد',
              created_at: '2026-04-11T10:00:00Z' },
          ],
        },
      ]);
      const r = await svc.cashboxStatement('cb-1', { from: '2026-04-01', to: '2026-04-28' });
      // opening = 100 (opening_balance) + 200 (net_before) = 300
      expect(r.opening_balance).toBe(300);
      expect(r.totals.debit).toBe(50);   // money in
      expect(r.totals.credit).toBe(20);  // money out
      expect(r.totals.net).toBe(30);
      expect(r.closing_balance).toBe(330);
      expect(r.rows[0].running_balance).toBe(350);
      expect(r.rows[1].running_balance).toBe(330);
      expect(r.rows[0].counterparty).toBeNull();
      expect(r.rows[1].counterparty).toBe('مورد');
      // closing = opening + net
      expect(r.closing_balance).toBe(r.opening_balance + r.totals.net);
    });

    it('empty range surfaces the cashbox empty-state note', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM cashboxes WHERE id/.test(s),
          rows: [{ id: 'cb-1', name_ar: 'بنك', kind: 'bank', opening_balance: '0', current_balance: '0' }],
        },
        { test: (s) => /SUM/.test(s) && /created_at < /.test(s), rows: [{ net_before: '0' }] },
        { test: (s) => /v_cashbox_movements/.test(s), rows: [] },
      ]);
      const r = await svc.cashboxStatement('cb-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.confidence.has_data).toBe(false);
      expect(r.confidence.note).toMatch(/لا توجد حركات/);
    });
  });

  // ─── Employee ───────────────────────────────────────────────────
  describe('employeeStatement', () => {
    it('signed amount_owed_delta is split into debit/credit columns and running tracks the running net', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM users WHERE id/.test(s),
          rows: [{ id: 'u-1', full_name: 'محمد', employee_no: 'EMP-001',
                   username: 'mohamed', deleted_at: null }],
        },
        {
          // opening: net_before = 50 (positive = company owes employee)
          test: (s) => /v_employee_ledger[\s\S]*?event_date < /.test(s),
          rows: [{ net_before: '50' }],
        },
        {
          test: (s) => /v_employee_ledger/.test(s) && /event_date >= /.test(s),
          rows: [
            { event_date: '2026-04-05', created_at: '2026-04-05T10:00:00Z',
              entry_type: 'wage_accrual', description: 'استحقاق راتب',
              amount_owed_delta: '100', gross_amount: '100',
              reference_type: 'employee_wage_accrual', reference_id: 'wa-1',
              shift_id: null, journal_entry_id: 'je-1', notes: null },
            { event_date: '2026-04-10', created_at: '2026-04-10T10:00:00Z',
              entry_type: 'settlement', description: 'تسوية',
              amount_owed_delta: '-30', gross_amount: '30',
              reference_type: 'employee_settlement', reference_id: 'set-1',
              shift_id: null, journal_entry_id: 'je-2', notes: null },
          ],
        },
      ]);
      const r = await svc.employeeStatement('u-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.opening_balance).toBe(50);
      expect(r.totals.debit).toBe(100);
      expect(r.totals.credit).toBe(30);
      expect(r.rows[0].debit).toBe(100);
      expect(r.rows[0].credit).toBe(0);
      expect(r.rows[1].debit).toBe(0);
      expect(r.rows[1].credit).toBe(30);
      expect(r.rows[0].running_balance).toBe(150);
      expect(r.rows[1].running_balance).toBe(120);
      expect(r.closing_balance).toBe(120);
    });
  });

  // ─── Customer ───────────────────────────────────────────────────
  describe('customerStatement', () => {
    it('walk-in dominance produces a dynamic empty-state note (no hardcoded counts)', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM customers WHERE id/.test(s),
          rows: [{ id: 'c-1', customer_no: 'C-001', full_name: 'أحمد', phone: '0100', current_balance: '0' }],
        },
        {
          // No opening row before range
          test: (s) => /FROM customer_ledger[\s\S]*?entry_date < /.test(s),
          rows: [],
        },
        {
          test: (s) => /FROM customer_ledger[\s\S]*?entry_date >= /.test(s),
          rows: [],
        },
        {
          test: (s) => /walk_in_invoices/.test(s),
          rows: [{ total_invoices: 79, walk_in_invoices: 78 }],
        },
      ]);
      const r = await svc.customerStatement('c-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.opening_balance).toBe(0);
      expect(r.closing_balance).toBe(0);
      expect(r.confidence.has_data).toBe(false);
      // Note interpolates the live counts — never hardcoded.
      expect(r.confidence.note).toMatch(/78 من أصل 79/);
      expect(r.confidence.context).toEqual({
        period_total_invoices: 79,
        period_walk_in_invoices: 78,
      });
    });

    it('all walk-in (100%) produces the strongest empty-state wording', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM customers WHERE id/.test(s),
          rows: [{ id: 'c-1', customer_no: 'C-001', full_name: 'أحمد', phone: '0100', current_balance: '0' }],
        },
        { test: (s) => /entry_date < /.test(s), rows: [] },
        { test: (s) => /entry_date >= /.test(s), rows: [] },
        {
          test: (s) => /walk_in_invoices/.test(s),
          rows: [{ total_invoices: 5, walk_in_invoices: 5 }],
        },
      ]);
      const r = await svc.customerStatement('c-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.confidence.note).toMatch(/كل فواتير الفترة \(5\)/);
    });

    it('no invoices in range produces the generic empty note', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM customers WHERE id/.test(s),
          rows: [{ id: 'c-1', customer_no: 'C-001', full_name: 'أحمد', phone: '0100', current_balance: '0' }],
        },
        { test: (s) => /entry_date < /.test(s), rows: [] },
        { test: (s) => /entry_date >= /.test(s), rows: [] },
        {
          test: (s) => /walk_in_invoices/.test(s),
          rows: [{ total_invoices: 0, walk_in_invoices: 0 }],
        },
      ]);
      const r = await svc.customerStatement('c-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.confidence.note).toMatch(/لا توجد حركات لهذا العميل/);
    });

    it('opening balance comes from the most recent balance_after BEFORE range.from', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM customers WHERE id/.test(s),
          rows: [{ id: 'c-1', customer_no: 'C-001', full_name: 'أحمد', phone: '0100', current_balance: '0' }],
        },
        {
          test: (s) => /entry_date < /.test(s),
          rows: [{ balance_after: '250.50' }],
        },
        {
          test: (s) => /entry_date >= /.test(s),
          rows: [
            { id: 1, entry_date: '2026-04-05', direction: 'debit',  amount: '100',
              reference_type: 'invoice', reference_id: 'inv-1', balance_after: null,
              notes: 'بيع', created_at: '2026-04-05T10:00:00Z' },
          ],
        },
        { test: (s) => /walk_in_invoices/.test(s), rows: [{ total_invoices: 0, walk_in_invoices: 0 }] },
      ]);
      const r = await svc.customerStatement('c-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.opening_balance).toBe(250.5);
      expect(r.closing_balance).toBe(350.5);
      expect(r.confidence.has_data).toBe(true);
    });
  });

  // ─── Supplier ───────────────────────────────────────────────────
  describe('supplierStatement', () => {
    it('empty-state surfaces the supplier-specific note + period context', async () => {
      const { svc } = buildSvc([
        {
          test: (s) => /FROM suppliers WHERE id/.test(s),
          rows: [{ id: 's-1', supplier_no: 'S-001', name: 'مصنع', phone: '0100', current_balance: '0' }],
        },
        { test: (s) => /supplier_ledger[\s\S]*?entry_date < /.test(s), rows: [] },
        { test: (s) => /supplier_ledger[\s\S]*?entry_date >= /.test(s), rows: [] },
        {
          test: (s) => /purchase_count/.test(s),
          rows: [{ purchase_count: 0, payment_count: 0 }],
        },
      ]);
      const r = await svc.supplierStatement('s-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(r.confidence.has_data).toBe(false);
      expect(r.confidence.note).toMatch(/لا توجد فواتير شراء/);
      expect(r.confidence.context).toEqual({
        period_purchase_count: 0,
        period_payment_count: 0,
      });
    });
  });

  // ─── No-write invariant ─────────────────────────────────────────
  describe('no-write invariant', () => {
    it.each([
      ['glAccountStatement', 'acc-1'],
      ['cashboxStatement', 'cb-1'],
      ['employeeStatement', 'u-1'],
      ['customerStatement', 'c-1'],
      ['supplierStatement', 's-1'],
    ])('%s issues only SELECT', async (method, id) => {
      const { svc, calls } = buildSvc(
        [
          // Stub entity lookup so the method runs to completion.
          { test: () => true, rows: [{ id, full_name: 'x', name: 'x', name_ar: 'x',
            employee_no: null, username: null, customer_no: null, supplier_no: null,
            phone: null, current_balance: '0', kind: 'cash', currency: 'EGP',
            opening_balance: '0', code: '1111', name_en: null,
            account_type: 'asset', normal_balance: 'debit', is_leaf: true,
            d: '0', c: '0', net_before: '0',
            total_invoices: 0, walk_in_invoices: 0,
            purchase_count: 0, payment_count: 0,
            balance_after: null,
            deleted_at: null,
          }] },
        ],
      );
      await (svc as any)[method](id, { from: '2026-04-01', to: '2026-04-28' });
      for (const c of calls) {
        const upper = c.sql.toUpperCase();
        expect(upper).not.toMatch(/\bINSERT\s+INTO\b/);
        expect(upper).not.toMatch(/\bUPDATE\b/);
        expect(upper).not.toMatch(/\bDELETE\s+FROM\b/);
        expect(upper).not.toMatch(/\bTRUNCATE\b/);
      }
    });
  });

  // ─── Concurrency cap ────────────────────────────────────────────
  describe('concurrency cap (PR-FIN-2-HOTFIX-2 lesson)', () => {
    it('peak in-flight DB queries is exactly 1 across all statement helpers', async () => {
      let inFlight = 0;
      let peak = 0;
      const ds = {
        query: jest.fn(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setImmediate(r));
          inFlight -= 1;
          // Return shape that satisfies every helper's first SELECT.
          return [
            {
              id: 'x', full_name: 'x', name: 'x', name_ar: 'x', name_en: null,
              employee_no: null, username: null, customer_no: null, supplier_no: null,
              phone: null, current_balance: '0', kind: 'cash', currency: 'EGP',
              opening_balance: '0', code: '1111',
              account_type: 'asset', normal_balance: 'debit', is_leaf: true,
              d: '0', c: '0', net_before: '0',
              total_invoices: 0, walk_in_invoices: 0,
              purchase_count: 0, payment_count: 0,
              balance_after: null, deleted_at: null,
            },
          ];
        }),
      };
      const svc = new StatementsService(ds as any);
      await svc.glAccountStatement('acc-1', { from: '2026-04-01', to: '2026-04-28' });
      await svc.cashboxStatement('cb-1', { from: '2026-04-01', to: '2026-04-28' });
      await svc.employeeStatement('u-1', { from: '2026-04-01', to: '2026-04-28' });
      await svc.customerStatement('c-1', { from: '2026-04-01', to: '2026-04-28' });
      await svc.supplierStatement('s-1', { from: '2026-04-01', to: '2026-04-28' });
      expect(peak).toBe(1);
    });
  });
});
