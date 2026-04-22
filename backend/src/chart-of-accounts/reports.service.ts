import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Financial reports driven entirely by the posted journal.
 *
 * Every number here comes from the same v_account_balances /
 * journal_lines base that the chart of accounts reads — so the reports
 * tie back to the trial balance by construction. No parallel aggregates.
 */
@Injectable()
export class AccountingReportsService {
  constructor(private readonly ds: DataSource) {}

  /**
   * كشف حساب — every posted line on one account inside a date window,
   * with a running balance computed from the account's normal balance.
   */
  async accountLedger(
    accountId: string,
    from?: string,
    to?: string,
  ) {
    const [account] = await this.ds.query(
      `SELECT id, code, name_ar, account_type, normal_balance
         FROM chart_of_accounts WHERE id = $1`,
      [accountId],
    );
    if (!account) throw new NotFoundException('الحساب غير موجود');

    // Opening balance = every posted line BEFORE `from`.
    let opening = 0;
    if (from) {
      const [row] = await this.ds.query(
        `SELECT
           COALESCE(SUM(
             CASE WHEN $2 = 'debit'
               THEN jl.debit - jl.credit
               ELSE jl.credit - jl.debit
             END
           ), 0)::numeric(14,2) AS opening
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_id = $1
          AND je.is_posted = TRUE AND je.is_void = FALSE
          AND je.entry_date < $3::date`,
        [accountId, account.normal_balance, from],
      );
      opening = Number(row?.opening || 0);
    }

    const conds: string[] = [
      'jl.account_id = $1',
      'je.is_posted = TRUE',
      'je.is_void = FALSE',
    ];
    const args: any[] = [accountId];
    if (from) {
      args.push(from);
      conds.push(`je.entry_date >= $${args.length}::date`);
    }
    if (to) {
      args.push(to);
      conds.push(`je.entry_date <= $${args.length}::date`);
    }

    const rows = await this.ds.query(
      `
      SELECT jl.id, jl.line_no, jl.debit, jl.credit, jl.description,
             je.entry_no, je.entry_date, je.description AS entry_description,
             je.reference_type, je.reference_id
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
       WHERE ${conds.join(' AND ')}
       ORDER BY je.entry_date ASC, je.entry_no ASC, jl.line_no ASC
      `,
      args,
    );

    // Compute running balance line-by-line.
    let bal = opening;
    const normalDebit = account.normal_balance === 'debit';
    const lines = rows.map((r: any) => {
      const d = Number(r.debit || 0);
      const c = Number(r.credit || 0);
      bal += normalDebit ? d - c : c - d;
      return {
        ...r,
        debit: d,
        credit: c,
        running_balance: Number(bal.toFixed(2)),
      };
    });

    const totalDebit = lines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = lines.reduce(
      (s: number, l: any) => s + l.credit,
      0,
    );

    return {
      account,
      opening_balance: Number(opening.toFixed(2)),
      closing_balance: Number(bal.toFixed(2)),
      total_debit: Number(totalDebit.toFixed(2)),
      total_credit: Number(totalCredit.toFixed(2)),
      from: from || null,
      to: to || null,
      lines,
    };
  }

  /**
   * Income Statement — revenue (4xxx) minus expenses (5xxx) over a
   * date window. Returns one tree node per top-level + leaf entry so
   * the UI can render a collapsible hierarchy.
   */
  async incomeStatement(from: string, to: string) {
    const accounts = await this.ds.query(
      `SELECT id, code, name_ar, account_type, normal_balance,
              parent_id, is_leaf
         FROM chart_of_accounts
        WHERE account_type IN ('revenue', 'expense')
        ORDER BY code`,
    );
    const balances = await this.ds.query(
      `
      SELECT jl.account_id,
             COALESCE(SUM(jl.debit),  0)::numeric(14,2) AS total_debit,
             COALESCE(SUM(jl.credit), 0)::numeric(14,2) AS total_credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.is_posted = TRUE AND je.is_void = FALSE
         AND je.entry_date BETWEEN $1::date AND $2::date
       GROUP BY jl.account_id
      `,
      [from, to],
    );
    const byId: Record<string, { debit: number; credit: number }> = {};
    for (const b of balances) {
      byId[b.account_id] = {
        debit: Number(b.total_debit),
        credit: Number(b.total_credit),
      };
    }

    // Enrich each account with its period balance.
    const enriched = accounts.map((a: any) => {
      const b = byId[a.id] || { debit: 0, credit: 0 };
      const normalDebit = a.normal_balance === 'debit';
      const amount = normalDebit ? b.debit - b.credit : b.credit - b.debit;
      return { ...a, amount: Number(amount.toFixed(2)) };
    });

    // Aggregate from leaves up — each parent's amount = sum of children.
    const byParent: Record<string, any[]> = {};
    for (const a of enriched) {
      (byParent[a.parent_id || '__root__'] ||= []).push(a);
    }
    function sumTree(node: any): number {
      if (node.is_leaf) return node.amount;
      let s = 0;
      for (const kid of byParent[node.id] || []) s += sumTree(kid);
      node.amount = Number(s.toFixed(2));
      return s;
    }
    const roots = enriched.filter((a: any) => !a.parent_id);
    for (const r of roots) sumTree(r);

    // Top-line totals.
    const totalRevenue = enriched
      .filter((a: any) => a.account_type === 'revenue' && !a.parent_id)
      .reduce((s: number, a: any) => s + a.amount, 0);
    const totalExpenses = enriched
      .filter((a: any) => a.account_type === 'expense' && !a.parent_id)
      .reduce((s: number, a: any) => s + a.amount, 0);

    return {
      from,
      to,
      accounts: enriched,
      total_revenue: Number(totalRevenue.toFixed(2)),
      total_expenses: Number(totalExpenses.toFixed(2)),
      net_profit: Number((totalRevenue - totalExpenses).toFixed(2)),
    };
  }

  /**
   * Balance Sheet — point-in-time snapshot. Uses every posted entry
   * up to `as_of`. Asset = Liability + Equity by construction (if the
   * ledger is consistent).
   */
  async balanceSheet(asOf: string) {
    const accounts = await this.ds.query(
      `SELECT id, code, name_ar, account_type, normal_balance,
              parent_id, is_leaf
         FROM chart_of_accounts
        WHERE account_type IN ('asset', 'liability', 'equity',
                               'revenue', 'expense')
        ORDER BY code`,
    );
    const balances = await this.ds.query(
      `
      SELECT jl.account_id,
             COALESCE(SUM(jl.debit),  0)::numeric(14,2) AS total_debit,
             COALESCE(SUM(jl.credit), 0)::numeric(14,2) AS total_credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.is_posted = TRUE AND je.is_void = FALSE
         AND je.entry_date <= $1::date
       GROUP BY jl.account_id
      `,
      [asOf],
    );
    const byId: Record<string, { debit: number; credit: number }> = {};
    for (const b of balances) {
      byId[b.account_id] = {
        debit: Number(b.total_debit),
        credit: Number(b.total_credit),
      };
    }
    const enriched = accounts.map((a: any) => {
      const b = byId[a.id] || { debit: 0, credit: 0 };
      const normalDebit = a.normal_balance === 'debit';
      const amount = normalDebit ? b.debit - b.credit : b.credit - b.debit;
      return { ...a, amount: Number(amount.toFixed(2)) };
    });

    const byParent: Record<string, any[]> = {};
    for (const a of enriched) {
      (byParent[a.parent_id || '__root__'] ||= []).push(a);
    }
    function sumTree(node: any): number {
      if (node.is_leaf) return node.amount;
      let s = 0;
      for (const kid of byParent[node.id] || []) s += sumTree(kid);
      node.amount = Number(s.toFixed(2));
      return s;
    }
    const roots = enriched.filter((a: any) => !a.parent_id);
    for (const r of roots) sumTree(r);

    // Retained earnings = revenue − expenses up to as_of (closing entry
    // not yet automated, so we compute it on the fly).
    const totalRevenue = enriched
      .filter((a: any) => a.account_type === 'revenue' && !a.parent_id)
      .reduce((s: number, a: any) => s + a.amount, 0);
    const totalExpenses = enriched
      .filter((a: any) => a.account_type === 'expense' && !a.parent_id)
      .reduce((s: number, a: any) => s + a.amount, 0);
    const periodNetProfit = Number((totalRevenue - totalExpenses).toFixed(2));

    const totalAssets = enriched
      .filter((a: any) => a.account_type === 'asset' && !a.parent_id)
      .reduce((s: number, a: any) => s + a.amount, 0);
    const totalLiab = enriched
      .filter((a: any) => a.account_type === 'liability' && !a.parent_id)
      .reduce((s: number, a: any) => s + a.amount, 0);
    const bookEquity = enriched
      .filter((a: any) => a.account_type === 'equity' && !a.parent_id)
      .reduce((s: number, a: any) => s + a.amount, 0);
    // Total equity including the unclosed P&L.
    const totalEquity = Number((bookEquity + periodNetProfit).toFixed(2));

    return {
      as_of: asOf,
      accounts: enriched.filter((a: any) =>
        ['asset', 'liability', 'equity'].includes(a.account_type),
      ),
      total_assets: Number(totalAssets.toFixed(2)),
      total_liabilities: Number(totalLiab.toFixed(2)),
      book_equity: Number(bookEquity.toFixed(2)),
      period_net_profit: periodNetProfit,
      total_equity: totalEquity,
      balanced:
        Math.abs(totalAssets - (totalLiab + totalEquity)) < 0.01,
    };
  }

  /**
   * Per-customer ledger — journal lines tagged with this customer_id.
   * If the party-tracking columns don't exist yet, falls back to the
   * customers.current_balance figure.
   */
  async customerLedger(customerId: string, from?: string, to?: string) {
    const [hasCol] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='journal_lines' AND column_name='customer_id') AS has_col`,
    );
    if (!hasCol?.has_col) {
      const [c] = await this.ds.query(
        `SELECT id, code, full_name, current_balance FROM customers WHERE id = $1`,
        [customerId],
      );
      return {
        customer: c,
        from: from || null,
        to: to || null,
        opening_balance: 0,
        total_debit: 0,
        total_credit: 0,
        closing_balance: Number(c?.current_balance || 0),
        lines: [],
        note: 'GL customer tracking not available; showing balance only.',
      };
    }
    const [customer] = await this.ds.query(
      `SELECT id, code, full_name, current_balance FROM customers WHERE id = $1`,
      [customerId],
    );
    return this.partyLedger({
      partyColumn: 'customer_id',
      partyId: customerId,
      party: customer,
      from,
      to,
    });
  }

  async supplierLedger(supplierId: string, from?: string, to?: string) {
    const [hasCol] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='journal_lines' AND column_name='supplier_id') AS has_col`,
    );
    if (!hasCol?.has_col) {
      const [s] = await this.ds.query(
        `SELECT id, code, name, current_balance FROM suppliers WHERE id = $1`,
        [supplierId],
      );
      return {
        supplier: s,
        from: from || null,
        to: to || null,
        opening_balance: 0,
        total_debit: 0,
        total_credit: 0,
        closing_balance: Number(s?.current_balance || 0),
        lines: [],
        note: 'GL supplier tracking not available; showing balance only.',
      };
    }
    const [supplier] = await this.ds.query(
      `SELECT id, code, name, current_balance FROM suppliers WHERE id = $1`,
      [supplierId],
    );
    return this.partyLedger({
      partyColumn: 'supplier_id',
      partyId: supplierId,
      party: supplier,
      from,
      to,
    });
  }

  private async partyLedger(args: {
    partyColumn: 'customer_id' | 'supplier_id';
    partyId: string;
    party: any;
    from?: string;
    to?: string;
  }) {
    const { partyColumn, partyId, party, from, to } = args;
    if (!party) throw new NotFoundException('الطرف غير موجود');

    // Opening
    let opening = 0;
    if (from) {
      const [r] = await this.ds.query(
        `
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(14,2) AS opening
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.${partyColumn} = $1
           AND je.is_posted = TRUE AND je.is_void = FALSE
           AND je.entry_date < $2::date
        `,
        [partyId, from],
      );
      opening = Number(r?.opening || 0);
    }
    const conds = [
      `jl.${partyColumn} = $1`,
      `je.is_posted = TRUE`,
      `je.is_void = FALSE`,
    ];
    const params: any[] = [partyId];
    if (from) {
      params.push(from);
      conds.push(`je.entry_date >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conds.push(`je.entry_date <= $${params.length}::date`);
    }
    const rows = await this.ds.query(
      `
      SELECT jl.id, jl.debit, jl.credit, jl.description,
             je.entry_no, je.entry_date, je.description AS entry_description,
             je.reference_type, je.reference_id,
             a.code AS account_code, a.name_ar AS account_name
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN chart_of_accounts a ON a.id = jl.account_id
       WHERE ${conds.join(' AND ')}
       ORDER BY je.entry_date ASC, je.entry_no ASC, jl.line_no ASC
      `,
      params,
    );

    let bal = opening;
    const lines = rows.map((r: any) => {
      const d = Number(r.debit || 0);
      const c = Number(r.credit || 0);
      // Customer: DR = they owe more; CR = they paid. Supplier opposite.
      bal += d - c;
      return { ...r, debit: d, credit: c, running_balance: Number(bal.toFixed(2)) };
    });

    const totalDebit = lines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + l.credit, 0);

    return {
      [partyColumn === 'customer_id' ? 'customer' : 'supplier']: party,
      from: from || null,
      to: to || null,
      opening_balance: Number(opening.toFixed(2)),
      closing_balance: Number(bal.toFixed(2)),
      total_debit: Number(totalDebit.toFixed(2)),
      total_credit: Number(totalCredit.toFixed(2)),
      lines,
    };
  }

  /**
   * Aging report — buckets unpaid receivables/payables by age.
   * `type='receivable'` reads unpaid customer invoices.
   * `type='payable'` reads unpaid purchase invoices.
   */
  async aging(type: 'receivable' | 'payable', asOf?: string) {
    const asOfDate =
      asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
        ? asOf
        : new Date().toISOString().slice(0, 10);

    const buckets = [
      { label: '0-30', min: 0, max: 30 },
      { label: '31-60', min: 31, max: 60 },
      { label: '61-90', min: 61, max: 90 },
      { label: '90+', min: 91, max: 99999 },
    ];

    if (type === 'receivable') {
      const rows = await this.ds.query(
        `
        SELECT i.id, i.invoice_no,
               COALESCE(i.completed_at, i.created_at)::date AS doc_date,
               i.grand_total, i.paid_amount,
               (i.grand_total - i.paid_amount)::numeric(14,2) AS outstanding,
               ($1::date - COALESCE(i.completed_at, i.created_at)::date)::int AS age_days,
               c.id AS customer_id, c.code AS customer_code, c.full_name AS customer_name
          FROM invoices i
          LEFT JOIN customers c ON c.id = i.customer_id
         WHERE i.status IN ('paid','completed','partially_paid')
           AND i.grand_total > i.paid_amount
           AND COALESCE(i.completed_at, i.created_at)::date <= $1::date
         ORDER BY age_days DESC
        `,
        [asOfDate],
      );
      return this.aggregateAging(rows, buckets, 'customer_id', 'customer_name', 'customer_code');
    }

    // payable
    const rows = await this.ds.query(
      `
      SELECT p.id, p.purchase_no,
             COALESCE(p.received_at, p.invoice_date)::date AS doc_date,
             p.grand_total, p.paid_amount,
             (p.grand_total - p.paid_amount)::numeric(14,2) AS outstanding,
             ($1::date - COALESCE(p.received_at, p.invoice_date)::date)::int AS age_days,
             s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name
        FROM purchases p
        LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.status IN ('received','partial','paid')
         AND p.grand_total > p.paid_amount
         AND COALESCE(p.received_at, p.invoice_date)::date <= $1::date
       ORDER BY age_days DESC
      `,
      [asOfDate],
    );
    return this.aggregateAging(rows, buckets, 'supplier_id', 'supplier_name', 'supplier_code');
  }

  /**
   * Trial balance comparison across multiple periods.
   * `periods` is an array of { from, to, label } — each column renders
   * the balance per account. Deltas computed per adjacent pair.
   */
  async trialBalanceComparison(
    periods: Array<{ from: string; to: string; label: string }>,
  ) {
    const accounts = await this.ds.query(
      `SELECT id, code, name_ar, account_type, normal_balance
         FROM chart_of_accounts
        WHERE is_active = TRUE AND is_leaf = TRUE
        ORDER BY code`,
    );
    const columns: Array<{ label: string; balances: Record<string, number> }> =
      [];
    for (const p of periods) {
      const rows = await this.ds.query(
        `
        SELECT a.id,
               CASE a.normal_balance
                 WHEN 'debit' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
                 ELSE              COALESCE(SUM(jl.credit - jl.debit), 0)
               END::numeric(14,2) AS balance
          FROM chart_of_accounts a
          LEFT JOIN journal_lines jl ON jl.account_id = a.id
          LEFT JOIN journal_entries je ON je.id = jl.entry_id
           AND je.is_posted = TRUE AND je.is_void = FALSE
           AND je.entry_date BETWEEN $1::date AND $2::date
         WHERE a.is_active = TRUE AND a.is_leaf = TRUE
         GROUP BY a.id
        `,
        [p.from, p.to],
      );
      const bal: Record<string, number> = {};
      for (const r of rows) bal[r.id] = Number(r.balance || 0);
      columns.push({ label: p.label, balances: bal });
    }
    return { accounts, columns };
  }

  private aggregateAging(
    rows: any[],
    buckets: Array<{ label: string; min: number; max: number }>,
    idCol: string,
    nameCol: string,
    codeCol: string,
  ) {
    const byParty: Record<
      string,
      {
        id: string;
        code: string;
        name: string;
        total: number;
        buckets: Record<string, number>;
      }
    > = {};
    for (const r of rows) {
      const pid = r[idCol];
      if (!pid) continue;
      const pkey = String(pid);
      if (!byParty[pkey]) {
        byParty[pkey] = {
          id: pid,
          code: r[codeCol] || '',
          name: r[nameCol] || '',
          total: 0,
          buckets: Object.fromEntries(buckets.map((b) => [b.label, 0])),
        };
      }
      const out = Number(r.outstanding || 0);
      const age = Number(r.age_days || 0);
      byParty[pkey].total += out;
      for (const b of buckets) {
        if (age >= b.min && age <= b.max) {
          byParty[pkey].buckets[b.label] += out;
          break;
        }
      }
    }
    const parties = Object.values(byParty).map((p) => ({
      ...p,
      total: Number(p.total.toFixed(2)),
      buckets: Object.fromEntries(
        Object.entries(p.buckets).map(([k, v]) => [k, Number(Number(v).toFixed(2))]),
      ),
    }));
    parties.sort((a, b) => b.total - a.total);
    const totals = buckets.reduce(
      (acc, b) => {
        acc[b.label] = Number(
          parties.reduce((s, p) => s + (p.buckets[b.label] || 0), 0).toFixed(2),
        );
        return acc;
      },
      { total: 0 } as Record<string, number>,
    );
    totals.total = Number(parties.reduce((s, p) => s + p.total, 0).toFixed(2));
    return {
      buckets: buckets.map((b) => b.label),
      parties,
      totals,
      invoice_count: rows.length,
    };
  }
}
