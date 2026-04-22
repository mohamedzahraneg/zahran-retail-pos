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

  /**
   * Sales invoice → full double entry:
   *   DR Cash/Receivables (grand_total)
   *   CR Sales Revenue (subtotal after discount, excl. tax)
   *   CR VAT Payable (tax_amount)   — only when > 0
   *   DR COGS (sum of line cost × qty)
   *   CR Inventory (same amount)
   * All in one balanced entry.
   */
  async postInvoice(invoiceId: string, userId: string, em?: EntityManager) {
    return this.safe('invoice', invoiceId, em, async (q) => {
      // Invoices don't carry a cashbox_id directly — resolve via the
      // shift they were rung up on (shifts.cashbox_id).
      const [inv] = await q(
        `SELECT i.id, i.invoice_no, i.grand_total, i.paid_amount,
                i.tax_amount, i.completed_at, i.created_at, i.status,
                i.customer_id,
                s.cashbox_id AS cashbox_id
           FROM invoices i
           LEFT JOIN shifts s ON s.id = i.shift_id
          WHERE i.id = $1`,
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
      const tax = Number(inv.tax_amount || 0);
      const revenue = Math.max(0, total - tax);
      if (total < 0.01) return null;

      // Sum the cost side from invoice_items.
      const [costRow] = await q(
        `SELECT COALESCE(SUM(quantity * unit_cost), 0)::numeric(14,2) AS cogs
           FROM invoice_items WHERE invoice_id = $1`,
        [invoiceId],
      );
      const cogs = Number(costRow?.cogs || 0);

      const entryDate = this.dateOnly(inv.completed_at || inv.created_at);
      const cashAcc = await this.cashboxAccountId(q, inv.cashbox_id);
      const salesAcc = await this.accountIdByCode(q, '411');
      const recvAcc = await this.accountIdByCode(q, '1121');
      const vatAcc = tax > 0 ? await this.accountIdByCode(q, '214') : null;
      const cogsAcc = cogs > 0 ? await this.accountIdByCode(q, '51') : null;
      const invAcc = cogs > 0 ? await this.accountIdByCode(q, '1131') : null;

      const lines: PostingLine[] = [];
      // Cash side
      if (paid > 0 && cashAcc) {
        lines.push({ account_id: cashAcc, debit: paid, credit: 0, description: `فاتورة ${inv.invoice_no}` });
      }
      if (unpaid > 0 && recvAcc) {
        lines.push({
          account_id: recvAcc,
          debit: unpaid,
          credit: 0,
          description: `آجل ${inv.invoice_no}`,
          customer_id: inv.customer_id,
        });
      }
      // Revenue + tax split
      if (salesAcc && revenue > 0) {
        lines.push({ account_id: salesAcc, debit: 0, credit: revenue, description: `إيراد ${inv.invoice_no}` });
      }
      if (vatAcc && tax > 0) {
        lines.push({ account_id: vatAcc, debit: 0, credit: tax, description: `ضريبة ${inv.invoice_no}` });
      }
      // Cost side — only when we have cost data
      if (cogsAcc && invAcc && cogs > 0) {
        lines.push({ account_id: cogsAcc, debit: cogs, credit: 0, description: `تكلفة ${inv.invoice_no}` });
        lines.push({ account_id: invAcc, debit: 0, credit: cogs, description: `خصم مخزون ${inv.invoice_no}` });
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

  /**
   * Customer return → reverses the sale:
   *   DR Sales Returns (49)       = net_refund (gross minus restocking)
   *   DR Restocking Fee revenue?  → kept in-house; we credit 'other revenue' (422)
   *   CR Cash/Receivables         = net_refund + restocking
   *   DR Inventory (1131)         = cost of items returned to stock
   *   CR COGS (51)                = same
   */
  async postReturn(returnId: string, userId: string, em?: EntityManager) {
    return this.safe('return', returnId, em, async (q) => {
      const [r] = await q(
        `SELECT r.id, r.return_no, r.total_refund, r.restocking_fee,
                r.net_refund, r.status, r.refunded_at, r.approved_at,
                r.requested_at, r.refund_method, r.original_invoice_id,
                s.cashbox_id AS cashbox_id
           FROM returns r
           LEFT JOIN invoices i ON i.id = r.original_invoice_id
           LEFT JOIN shifts s   ON s.id = i.shift_id
          WHERE r.id = $1`,
        [returnId],
      );
      if (!r) return null;
      if (r.status !== 'approved' && r.status !== 'refunded') return null;
      const gross = Number(r.total_refund || 0);
      const fee = Number(r.restocking_fee || 0);
      const net = Number(r.net_refund || gross - fee);
      if (gross < 0.01) return null;

      // Cost of items that went back to stock (back_to_stock=true + resellable).
      const [costRow] = await q(
        `SELECT COALESCE(SUM(ri.quantity *
            COALESCE(ii.unit_cost, (SELECT cost_price FROM product_variants WHERE id = ri.variant_id), 0)
         ), 0)::numeric(14,2) AS cost
           FROM return_items ri
           LEFT JOIN invoice_items ii ON ii.id = ri.original_invoice_item_id
          WHERE ri.return_id = $1 AND ri.back_to_stock = TRUE`,
        [returnId],
      );
      const restockCost = Number(costRow?.cost || 0);

      const entryDate = this.dateOnly(
        r.refunded_at || r.approved_at || r.requested_at,
      );
      const returnsAcc = await this.accountIdByCode(q, '49');  // مرتدات المبيعات
      const cashAcc = await this.cashboxAccountId(q, r.cashbox_id);
      const feeAcc =
        fee > 0 ? await this.accountIdByCode(q, '422') : null; // misc revenue
      const cogsAcc =
        restockCost > 0 ? await this.accountIdByCode(q, '51') : null;
      const invAcc =
        restockCost > 0 ? await this.accountIdByCode(q, '1131') : null;

      const lines: PostingLine[] = [];
      if (returnsAcc && gross > 0) {
        lines.push({
          account_id: returnsAcc,
          debit: gross,
          credit: 0,
          description: `مرتجع ${r.return_no}`,
        });
      }
      if (feeAcc && fee > 0) {
        // Restocking fee kept by the company — credit revenue.
        lines.push({
          account_id: feeAcc,
          debit: 0,
          credit: fee,
          description: `رسوم إعادة جرد ${r.return_no}`,
        });
      }
      if (cashAcc && net > 0) {
        lines.push({
          account_id: cashAcc,
          debit: 0,
          credit: net,
          description: `رد نقدي ${r.return_no}`,
        });
      }
      // Inventory side
      if (invAcc && cogsAcc && restockCost > 0) {
        lines.push({
          account_id: invAcc,
          debit: restockCost,
          credit: 0,
          description: `إرجاع مخزون ${r.return_no}`,
        });
        lines.push({
          account_id: cogsAcc,
          debit: 0,
          credit: restockCost,
          description: `عكس تكلفة ${r.return_no}`,
        });
      }
      if (lines.length < 2) return null;

      return this.createEntry(q, {
        entry_date: entryDate,
        description: `قيد مرتجع ${r.return_no}`,
        reference_type: 'return',
        reference_id: returnId,
        lines,
        created_by: userId,
      });
    });
  }

  /**
   * Purchase received → capitalizes inventory:
   *   DR Inventory (1131) = subtotal (ex-tax)
   *   DR VAT Receivable (214 contra) = tax_amount  — we record as negative liability
   *   CR Suppliers Payable (211) or Cash = grand_total
   */
  async postPurchase(purchaseId: string, userId: string, em?: EntityManager) {
    return this.safe('purchase', purchaseId, em, async (q) => {
      const [p] = await q(
        `SELECT id, purchase_no, subtotal, tax_amount, shipping_cost,
                grand_total, paid_amount, status, received_at, invoice_date,
                supplier_id
           FROM purchases WHERE id = $1`,
        [purchaseId],
      );
      if (!p) return null;
      if (p.status !== 'received' && p.status !== 'partial' && p.status !== 'paid') {
        return null;
      }
      const total = Number(p.grand_total || 0);
      const paid = Number(p.paid_amount || 0);
      const tax = Number(p.tax_amount || 0);
      const shipping = Number(p.shipping_cost || 0);
      const inventoryCost = Math.max(0, total - tax); // shipping already in subtotal
      if (total < 0.01) return null;

      const entryDate = this.dateOnly(p.received_at || p.invoice_date);
      const invAcc = await this.accountIdByCode(q, '1131');
      const vatAcc = tax > 0 ? await this.accountIdByCode(q, '214') : null;
      const suppAcc = await this.accountIdByCode(q, '211');
      // We don't know the cashbox here — PO model doesn't track it.
      // If fully paid at receive time, caller can post the supplier payment separately.

      const lines: PostingLine[] = [];
      if (invAcc && inventoryCost > 0) {
        lines.push({
          account_id: invAcc,
          debit: inventoryCost,
          credit: 0,
          description: `مخزون ${p.purchase_no}`,
        });
      }
      if (vatAcc && tax > 0) {
        // DR VAT Payable — reduces the liability (net reclaim).
        lines.push({
          account_id: vatAcc,
          debit: tax,
          credit: 0,
          description: `ضريبة شراء ${p.purchase_no}`,
        });
      }
      if (suppAcc && total > 0) {
        lines.push({
          account_id: suppAcc,
          debit: 0,
          credit: total,
          description: `مستحق مورد ${p.purchase_no}`,
          supplier_id: p.supplier_id,
        });
      }
      // Add shipping to other-expenses if tracked inline (optional)
      if (shipping > 0) {
        // shipping is already baked into subtotal; nothing extra here.
      }
      if (lines.length < 2) return null;

      return this.createEntry(q, {
        entry_date: entryDate,
        description: `قيد مشتريات ${p.purchase_no}`,
        reference_type: 'purchase',
        reference_id: purchaseId,
        lines,
        created_by: userId,
      });
    });
  }

  /**
   * Stock adjustment from a physical count → records shrinkage or overage.
   *   Shortage (qty_delta < 0):
   *     DR Shrinkage (534) = |value|
   *     CR Inventory (1131) = |value|
   *   Overage (qty_delta > 0):
   *     DR Inventory (1131) = value
   *     CR Inventory Overage revenue (423) = value
   *
   * One GL entry per adjustment batch. `adjustmentId` is typically a
   * stock_count id or a manual adjustment id — used for idempotency.
   */
  async postInventoryAdjustment(
    adjustmentId: string,
    netValue: number,
    description: string,
    userId: string,
    em?: EntityManager,
  ) {
    return this.safe('inventory_adjustment', adjustmentId, em, async (q) => {
      const abs = Math.abs(Number(netValue) || 0);
      if (abs < 0.01) return null;
      const today = new Date().toISOString().slice(0, 10);
      const invAcc = await this.accountIdByCode(q, '1131');
      const shrinkAcc = await this.accountIdByCode(q, '534');
      const overageAcc = await this.accountIdByCode(q, '423');
      if (!invAcc) return null;

      const isShortage = netValue < 0;
      const counterAcc = isShortage ? shrinkAcc : overageAcc;
      if (!counterAcc) return null;

      return this.createEntry(q, {
        entry_date: today,
        description,
        reference_type: 'inventory_adjustment',
        reference_id: adjustmentId,
        lines: isShortage
          ? [
              { account_id: counterAcc, debit: abs, credit: 0, description },
              { account_id: invAcc, debit: 0, credit: abs, description },
            ]
          : [
              { account_id: invAcc, debit: abs, credit: 0, description },
              { account_id: counterAcc, debit: 0, credit: abs, description },
            ],
        created_by: userId,
      });
    });
  }

  /**
   * Monthly depreciation → one entry per active fixed-asset schedule.
   *   DR Depreciation Expense (535)
   *   CR Accumulated Depreciation (the schedule's accum_dep_account_id
   *       or, if unset, 123)
   */
  async postMonthlyDepreciation(userId: string) {
    const schedules = await this.ds.query(
      `SELECT id, account_id, name_ar, cost, salvage_value,
              useful_life_months, start_date, last_posted_month,
              accum_dep_account_id
         FROM fixed_asset_schedules
        WHERE is_active = TRUE
          AND (last_posted_month IS NULL
               OR last_posted_month < DATE_TRUNC('month', now() AT TIME ZONE 'Africa/Cairo')::date)`,
    );
    const posted: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';

    for (const s of schedules) {
      const months = Number(s.useful_life_months || 0);
      const cost = Number(s.cost || 0);
      const salvage = Number(s.salvage_value || 0);
      if (months <= 0 || cost <= salvage) continue;
      const monthly = Number(((cost - salvage) / months).toFixed(2));
      if (monthly < 0.01) continue;

      // Use the schedule id + month as the idempotency key.
      const refId = `${s.id}:${monthStart}`;
      const result = await this.safe(
        'depreciation',
        refId,
        undefined,
        async (q) => {
          const expenseAcc = await this.accountIdByCode(q, '535');
          const accumAcc =
            s.accum_dep_account_id ||
            (await this.accountIdByCode(q, '123'));
          if (!expenseAcc || !accumAcc) return null;

          const entry = await this.createEntry(q, {
            entry_date: today,
            description: `إهلاك شهري — ${s.name_ar}`,
            reference_type: 'depreciation',
            reference_id: refId,
            lines: [
              {
                account_id: expenseAcc,
                debit: monthly,
                credit: 0,
                description: s.name_ar,
              },
              {
                account_id: accumAcc,
                debit: 0,
                credit: monthly,
                description: s.name_ar,
              },
            ],
            created_by: userId,
          });
          await q(
            `UPDATE fixed_asset_schedules
                SET last_posted_month = DATE_TRUNC('month', now() AT TIME ZONE 'Africa/Cairo')::date,
                    updated_at = NOW()
              WHERE id = $1`,
            [s.id],
          );
          return entry;
        },
      );
      if (result && !(result as any).skipped && !(result as any).error) {
        posted.push(s.id);
      }
    }
    return { posted_count: posted.length, schedule_ids: posted };
  }

  /**
   * Year-end closing entry — zeros out revenue + expense accounts and
   * transfers the net result to Retained Earnings (32). Uses each
   * account's period-to-date balance as of `fiscalYearEnd`.
   */
  async closeFiscalYear(
    fiscalYearEnd: string,
    userId: string,
  ): Promise<any> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fiscalYearEnd)) {
      throw new Error('fiscalYearEnd must be YYYY-MM-DD');
    }
    const year = fiscalYearEnd.slice(0, 4);
    const refId = `year-close:${year}`;
    return this.safe('year_close', refId, undefined, async (q) => {
      const fiscalYearStart = `${year}-01-01`;
      const balances = await q(
        `
        SELECT a.id, a.code, a.normal_balance, a.account_type,
               COALESCE(SUM(jl.debit),  0)::numeric(14,2) AS d,
               COALESCE(SUM(jl.credit), 0)::numeric(14,2) AS c
          FROM chart_of_accounts a
          LEFT JOIN journal_lines jl ON jl.account_id = a.id
          LEFT JOIN journal_entries je ON je.id = jl.entry_id
           AND je.is_posted = TRUE AND je.is_void = FALSE
           AND je.entry_date BETWEEN $1::date AND $2::date
         WHERE a.account_type IN ('revenue', 'expense')
           AND a.is_leaf = TRUE
         GROUP BY a.id, a.code, a.normal_balance, a.account_type
        HAVING COALESCE(SUM(jl.debit),  0) + COALESCE(SUM(jl.credit), 0) > 0
        `,
        [fiscalYearStart, fiscalYearEnd],
      );
      if (!balances.length) return { skipped: true, reason: 'no_balances' };

      const retainedAcc = await this.accountIdByCode(q, '32');
      if (!retainedAcc) {
        return { error: 'retained_earnings_account_missing' };
      }

      const lines: PostingLine[] = [];
      let netProfit = 0;
      for (const a of balances) {
        const d = Number(a.d);
        const c = Number(a.c);
        const balance = a.normal_balance === 'debit' ? d - c : c - d;
        if (Math.abs(balance) < 0.01) continue;
        if (a.account_type === 'revenue') {
          // revenue has credit balance → DR to zero it
          lines.push({ account_id: a.id, debit: balance, credit: 0 });
          netProfit += balance;
        } else {
          // expense has debit balance → CR to zero it
          lines.push({ account_id: a.id, debit: 0, credit: balance });
          netProfit -= balance;
        }
      }
      if (Math.abs(netProfit) < 0.01) return { skipped: true, reason: 'balanced' };

      // Plug to retained earnings
      if (netProfit > 0) {
        lines.push({
          account_id: retainedAcc,
          debit: 0,
          credit: netProfit,
          description: 'صافي ربح السنة',
        });
      } else {
        lines.push({
          account_id: retainedAcc,
          debit: Math.abs(netProfit),
          credit: 0,
          description: 'صافي خسارة السنة',
        });
      }

      return this.createEntry(q, {
        entry_date: fiscalYearEnd,
        description: `قيد إقفال السنة ${year}`,
        reference_type: 'year_close',
        reference_id: refId,
        lines,
        created_by: userId,
      });
    });
  }

  /**
   * Reverse a posted journal entry by creating a mirror entry with
   * debits and credits swapped. Used when the originating document is
   * voided (invoice cancelled, customer payment voided, return rejected
   * after approval, …).
   */
  async reverseByReference(
    refType: string,
    refId: string,
    reason: string,
    userId: string,
    em?: EntityManager,
  ) {
    const q: QueryFn = em
      ? (sql: string, params?: any[]) => em.query(sql, params)
      : (sql: string, params?: any[]) => this.ds.query(sql, params);
    try {
      // Find the original posted entry.
      const [orig] = await q(
        `SELECT id, entry_no FROM journal_entries
          WHERE reference_type = $1 AND reference_id = $2
            AND is_posted = TRUE AND is_void = FALSE
            AND reversal_of IS NULL
          ORDER BY created_at ASC LIMIT 1`,
        [refType, refId],
      );
      if (!orig) return null;

      // Check we haven't already reversed it.
      const [existingRev] = await q(
        `SELECT id FROM journal_entries
          WHERE reversal_of = $1 AND is_posted = TRUE AND is_void = FALSE
          LIMIT 1`,
        [orig.id],
      );
      if (existingRev) return { skipped: true, entry_id: existingRev.id };

      const origLines = await q(
        `SELECT account_id, debit, credit, description, cashbox_id, warehouse_id, line_no
           FROM journal_lines WHERE entry_id = $1 ORDER BY line_no`,
        [orig.id],
      );
      if (!origLines.length) return null;

      const today = new Date().toISOString().slice(0, 10);
      const [{ seq }] = await q(
        `SELECT nextval('seq_journal_entry_no') AS seq`,
      );
      const entryNo = `JE-${today.slice(0, 4)}-${String(seq).padStart(6, '0')}`;

      const [rev] = await q(
        `
        INSERT INTO journal_entries
          (entry_no, entry_date, description, reference_type, reference_id,
           reversal_of, is_posted, posted_by, posted_at, created_by)
        VALUES ($1,$2,$3,'reversal',$4,$5,FALSE,$6,NULL,$6)
        RETURNING id
        `,
        [
          entryNo,
          today,
          `عكس قيد ${orig.entry_no}: ${reason}`,
          refId,
          orig.id,
          userId,
        ],
      );

      let n = 1;
      for (const l of origLines) {
        await q(
          `INSERT INTO journal_lines
             (entry_id, line_no, account_id, debit, credit, description, cashbox_id, warehouse_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            rev.id,
            n++,
            l.account_id,
            Number(l.credit || 0), // swap
            Number(l.debit || 0), // swap
            l.description,
            l.cashbox_id,
            l.warehouse_id,
          ],
        );
      }

      // Flip original to void + post reversal.
      await q(
        `UPDATE journal_entries SET is_void = TRUE, void_reason = $2,
           voided_by = $3, voided_at = NOW()
         WHERE id = $1`,
        [orig.id, reason, userId],
      );
      await q(
        `UPDATE journal_entries SET is_posted = TRUE, posted_at = NOW() WHERE id = $1`,
        [rev.id],
      );
      return { entry_id: rev.id, reversed_of: orig.id };
    } catch (err: any) {
      this.logger.error(
        `reverse ${refType}/${refId} failed: ${err?.message ?? err}`,
      );
      return { error: err?.message ?? String(err) };
    }
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
                cp.customer_id, cp.created_at, cp.is_void, cp.kind
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
          {
            account_id: creditAcc,
            debit: 0,
            credit: amt,
            customer_id: p.customer_id,
          },
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
                sp.supplier_id, sp.created_at, sp.is_void
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
          {
            account_id: suppAcc,
            debit: amt,
            credit: 0,
            supplier_id: p.supplier_id,
          },
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

  /** Cashbox-to-cashbox transfer → DR destination-cash, CR source-cash. */
  async postCashboxTransfer(
    txnId: string,
    fromCashboxId: string,
    toCashboxId: string,
    amount: number,
    description: string,
    userId: string,
    em?: EntityManager,
  ) {
    return this.safe('cashbox_transfer', txnId, em, async (q) => {
      if (!(amount > 0)) return null;
      const fromAcc = await this.cashboxAccountId(q, fromCashboxId);
      const toAcc = await this.cashboxAccountId(q, toCashboxId);
      if (!fromAcc || !toAcc) return null;
      const today = new Date().toISOString().slice(0, 10);
      return this.createEntry(q, {
        entry_date: today,
        description,
        reference_type: 'cashbox_transfer',
        reference_id: txnId,
        lines: [
          { account_id: toAcc, debit: amount, credit: 0, cashbox_id: toCashboxId },
          { account_id: fromAcc, debit: 0, credit: amount, cashbox_id: fromCashboxId },
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

    const returns = await q(
      `SELECT id FROM returns WHERE status IN ('approved','refunded') AND requested_at >= $1 ORDER BY requested_at`,
      [since],
    );
    await run('returns', returns, (id) =>
      this.postReturn(id, opts.userId),
    );

    const purchases = await q(
      `SELECT id FROM purchases WHERE status IN ('received','partial','paid') AND COALESCE(received_at, invoice_date::timestamptz) >= $1 ORDER BY received_at NULLS LAST, invoice_date`,
      [since],
    );
    await run('purchases', purchases, (id) =>
      this.postPurchase(id, opts.userId),
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
      // Raise the engine-context GUC so migration 058's guard triggers
      // allow this service to INSERT into journal_entries /
      // journal_lines. This legacy path is grandfathered in because it
      // already goes through the same safe() idempotency guard the
      // engine uses. Session-local; reverts at end of transaction.
      await q(`SET LOCAL app.engine_context = 'on'`).catch(() => undefined);

      // Idempotency guard — only count LIVE entries (posted, non-void).
      // A voided entry from a previous reset should NOT block re-posting.
      const [existing] = await q(
        `SELECT id FROM journal_entries
          WHERE reference_type = $1 AND reference_id = $2
            AND is_posted = TRUE AND is_void = FALSE
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
    const hasPartyCols = await this.hasPartyColumns(q);
    for (const l of args.lines) {
      if ((l.debit || 0) === 0 && (l.credit || 0) === 0) continue;
      if (hasPartyCols) {
        await q(
          `
          INSERT INTO journal_lines
            (entry_id, line_no, account_id, debit, credit, description,
             cashbox_id, warehouse_id, customer_id, supplier_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
            l.customer_id ?? null,
            l.supplier_id ?? null,
          ],
        );
      } else {
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

  private _hasPartyColsCache: boolean | null = null;
  private async hasPartyColumns(q: QueryFn): Promise<boolean> {
    if (this._hasPartyColsCache !== null) return this._hasPartyColsCache;
    const [row] = await q(
      `SELECT (
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='journal_lines' AND column_name='customer_id')
        AND
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='journal_lines' AND column_name='supplier_id')
      ) AS present`,
    );
    this._hasPartyColsCache = !!row?.present;
    return this._hasPartyColsCache;
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
  customer_id?: string | null;
  supplier_id?: string | null;
}
