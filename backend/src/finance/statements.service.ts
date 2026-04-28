/**
 * statements.service.ts — PR-FIN-3
 * ────────────────────────────────────────────────────────────────────
 *
 * Read-only statement composer for the five logical sources behind
 * the seven UI tabs. The service NEVER writes; per-request
 * concurrency stays at 1 (sequential awaits) — same lesson PR-FIN-2-
 * HOTFIX-2 enforced.
 *
 * One helper per source produces a `StatementResponse`:
 *   · glAccountStatement      — chart_of_accounts × journal_lines
 *   · cashboxStatement        — v_cashbox_movements (covers cash/bank/wallet)
 *   · employeeStatement       — v_employee_ledger + v_employee_balances_gl
 *   · customerStatement       — customer_ledger + invoice context
 *   · supplierStatement       — supplier_ledger + purchases context
 *
 * Opening balance is always computed from rows BEFORE `range.from`
 * (sub-ledgers carry their own `balance_after` on each row, which we
 * trust if present; otherwise we accumulate). Running balance is
 * computed in the service (not in SQL) so the math is testable in
 * isolation.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  StatementFilters,
  StatementResponse,
  StatementRow,
} from './statements.types';

@Injectable()
export class StatementsService {
  constructor(private readonly ds: DataSource) {}

  // ─── GL account statement ────────────────────────────────────────
  async glAccountStatement(
    accountId: string,
    f: StatementFilters,
  ): Promise<StatementResponse> {
    const range = this.resolveRange(f);
    const includeVoided = !!f.include_voided;

    // Entity lookup
    const accountRows = await this.ds.query(
      `SELECT id, code, name_ar, name_en, account_type, normal_balance, is_leaf
         FROM chart_of_accounts WHERE id = $1`,
      [accountId],
    );
    if (accountRows.length === 0) {
      throw new NotFoundException(`account ${accountId} not found`);
    }
    const acc = accountRows[0];

    // Opening balance = SUM(debit) - SUM(credit) for posted, non-void
    // entries strictly BEFORE range.from.
    const openingRow = await this.ds.query(
      `SELECT COALESCE(SUM(jl.debit), 0)  AS d,
              COALESCE(SUM(jl.credit), 0) AS c
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_id = $1
           AND je.is_posted = TRUE
           AND je.is_void   = FALSE
           AND je.entry_date < $2::date`,
      [accountId, range.from],
    );
    const opening = round2(
      Number(openingRow[0]?.d ?? 0) - Number(openingRow[0]?.c ?? 0),
    );

    // Range lines
    const lines = await this.ds.query(
      `SELECT je.entry_no, je.entry_date, je.created_at, je.is_void,
              je.reference_type, je.reference_id, je.description AS je_desc,
              jl.debit, jl.credit, jl.description AS line_desc,
              jl.cashbox_id
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_id = $1
           AND je.is_posted = TRUE
           ${includeVoided ? '' : 'AND je.is_void = FALSE'}
           AND je.entry_date >= $2::date
           AND je.entry_date <= $3::date
         ORDER BY je.entry_date ASC, je.created_at ASC, je.entry_no ASC`,
      [accountId, range.from, range.to],
    );

    let running = opening;
    let totDebit = 0;
    let totCredit = 0;
    const rows: StatementRow[] = lines.map((l: any) => {
      const debit = Number(l.debit ?? 0);
      const credit = Number(l.credit ?? 0);
      const isVoided = !!l.is_void;
      // Voided lines do NOT move running_balance — they're shown for
      // transparency only (struck-through in the UI).
      if (!isVoided) {
        running = round2(running + debit - credit);
        totDebit = round2(totDebit + debit);
        totCredit = round2(totCredit + credit);
      }
      return {
        occurred_at: this.toIso(l.created_at),
        event_date: this.toDate(l.entry_date),
        description: l.line_desc || l.je_desc || '—',
        reference_type: l.reference_type ?? null,
        reference_no: l.entry_no ?? null,
        debit: round2(debit),
        credit: round2(credit),
        running_balance: running,
        counterparty: null,
        journal_entry_no: l.entry_no ?? null,
        drilldown_url: null,
        is_voided: isVoided,
      };
    });

    return {
      entity: {
        type: 'gl_account',
        id: acc.id,
        code: acc.code,
        name_ar: acc.name_ar,
        name_en: acc.name_en,
        extra: {
          account_type: acc.account_type,
          normal_balance: acc.normal_balance,
          is_leaf: acc.is_leaf,
        },
      },
      range,
      opening_balance: opening,
      closing_balance: running,
      totals: {
        debit: totDebit,
        credit: totCredit,
        net: round2(totDebit - totCredit),
        lines: rows.filter((r) => !r.is_voided).length,
      },
      rows,
      confidence: {
        has_data: rows.length > 0,
        data_source: 'gl_lines',
        note:
          rows.length === 0
            ? 'لا توجد حركات على هذا الحساب في الفترة المختارة.'
            : null,
        context: null,
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ─── Cashbox statement (cash / bank / wallet) ────────────────────
  async cashboxStatement(
    cashboxId: string,
    f: StatementFilters,
  ): Promise<StatementResponse> {
    const range = this.resolveRange(f);

    const cbRows = await this.ds.query(
      `SELECT id, name_ar, name_en, kind, currency, opening_balance, current_balance
         FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    if (cbRows.length === 0) {
      throw new NotFoundException(`cashbox ${cashboxId} not found`);
    }
    const cb = cbRows[0];

    // Opening = cb.opening_balance + signed sum of CT before range.from
    const openingRow = await this.ds.query(
      `SELECT COALESCE(SUM(
              CASE WHEN ct.direction='in' THEN ct.amount ELSE -ct.amount END
            ), 0) AS net_before
         FROM cashbox_transactions ct
         WHERE ct.cashbox_id = $1
           AND ct.is_void = FALSE
           AND ct.created_at < $2::date`,
      [cashboxId, range.from],
    );
    const opening = round2(
      Number(cb.opening_balance ?? 0) + Number(openingRow[0]?.net_before ?? 0),
    );

    // Range movements via the v_cashbox_movements view (already exposes
    // counterparty_name + reference_no + balance_after).
    const direction = f.direction;
    const lines = await this.ds.query(
      `SELECT id, direction, amount, category, reference_type, reference_id,
              balance_after, notes, user_name, kind_ar, reference_no,
              counterparty_name, created_at
         FROM v_cashbox_movements
         WHERE cashbox_id = $1
           AND created_at >= $2::date
           AND created_at <  ($3::date + INTERVAL '1 day')
           ${direction ? 'AND direction = $4' : ''}
         ORDER BY created_at ASC`,
      direction
        ? [cashboxId, range.from, range.to, direction]
        : [cashboxId, range.from, range.to],
    );

    let running = opening;
    let totDebit = 0;  // money in
    let totCredit = 0; // money out
    const rows: StatementRow[] = lines.map((l: any) => {
      const amount = Number(l.amount ?? 0);
      const dirIn = l.direction === 'in';
      const debit = dirIn ? amount : 0;
      const credit = dirIn ? 0 : amount;
      running = round2(running + (dirIn ? amount : -amount));
      totDebit = round2(totDebit + debit);
      totCredit = round2(totCredit + credit);
      return {
        occurred_at: this.toIso(l.created_at),
        event_date: this.toDate(l.created_at),
        description: l.kind_ar || l.notes || l.category || '—',
        reference_type: l.reference_type ?? null,
        reference_no: l.reference_no ?? null,
        debit,
        credit,
        running_balance: running,
        counterparty: l.counterparty_name ?? null,
        journal_entry_no: null,
        drilldown_url: null,
        is_voided: false, // view excludes voided already? defensive: assume false
      };
    });

    return {
      entity: {
        type: 'cashbox',
        id: cb.id,
        code: null,
        name_ar: cb.name_ar,
        name_en: cb.name_en,
        extra: {
          kind: cb.kind,
          currency: cb.currency,
          opening_balance: Number(cb.opening_balance ?? 0),
          current_balance: Number(cb.current_balance ?? 0),
        },
      },
      range,
      opening_balance: opening,
      closing_balance: running,
      totals: {
        debit: totDebit,
        credit: totCredit,
        net: round2(totDebit - totCredit),
        lines: rows.length,
      },
      rows,
      confidence: {
        has_data: rows.length > 0,
        data_source: 'cashbox_view',
        note:
          rows.length === 0
            ? 'لا توجد حركات على هذه الخزنة في الفترة المختارة.'
            : null,
        context: null,
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ─── Employee statement ──────────────────────────────────────────
  async employeeStatement(
    userId: string,
    f: StatementFilters,
  ): Promise<StatementResponse> {
    const range = this.resolveRange(f);

    const userRows = await this.ds.query(
      `SELECT id, full_name, employee_no, username, deleted_at
         FROM users WHERE id = $1`,
      [userId],
    );
    if (userRows.length === 0) {
      throw new NotFoundException(`user ${userId} not found`);
    }
    const u = userRows[0];

    // Opening = sum of amount_owed_delta before range.from
    const openingRow = await this.ds.query(
      `SELECT COALESCE(SUM(amount_owed_delta), 0) AS net_before
         FROM v_employee_ledger
         WHERE user_id = $1
           AND event_date < $2::date`,
      [userId, range.from],
    );
    const opening = round2(Number(openingRow[0]?.net_before ?? 0));

    const lines = await this.ds.query(
      `SELECT event_date, created_at, entry_type, description,
              amount_owed_delta, gross_amount, reference_type, reference_id,
              shift_id, journal_entry_id, notes
         FROM v_employee_ledger
         WHERE user_id = $1
           AND event_date >= $2::date
           AND event_date <= $3::date
         ORDER BY event_date ASC, created_at ASC`,
      [userId, range.from, range.to],
    );

    // amount_owed_delta is signed: positive = company owes employee
    // (debit side of the employee receivable account 1123); negative
    // = employee owes company (credit side / 213). Map the sign into
    // debit/credit columns so the table reads naturally.
    let running = opening;
    let totDebit = 0;
    let totCredit = 0;
    const rows: StatementRow[] = lines.map((l: any) => {
      const delta = Number(l.amount_owed_delta ?? 0);
      const debit = delta > 0 ? delta : 0;
      const credit = delta < 0 ? -delta : 0;
      running = round2(running + delta);
      totDebit = round2(totDebit + debit);
      totCredit = round2(totCredit + credit);
      return {
        occurred_at: this.toIso(l.created_at),
        event_date: this.toDate(l.event_date),
        description: l.description || l.entry_type || '—',
        reference_type: l.reference_type ?? null,
        reference_no: typeof l.reference_id === 'string'
          ? l.reference_id
          : null,
        debit,
        credit,
        running_balance: running,
        counterparty: null,
        journal_entry_no: l.journal_entry_id ? String(l.journal_entry_id) : null,
        drilldown_url: null,
        is_voided: false,
      };
    });

    return {
      entity: {
        type: 'employee',
        id: u.id,
        code: u.employee_no ?? null,
        name_ar: u.full_name,
        name_en: null,
        extra: {
          username: u.username,
          deleted: !!u.deleted_at,
        },
      },
      range,
      opening_balance: opening,
      closing_balance: running,
      totals: {
        debit: totDebit,
        credit: totCredit,
        net: round2(totDebit - totCredit),
        lines: rows.length,
      },
      rows,
      confidence: {
        has_data: rows.length > 0,
        data_source: 'employee_view',
        note:
          rows.length === 0
            ? 'لا توجد حركات لهذا الموظف في الفترة المختارة.'
            : null,
        context: null,
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ─── Customer statement ──────────────────────────────────────────
  async customerStatement(
    customerId: string,
    f: StatementFilters,
  ): Promise<StatementResponse> {
    const range = this.resolveRange(f);

    const cRows = await this.ds.query(
      `SELECT id, customer_no, full_name, phone, current_balance
         FROM customers WHERE id = $1 AND deleted_at IS NULL`,
      [customerId],
    );
    if (cRows.length === 0) {
      throw new NotFoundException(`customer ${customerId} not found`);
    }
    const c = cRows[0];

    // customer_ledger.balance_after reflects the running balance; we
    // compute opening from the last row before range.from. If the
    // ledger is empty for this customer entirely, opening = 0.
    const openingRow = await this.ds.query(
      `SELECT balance_after
         FROM customer_ledger
         WHERE customer_id = $1
           AND entry_date < $2::date
         ORDER BY entry_date DESC, id DESC
         LIMIT 1`,
      [customerId, range.from],
    );
    const opening = round2(Number(openingRow[0]?.balance_after ?? 0));

    const lines = await this.ds.query(
      `SELECT id, entry_date, direction, amount, reference_type,
              reference_id, balance_after, notes, created_at
         FROM customer_ledger
         WHERE customer_id = $1
           AND entry_date >= $2::date
           AND entry_date <= $3::date
         ORDER BY entry_date ASC, id ASC`,
      [customerId, range.from, range.to],
    );

    // Compute confidence context — useful even when rows is non-empty.
    // Surfaces "X من أصل Y فاتورة في الفترة" when the customer's
    // walk-in pattern dominates.
    const ctxRow = await this.ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE i.created_at >= $1::date
                            AND i.created_at <  ($2::date + INTERVAL '1 day')
                            AND i.is_return = FALSE
                            AND i.status <> 'cancelled'
                            AND i.voided_at IS NULL)                AS total_invoices,
         COUNT(*) FILTER (WHERE i.created_at >= $1::date
                            AND i.created_at <  ($2::date + INTERVAL '1 day')
                            AND i.is_return = FALSE
                            AND i.status <> 'cancelled'
                            AND i.voided_at IS NULL
                            AND i.customer_id IS NULL)              AS walk_in_invoices
       FROM invoices i`,
      [range.from, range.to],
    );
    const totalInv = Number(ctxRow[0]?.total_invoices ?? 0);
    const walkIn = Number(ctxRow[0]?.walk_in_invoices ?? 0);

    let running = opening;
    let totDebit = 0;
    let totCredit = 0;
    const rows: StatementRow[] = lines.map((l: any) => {
      // Customer ledger direction:
      //   'debit'  = customer owes more (sale)
      //   'credit' = customer paid / discount applied
      const amount = Number(l.amount ?? 0);
      const isDebit = l.direction === 'debit';
      const debit = isDebit ? amount : 0;
      const credit = isDebit ? 0 : amount;
      running = round2(running + (isDebit ? amount : -amount));
      totDebit = round2(totDebit + debit);
      totCredit = round2(totCredit + credit);
      return {
        occurred_at: this.toIso(l.created_at),
        event_date: this.toDate(l.entry_date),
        description: l.notes || (l.reference_type as string) || '—',
        reference_type: l.reference_type ?? null,
        reference_no: l.reference_id ? String(l.reference_id) : null,
        debit,
        credit,
        running_balance: running,
        counterparty: null,
        journal_entry_no: null,
        drilldown_url: null,
        is_voided: false,
      };
    });

    // Empty-state note. Dynamic — never hardcodes counts.
    let note: string | null = null;
    if (rows.length === 0) {
      if (totalInv > 0 && walkIn === totalInv) {
        note = `كل فواتير الفترة (${totalInv}) غير مرتبطة بعميل محدد، لذلك لا توجد حركات لهذا العميل في الكشف.`;
      } else if (walkIn > 0 && walkIn / Math.max(totalInv, 1) >= 0.5) {
        note = `معظم فواتير الفترة غير مرتبطة بعميل محدد (${walkIn} من أصل ${totalInv})، لذلك لا توجد حركات كافية لهذا العميل في الكشف.`;
      } else {
        note = 'لا توجد حركات لهذا العميل في الفترة المختارة.';
      }
    }

    return {
      entity: {
        type: 'customer',
        id: c.id,
        code: c.customer_no ?? null,
        name_ar: c.full_name,
        name_en: null,
        extra: {
          phone: c.phone,
          current_balance: Number(c.current_balance ?? 0),
        },
      },
      range,
      opening_balance: opening,
      closing_balance: running,
      totals: {
        debit: totDebit,
        credit: totCredit,
        net: round2(totDebit - totCredit),
        lines: rows.length,
      },
      rows,
      confidence: {
        has_data: rows.length > 0,
        data_source: 'customer_ledger',
        note,
        context: {
          period_total_invoices: totalInv,
          period_walk_in_invoices: walkIn,
        },
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ─── Supplier statement ──────────────────────────────────────────
  async supplierStatement(
    supplierId: string,
    f: StatementFilters,
  ): Promise<StatementResponse> {
    const range = this.resolveRange(f);

    const sRows = await this.ds.query(
      `SELECT id, supplier_no, name, phone, current_balance
         FROM suppliers WHERE id = $1 AND deleted_at IS NULL`,
      [supplierId],
    );
    if (sRows.length === 0) {
      throw new NotFoundException(`supplier ${supplierId} not found`);
    }
    const s = sRows[0];

    const openingRow = await this.ds.query(
      `SELECT balance_after
         FROM supplier_ledger
         WHERE supplier_id = $1
           AND entry_date < $2::date
         ORDER BY entry_date DESC, id DESC
         LIMIT 1`,
      [supplierId, range.from],
    );
    const opening = round2(Number(openingRow[0]?.balance_after ?? 0));

    const lines = await this.ds.query(
      `SELECT id, entry_date, direction, amount, reference_type,
              reference_id, balance_after, notes, created_at
         FROM supplier_ledger
         WHERE supplier_id = $1
           AND entry_date >= $2::date
           AND entry_date <= $3::date
         ORDER BY entry_date ASC, id ASC`,
      [supplierId, range.from, range.to],
    );

    // Context: count purchases + payments in the period for the empty
    // state to be informative.
    const ctxRow = await this.ds.query(
      `SELECT
         (SELECT COUNT(*) FROM purchases
           WHERE supplier_id = $1
             AND created_at >= $2::date
             AND created_at <  ($3::date + INTERVAL '1 day')) AS purchase_count,
         (SELECT COUNT(*) FROM supplier_payments
           WHERE supplier_id = $1
             AND created_at >= $2::date
             AND created_at <  ($3::date + INTERVAL '1 day')
             AND COALESCE(is_void, FALSE) = FALSE) AS payment_count`,
      [supplierId, range.from, range.to],
    );
    const purchaseCount = Number(ctxRow[0]?.purchase_count ?? 0);
    const paymentCount = Number(ctxRow[0]?.payment_count ?? 0);

    let running = opening;
    let totDebit = 0;
    let totCredit = 0;
    const rows: StatementRow[] = lines.map((l: any) => {
      // Supplier ledger direction (mirror of customer):
      //   'credit' = supplier credit increases (purchase invoice)
      //   'debit'  = we paid the supplier
      const amount = Number(l.amount ?? 0);
      const isDebit = l.direction === 'debit';
      const debit = isDebit ? amount : 0;
      const credit = isDebit ? 0 : amount;
      running = round2(running + (isDebit ? -amount : amount));
      totDebit = round2(totDebit + debit);
      totCredit = round2(totCredit + credit);
      return {
        occurred_at: this.toIso(l.created_at),
        event_date: this.toDate(l.entry_date),
        description: l.notes || (l.reference_type as string) || '—',
        reference_type: l.reference_type ?? null,
        reference_no: l.reference_id ? String(l.reference_id) : null,
        debit,
        credit,
        running_balance: running,
        counterparty: null,
        journal_entry_no: null,
        drilldown_url: null,
        is_voided: false,
      };
    });

    return {
      entity: {
        type: 'supplier',
        id: s.id,
        code: s.supplier_no ?? null,
        name_ar: s.name,
        name_en: null,
        extra: {
          phone: s.phone,
          current_balance: Number(s.current_balance ?? 0),
        },
      },
      range,
      opening_balance: opening,
      closing_balance: running,
      totals: {
        debit: totDebit,
        credit: totCredit,
        net: round2(totDebit - totCredit),
        lines: rows.length,
      },
      rows,
      confidence: {
        has_data: rows.length > 0,
        data_source: 'supplier_ledger',
        note:
          rows.length === 0
            ? 'لا توجد فواتير شراء أو دفعات مورد مسجلة لهذا المورد في الفترة المختارة.'
            : null,
        context: {
          period_purchase_count: purchaseCount,
          period_payment_count: paymentCount,
        },
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  private resolveRange(f: StatementFilters): { from: string; to: string } {
    if (f.from && f.to) return { from: f.from, to: f.to };
    // Default = current Cairo month, day 1 → today.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')!.value;
    const m = parts.find((p) => p.type === 'month')!.value;
    const d = parts.find((p) => p.type === 'day')!.value;
    return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
  }

  private toIso(v: any): string {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
    return new Date().toISOString();
  }

  private toDate(v: any): string {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'string') return v.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }
}

// ─── Module-private helper ───────────────────────────────────────
function round2(n: any): number {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
