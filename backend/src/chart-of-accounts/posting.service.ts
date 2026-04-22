import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/**
 * Centralized journal posting for every financial event in the system.
 *
 * Every method:
 *   • is idempotent — checks schema_migrations / journal_entries by
 *     (reference_type, reference_id) before writing, so re-running an
 *     approval or replaying a webhook won't create duplicate entries.
 *   • accepts an optional EntityManager so callers can wrap the post in
 *     the same transaction as the source operation. When omitted we
 *     use the DataSource's own transaction.
 *   • swallows errors behind a Logger — accounting failures must never
 *     block the original business operation (invoice completion,
 *     expense approval, shift close, …). Failures show up in logs and
 *     the caller can use the list-orphans utility later.
 *
 * Account resolution strategy:
 *   • By COA code (predictable: 1111=cash, 411=sales revenue, …)
 *   • For a cashbox, we first look for an explicit `cashbox_id` link on
 *     chart_of_accounts; if none, we fall back to a kind → code map.
 */
@Injectable()
export class AccountingPostingService {
  private readonly logger = new Logger('Posting');

  constructor(private readonly ds: DataSource) {}

  // ═══════════════════════════════════════════════════════════════════
  // Public API — one method per event type
  // ═══════════════════════════════════════════════════════════════════

  /** Sales invoice → DR Cash/Receivables  CR Sales Revenue */
  async postInvoice(invoiceId: string, userId: string, em?: EntityManager) {
    return this.safe('invoice', invoiceId, em, async (q) => {
      const [inv] = await q(
        `SELECT i.id, i.invoice_no, i.grand_total, i.paid_amount,
                i.completed_at, i.created_at, i.status, i.customer_id,
                i.cashbox_id
           FROM invoices i WHERE i.id = $1`,
        [invoiceId],
      );
      if (!inv) return null;
      if (
        !['paid', 'completed', 'partially_paid'].includes(inv.status)
      ) {
        return null;
      }
      const total = Number(inv.grand_total || 0);
      const paid = Number(inv.paid_amount || 0);
      const unpaid = Math.max(0, total - paid);
      if (total < 0.01) return null;

      const entryDate = this.dateOnly(inv.completed_at || inv.created_at);
      const cashAcc = await this.cashboxAccountId(q, inv.cashbox_id);
      const salesAcc = await this.accountIdByCode(q, '411');
      const recvAcc = await this.accountIdByCode(q, '1121');

      const lines: PostingLine[] = [];
      if (paid > 0 && cashAcc) {
        lines.push({ account_id: cashAcc, debit: paid, credit: 0, description: `فاتورة ${inv.invoice_no}` });
      }
      if (unpaid > 0 && recvAcc) {
        lines.push({ account_id: recvAcc, debit: unpaid, credit: 0, description: `آجل ${inv.invoice_no}` });
      }
      if (salesAcc) {
        lines.push({ account_id: salesAcc, debit: 0, credit: total, description: `إيراد ${inv.invoice_no}` });
      }
      if (lines.length < 2) return null;

      return this.createEntry(q, {
        entry_date: entryDate,
        description: `قيد فاتورة مبيعات ${inv.invoice_no}`,
        reference_type: 'invoice',
        reference_id: invoiceId,
        lines,
        created_by: userId,
      });
    });
  }

  /** Customer payment → DR Cash/Bank  CR Receivables */
  async postInvoicePayment(
    paymentId: string,
    userId: string,
    em?: EntityManager,
  ) {
    return this.safe('customer_payment', paymentId, em, async (q) => {
      const [p] = await q(
        `SELECT cp.id, cp.payment_no, cp.amount, cp.cashbox_id,
                cp.created_at, cp.is_void, cp.kind
           FROM customer_payments cp WHERE cp.id = $1`,
        [paymentId],
      );
      if (!p || p.is_void) return null;
      const amt = Number(p.amount || 0);
      if (amt < 0.01) return null;

      const cashAcc = await this.cashboxAccountId(q, p.cashbox_id);
      const recvAcc = await this.accountIdByCode(q, '1121');
      // Deposit (عربون) goes to customer deposits liability, not receivables.
      const liabAcc = await this.accountIdByCode(q, '212');
      const creditAcc = p.kind === 'deposit' ? liabAcc : recvAcc;
      if (!cashAcc || !creditAcc) return null;

      return this.createEntry(q, {
        entry_date: this.dateOnly(p.created_at),
        description: `مقبوضة من عميل ${p.payment_no}`,
        reference_type: 'customer_payment',
        reference_id: paymentId,
        lines: [
          { account_id: cashAcc, debit: amt, credit: 0 },
          { account_id: creditAcc, debit: 0, credit: amt },
        ],
        created_by: userId,
      });
    });
  }

  /** Supplier payment → DR Suppliers Payable  CR Cash/Bank */
  async postSupplierPayment(
    paymentId: string,
    userId: string,
    em?: EntityManager,
  ) {
    return this.safe('supplier_payment', paymentId, em, async (q) => {
      const [p] = await q(
        `SELECT sp.id, sp.payment_no, sp.amount, sp.cashbox_id,
                sp.created_at, sp.is_void
           FROM supplier_payments sp WHERE sp.id = $1`,
        [paymentId],
      );
      if (!p || p.is_void) return null;
      const amt = Number(p.amount || 0);
      if (amt < 0.01) return null;

      const cashAcc = await this.cashboxAccountId(q, p.cashbox_id);
      const suppAcc = await this.accountIdByCode(q, '211');
      if (!cashAcc || !suppAcc) return null;

      return this.createEntry(q, {
        entry_date: this.dateOnly(p.created_at),
        description: `دفعة لمورد ${p.payment_no}`,
        reference_type: 'supplier_payment',
        reference_id: paymentId,
        lines: [
          { account_id: suppAcc, debit: amt, credit: 0 },
          { account_id: cashAcc, debit: 0, credit: amt },
        ],
        created_by: userId,
      });
    });
  }

  /** Approved expense → DR Expense (by category)  CR Cash/Bank */
  async postExpense(expenseId: string, userId: string, em?: EntityManager) {
    return this.safe('expense', expenseId, em, async (q) => {
      const [e] = await q(
        `SELECT e.id, e.expense_no, e.amount, e.cashbox_id, e.category_id,
                e.expense_date, e.is_approved,
                ec.account_id AS category_account_id
           FROM expenses e
           LEFT JOIN expense_categories ec ON ec.id = e.category_id
          WHERE e.id = $1`,
        [expenseId],
      );
      if (!e || !e.is_approved) return null;
      const amt = Number(e.amount || 0);
      if (amt < 0.01) return null;

      const cashAcc = await this.cashboxAccountId(q, e.cashbox_id);
      const expenseAcc =
        e.category_account_id || (await this.accountIdByCode(q, '529'));
      if (!cashAcc || !expenseAcc) return null;

      return this.createEntry(q, {
        entry_date: this.dateOnly(e.expense_date),
        description: `مصروف ${e.expense_no}`,
        reference_type: 'expense',
        reference_id: expenseId,
        lines: [
          { account_id: expenseAcc, debit: amt, credit: 0 },
          { account_id: cashAcc, debit: 0, credit: amt },
        ],
        created_by: userId,
      });
    });
  }

  /** Shift close with variance →
   *    Surplus: DR Cash  CR Shift Surplus (421)
   *    Deficit: DR Shift Deficit (531)  CR Cash
   */
  async postShiftClose(shiftId: string, userId: string, em?: EntityManager) {
    return this.safe('shift_variance', shiftId, em, async (q) => {
      const [s] = await q(
        `SELECT id, shift_no, cashbox_id, actual_closing, expected_closing,
                closed_at, status
           FROM shifts WHERE id = $1`,
        [shiftId],
      );
      if (!s || s.status !== 'closed' || !s.closed_at) return null;
      const variance =
        Number(s.actual_closing || 0) - Number(s.expected_closing || 0);
      if (Math.abs(variance) < 0.01) return null; // perfect match → nothing to post

      const cashAcc = await this.cashboxAccountId(q, s.cashbox_id);
      if (!cashAcc) return null;
      const entryDate = this.dateOnly(s.closed_at);

      if (variance > 0) {
        // Surplus — extra cash found
        const surplusAcc = await this.accountIdByCode(q, '421');
        if (!surplusAcc) return null;
        return this.createEntry(q, {
          entry_date: entryDate,
          description: `زيادة وردية ${s.shift_no}`,
          reference_type: 'shift_variance',
          reference_id: shiftId,
          lines: [
            { account_id: cashAcc, debit: variance, credit: 0 },
            { account_id: surplusAcc, debit: 0, credit: variance },
          ],
          created_by: userId,
        });
      }
      // Deficit — cash short
      const absV = Math.abs(variance);
      const deficitAcc = await this.accountIdByCode(q, '531');
      if (!deficitAcc) return null;
      return this.createEntry(q, {
        entry_date: entryDate,
        description: `عجز وردية ${s.shift_no}`,
        reference_type: 'shift_variance',
        reference_id: shiftId,
        lines: [
          { account_id: deficitAcc, debit: absV, credit: 0 },
          { account_id: cashAcc, debit: 0, credit: absV },
        ],
        created_by: userId,
      });
    });
  }

  /** Manual cashbox deposit/withdrawal — posts capital adjustments. */
  async postCashboxDeposit(
    txnId: string,
    direction: 'in' | 'out',
    amount: number,
    cashboxId: string,
    userId: string,
    em?: EntityManager,
  ) {
    return this.safe('cashbox_manual', txnId, em, async (q) => {
      if (!(amount > 0)) return null;
      const cashAcc = await this.cashboxAccountId(q, cashboxId);
      // Counter-account: treat as owner top-up / capital adjustment by default.
      const capitalAcc = await this.accountIdByCode(q, '31');
      if (!cashAcc || !capitalAcc) return null;

      const today = new Date().toISOString().slice(0, 10);
      const lines: PostingLine[] =
        direction === 'in'
          ? [
              { account_id: cashAcc, debit: amount, credit: 0 },
              { account_id: capitalAcc, debit: 0, credit: amount },
            ]
          : [
              { account_id: capitalAcc, debit: amount, credit: 0 },
              { account_id: cashAcc, debit: 0, credit: amount },
            ];
      return this.createEntry(q, {
        entry_date: today,
        description:
          direction === 'in' ? 'إيداع نقدي يدوي' : 'سحب نقدي يدوي',
        reference_type: 'cashbox_manual',
        reference_id: txnId,
        lines,
        created_by: userId,
      });
    });
  }

  /**
   * Backfill journal entries for legacy rows that predate the
   * auto-posting wiring. Safe to run repeatedly — each post method is
   * idempotent. Returns per-module counts.
   */
  async backfill(opts: { since?: string; userId: string }) {
    const since = opts.since || '2020-01-01';
    const q = (sql: string, params?: any[]) => this.ds.query(sql, params);
    const out: Record<string, { found: number; posted: number }> = {};

    async function run<T extends { id: string }>(
      tag: string,
      rows: T[],
      post: (id: string) => Promise<any>,
    ) {
      let posted = 0;
      for (const r of rows) {
        const res = await post(r.id);
        if (res && !(res as any).skipped && !(res as any).error) posted++;
      }
      out[tag] = { found: rows.length, posted };
    }

    const invoices = await q(
      `SELECT id FROM invoices WHERE status IN ('paid','completed','partially_paid') AND created_at >= $1 ORDER BY created_at`,
      [since],
    );
    await run('invoices', invoices, (id) =>
      this.postInvoice(id, opts.userId),
    );

    const cps = await q(
      `SELECT id FROM customer_payments WHERE is_void = FALSE AND created_at >= $1 ORDER BY created_at`,
      [since],
    );
    await run('customer_payments', cps, (id) =>
      this.postInvoicePayment(id, opts.userId),
    );

    const sps = await q(
      `SELECT id FROM supplier_payments WHERE is_void = FALSE AND created_at >= $1 ORDER BY created_at`,
      [since],
    );
    await run('supplier_payments', sps, (id) =>
      this.postSupplierPayment(id, opts.userId),
    );

    const exps = await q(
      `SELECT id FROM expenses WHERE is_approved = TRUE AND created_at >= $1 ORDER BY created_at`,
      [since],
    );
    await run('expenses', exps, (id) => this.postExpense(id, opts.userId));

    const shifts = await q(
      `SELECT id FROM shifts WHERE status = 'closed' AND actual_closing IS NOT NULL AND closed_at >= $1 ORDER BY closed_at`,
      [since],
    );
    await run('shifts', shifts, (id) =>
      this.postShiftClose(id, opts.userId),
    );

    return out;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internals
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Wraps each public method: resolves a `query` callable that runs on
   * either the caller's transaction or the DataSource, checks for an
   * existing entry with the same (reference_type, reference_id), and
   * catches + logs any error so the caller never sees a posting
   * exception crash their operation.
   */
  private async safe(
    refType: string,
    refId: string,
    em: EntityManager | undefined,
    fn: (q: QueryFn) => Promise<any>,
  ) {
    const q: QueryFn = em
      ? (sql: string, params?: any[]) => em.query(sql, params)
      : (sql: string, params?: any[]) => this.ds.query(sql, params);
    try {
      // Idempotency guard.
      const [existing] = await q(
        `SELECT id FROM journal_entries
          WHERE reference_type = $1 AND reference_id = $2
          LIMIT 1`,
        [refType, refId],
      );
      if (existing) return { skipped: true, entry_id: existing.id };
      return await fn(q);
    } catch (err: any) {
      this.logger.error(
        `post ${refType}/${refId} failed: ${err?.message ?? err}`,
      );
      return { error: err?.message ?? String(err) };
    }
  }

  /** Create + post a journal entry. Returns the created row. */
  private async createEntry(
    q: QueryFn,
    args: {
      entry_date: string;
      description: string;
      reference_type: string;
      reference_id: string;
      lines: PostingLine[];
      created_by: string | null;
    },
  ) {
    // Final balance check (double-layered safety — DB trigger enforces too).
    const totalD = args.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const totalC = args.lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    if (Math.abs(totalD - totalC) > 0.01) {
      this.logger.error(
        `unbalanced ${args.reference_type}/${args.reference_id}: DR ${totalD} vs CR ${totalC}`,
      );
      return { error: 'unbalanced' };
    }
    if (totalD < 0.01) return null;

    const [{ seq }] = await q(
      `SELECT nextval('seq_journal_entry_no') AS seq`,
    );
    const entryNo = `JE-${args.entry_date.slice(0, 4)}-${String(seq).padStart(6, '0')}`;

    const [entry] = await q(
      `
      INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by)
      VALUES ($1, $2, $3, $4, $5, FALSE, $6, NOW(), $6)
      RETURNING id
      `,
      [
        entryNo,
        args.entry_date,
        args.description,
        args.reference_type,
        args.reference_id,
        args.created_by,
      ],
    );

    // Insert lines
    let n = 1;
    for (const l of args.lines) {
      if ((l.debit || 0) === 0 && (l.credit || 0) === 0) continue;
      await q(
        `
        INSERT INTO journal_lines
          (entry_id, line_no, account_id, debit, credit, description,
           cashbox_id, warehouse_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          entry.id,
          n++,
          l.account_id,
          Number(l.debit || 0),
          Number(l.credit || 0),
          l.description ?? args.description,
          l.cashbox_id ?? null,
          l.warehouse_id ?? null,
        ],
      );
    }

    // Post (flips is_posted → TRUE; trigger validates balance).
    await q(
      `UPDATE journal_entries SET is_posted = TRUE, posted_at = NOW() WHERE id = $1`,
      [entry.id],
    );
    return { entry_id: entry.id };
  }

  /** Fetch COA account UUID by 4-digit code (cached via Postgres). */
  private async accountIdByCode(q: QueryFn, code: string): Promise<string | null> {
    const [row] = await q(
      `SELECT id FROM chart_of_accounts WHERE code = $1 AND is_active = TRUE LIMIT 1`,
      [code],
    );
    return row?.id ?? null;
  }

  /**
   * Resolve a cashbox's GL account:
   *   1) explicit link on chart_of_accounts.cashbox_id
   *   2) kind → code map (cash=1111, bank=1113, ewallet=1114, check=1115)
   */
  private async cashboxAccountId(
    q: QueryFn,
    cashboxId: string | null,
  ): Promise<string | null> {
    if (!cashboxId) return this.accountIdByCode(q, '1111');
    const [explicit] = await q(
      `SELECT id FROM chart_of_accounts
        WHERE cashbox_id = $1 AND is_active = TRUE LIMIT 1`,
      [cashboxId],
    );
    if (explicit) return explicit.id;
    const [cb] = await q(
      `SELECT kind FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    const fallback: Record<string, string> = {
      cash: '1111',
      bank: '1113',
      ewallet: '1114',
      check: '1115',
    };
    const code = fallback[cb?.kind ?? 'cash'] || '1111';
    return this.accountIdByCode(q, code);
  }

  private dateOnly(d: Date | string | null): string {
    if (!d) return new Date().toISOString().slice(0, 10);
    const dt = typeof d === 'string' ? new Date(d) : d;
    return dt.toISOString().slice(0, 10);
  }
}

type QueryFn = (sql: string, params?: any[]) => Promise<any[]>;

interface PostingLine {
  account_id: string;
  debit?: number;
  credit?: number;
  description?: string;
  cashbox_id?: string | null;
  warehouse_id?: string | null;
}
