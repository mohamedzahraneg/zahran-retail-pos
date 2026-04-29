import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  FinancialEngineService,
  TransactionKind,
} from './financial-engine.service';
import { PaymentsService } from '../payments/payments.service';
import {
  METHOD_DEFAULT_GL_CODE,
  isCashMethod,
} from '../payments/providers.catalog';

// PR-PAY-1 — Method → default GL account. The map is exhaustive over
// the existing `payment_method_code` enum (cash, card_visa,
// card_mastercard, card_meeza, instapay, vodafone_cash, orange_cash,
// bank_transfer, credit) so postInvoice never falls back to a wrong
// bucket. `other` is intentionally not mapped — posting will throw
// for `other` unless an explicit payment_account.gl_account_code is
// supplied. This kills the previous `|| '1114'` silent fallback that
// quietly routed unknown methods to the e-wallets account.
const PAYMENT_METHOD_ACCOUNT_CODE: Record<string, string> = METHOD_DEFAULT_GL_CODE;

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

  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly engine?: FinancialEngineService,
    @Optional() private readonly payments?: PaymentsService,
  ) {}

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
  /**
   * Post a completed invoice to the GL. Phase 2.1 migration: the GL
   * shape is identical to the legacy path — same accounts (1111/1121
   * /411/214/51/1131), same amounts, same reference (invoice/id) —
   * but the INSERT is now performed by FinancialEngineService
   * instead of the legacy `createEntry`. No accounting behaviour
   * change; the bypass alert that every call previously dropped is
   * now gone because the engine sets the canonical
   * `engine:recordTransaction` context.
   *
   * Phase 2.2: cashbox movement now flows through the engine too — we
   * read the invoice's cash payments and pass them as `cash_movements`
   * so the engine writes the `cashbox_transactions` rows inside the
   * same atomic transaction as the GL post. `pos.service` no longer
   * calls `fn_record_cashbox_txn` inline for cash sales. Net effect:
   * every sale is one atomic engine call; no split ownership; no
   * `service:cashbox_fn_fallback` bypass alert.
   */
  async postInvoice(invoiceId: string, userId: string, em?: EntityManager) {
    if (!this.engine) {
      // Engine missing in a stubbed test — return no-op.
      return null;
    }
    const runner = em ?? this.ds.manager;
    // Invoices don't carry a cashbox_id directly — resolve via the
    // shift they were rung up on (shifts.cashbox_id).
    const [inv] = await runner.query(
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
    if (!['paid', 'completed', 'partially_paid'].includes(inv.status)) {
      return null;
    }
    const total = Number(inv.grand_total || 0);
    const paid = Number(inv.paid_amount || 0);
    const unpaid = Math.max(0, total - paid);
    const tax = Number(inv.tax_amount || 0);
    const revenue = Math.max(0, total - tax);
    if (total < 0.01) return null;

    // Sum the cost side from invoice_items.
    const [costRow] = await runner.query(
      `SELECT COALESCE(SUM(quantity * unit_cost), 0)::numeric(14,2) AS cogs
         FROM invoice_items WHERE invoice_id = $1`,
      [invoiceId],
    );
    const cogs = Number(costRow?.cogs || 0);
    const entryDate = this.dateOnly(inv.completed_at || inv.created_at);

    // PR-PAY-1 — Per-payment GL routing with payment_account
    // resolution. Order of resolution for the DR account:
    //   1) payment_account_snapshot.gl_account_code (frozen at payment
    //      time — preferred so historical reposts use the same account
    //      even if the underlying payment_account row was renamed/
    //      deactivated later);
    //   2) payment_account.gl_account_code (live lookup if no snapshot
    //      yet — back-compat for invoices created before snapshotting);
    //   3) METHOD_DEFAULT_GL_CODE[method] (legacy back-compat — used by
    //      the current 4-button POS until PR-PAY-3 ships the picker);
    //   4) THROW (no silent fallback to 1114 for `other`/unknown).
    const payments = await runner.query(
      `SELECT payment_method::text AS payment_method, amount,
              payment_account_id, payment_account_snapshot
         FROM invoice_payments
        WHERE invoice_id = $1
          AND COALESCE(amount, 0) > 0`,
      [invoiceId],
    );
    const lines: any[] = [];
    for (const p of payments) {
      const amt = Number(p.amount);
      if (isCashMethod(p.payment_method)) {
        lines.push(
          inv.cashbox_id
            ? {
                resolve_from_cashbox_id: inv.cashbox_id,
                debit: amt,
                cashbox_id: inv.cashbox_id,
                description: `كاش - فاتورة ${inv.invoice_no}`,
              }
            : {
                account_code: '1111',
                debit: amt,
                cashbox_id: undefined,
                description: `كاش - فاتورة ${inv.invoice_no}`,
              },
        );
        continue;
      }

      // Non-cash: resolve account snapshot → live account → method default.
      let glCode: string | undefined =
        p.payment_account_snapshot?.gl_account_code ?? undefined;
      let displayName: string | undefined =
        p.payment_account_snapshot?.display_name ?? undefined;

      if (!glCode && p.payment_account_id && this.payments) {
        const live = await this.payments.resolveForPosting(
          p.payment_account_id,
          runner,
        );
        if (live) {
          glCode = live.gl_account_code;
          displayName = live.display_name;
        }
      }

      if (!glCode) {
        glCode = PAYMENT_METHOD_ACCOUNT_CODE[p.payment_method];
      }

      if (!glCode) {
        // PR-PAY-1: no silent fallback. The previous `|| '1114'` would
        // route `other` (and any future enum value we forget to map)
        // to المحافظ الإلكترونية, silently corrupting the GL. Throw
        // instead so the operation aborts atomically and the error
        // surfaces in logs + the caller sees `.error`.
        const msg =
          `postInvoice: no GL account for payment_method='${p.payment_method}' ` +
          `(invoice ${inv.invoice_no}). Either map the method in ` +
          `METHOD_DEFAULT_GL_CODE or attach a payment_account_id whose ` +
          `gl_account_code is set.`;
        this.logger.error(msg);
        throw new Error(msg);
      }

      lines.push({
        account_code: glCode,
        debit: amt,
        description: displayName
          ? `${displayName} - فاتورة ${inv.invoice_no}`
          : `${p.payment_method} - فاتورة ${inv.invoice_no}`,
      });
    }
    if (unpaid > 0) {
      lines.push({
        account_code: '1121',
        debit: unpaid,
        customer_id: inv.customer_id ?? undefined,
        description: `آجل ${inv.invoice_no}`,
      });
    }
    // Revenue + tax split
    if (revenue > 0) {
      lines.push({
        account_code: '411',
        credit: revenue,
        description: `إيراد ${inv.invoice_no}`,
      });
    }
    if (tax > 0) {
      lines.push({
        account_code: '214',
        credit: tax,
        description: `ضريبة ${inv.invoice_no}`,
      });
    }
    // Cost side — only when cost data present
    if (cogs > 0) {
      lines.push({
        account_code: '51',
        debit: cogs,
        description: `تكلفة ${inv.invoice_no}`,
      });
      lines.push({
        account_code: '1131',
        credit: cogs,
        description: `خصم مخزون ${inv.invoice_no}`,
      });
    }
    if (lines.length < 2) return null;

    // Phase 2.2: gather cash payments → engine cash_movements. Only
    // cash payments produce a cashbox_transactions row; non-cash GL
    // legs go to their bucket account above with no cashbox effect.
    const cashMoves: Array<{
      cashbox_id: string;
      direction: 'in' | 'out';
      amount: number;
      category: string;
      notes?: string;
    }> = [];
    if (inv.cashbox_id) {
      for (const p of payments) {
        if (!isCashMethod(p.payment_method)) continue;
        cashMoves.push({
          cashbox_id: inv.cashbox_id,
          direction: 'in',
          amount: Number(p.amount),
          category: 'sale',
          notes: `بيع — فاتورة ${inv.invoice_no}`,
        });
      }
    }

    const res = await this.engine.recordTransaction({
      kind: 'sale',
      reference_type: 'invoice',
      reference_id: invoiceId,
      entry_date: entryDate,
      description: `قيد فاتورة مبيعات ${inv.invoice_no}`,
      gl_lines: lines,
      cash_movements: cashMoves,
      user_id: userId,
      em,
    });

    // Normalise return shape to match the legacy contract so callers
    // (pos.service:336 reads `.error`) continue to work unchanged.
    if (!res.ok) return { error: res.error };
    return { entry_id: (res as any).entry_id };
  }

  /**
   * PR-DRIFT-3E — GL-side companion to pos.service.editInvoice.
   *
   * Background: editInvoice used to reverse/replay the cashbox CT but
   * never touched the journal entry, leaving 5 invoices on
   * الخزينة الرئيسية with -1,435 EGP of cashbox-bucket drift.
   *
   * This method voids any active JE for the invoice and reposts a
   * fresh one based on the current invoice/payments state. The
   * void+repost strategy is symmetric with the CT layer (which already
   * does reverse+replay), keeps the audit trail explicit, and works
   * across all edit shapes (item, price, payment-method, mixed).
   *
   * Idempotent: if no active JE exists yet, this is a plain
   * `postInvoice`. If multiple actives somehow exist (shouldn't), all
   * are voided and one fresh JE is posted. Callers pass the same
   * EntityManager as editInvoice so the void+repost lives in the same
   * atomic transaction as the invoice mutation.
   */
  async postInvoiceEdit(invoiceId: string, userId: string, em?: EntityManager) {
    if (!this.engine) return null;
    const runner = em ?? this.ds.manager;
    const ctx = `engine:postInvoiceEdit`;
    await runner.query(`SELECT set_config('app.engine_context', $1, true)`, [ctx]);
    await runner.query(
      `UPDATE journal_entries
          SET is_void = TRUE,
              voided_by = $2,
              voided_at = NOW(),
              void_reason = COALESCE(void_reason, '')
                         || CASE WHEN void_reason IS NULL THEN ''
                                 ELSE E'\n' END
                         || 'PR-DRIFT-3E — superseded by postInvoiceEdit '
                         || 'after invoice edit. The fresh JE on the same '
                         || 'reference_id holds the corrected GL state.'
        WHERE reference_type = 'invoice'
          AND reference_id   = $1
          AND is_void = FALSE`,
      [invoiceId, userId],
    );
    return this.postInvoice(invoiceId, userId, em);
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
          // PR-DRIFT-3F — thread cashbox_id through to the cash leg
          // so v_cashbox_drift_per_ref can pair this JE with the
          // matching CT under the strict (cashbox, ref) join. The
          // SELECT above already resolves r.cashbox_id via the original
          // invoice's shift, so the attribution is unambiguous when set.
          cashbox_id: r.cashbox_id ?? undefined,
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
   * Reverse a posted journal entry — Phase 2.5 migration.
   *
   * Builds the swapped GL lines + reversed cashbox movements from the
   * original document and hands them to the engine as a single balanced
   * call with `reversal_of = <original entry id>`. The engine:
   *   • Records a `reversal` kind JE with `reversal_of` linking back to
   *     the original → preserves the same audit chain the legacy
   *     implementation built.
   *   • Flips the original to `is_void = TRUE` atomically inside the
   *     same transaction → trial balance drops the reversed entry.
   *   • Reverses the paired `cashbox_transactions` rows via
   *     `fn_record_cashbox_txn` (direction inverted) → cashbox
   *     balances stay consistent.
   *
   * No direct INSERTs remain; no `engine_bypass_alerts` row is logged.
   * Idempotency is provided by the engine's own check on
   * (reference_type='reversal', reference_id=<originalId>): a second
   * call returns { skipped: true } with the existing reversing entry.
   */
  async reverseByReference(
    refType: string,
    refId: string,
    reason: string,
    userId: string,
    em?: EntityManager,
  ) {
    if (!this.engine) {
      this.logger.error(
        `reverseByReference called without engine — cannot reverse ${refType}/${refId}`,
      );
      return { error: 'engine_unavailable' };
    }
    const q: QueryFn = em
      ? (sql: string, params?: any[]) => em.query(sql, params)
      : (sql: string, params?: any[]) => this.ds.query(sql, params);

    try {
      // Locate the original posted-and-not-void entry for this reference.
      const [orig] = await q(
        `SELECT id, entry_no, entry_date
           FROM journal_entries
          WHERE reference_type = $1 AND reference_id = $2
            AND is_posted = TRUE AND is_void = FALSE
            AND reversal_of IS NULL
          ORDER BY created_at ASC LIMIT 1`,
        [refType, refId],
      );
      if (!orig) return null;

      // Load its lines — we'll swap DR/CR and keep every dimension
      // (cashbox_id, warehouse_id, party tags) on the reversing lines
      // so reports that filter by those dimensions cancel out cleanly.
      const origLines = await q(
        `SELECT account_id, debit, credit, description,
                cashbox_id, warehouse_id,
                customer_id, supplier_id
           FROM journal_lines WHERE entry_id = $1 ORDER BY line_no`,
        [orig.id],
      );
      if (!origLines.length) return null;

      const gl_lines = origLines.map((l: any) => ({
        account_id: l.account_id,
        debit: Number(l.credit || 0), // swap
        credit: Number(l.debit || 0), // swap
        description: l.description,
        cashbox_id: l.cashbox_id ?? undefined,
        warehouse_id: l.warehouse_id ?? undefined,
        customer_id: l.customer_id ?? undefined,
        supplier_id: l.supplier_id ?? undefined,
      }));

      // Reverse paired cashbox transactions — same reference, direction
      // inverted. This keeps cashboxes.current_balance consistent with
      // the trial-balance effect of the reversal.
      const origCashRows = await q(
        `SELECT cashbox_id, direction, amount, category, notes
           FROM cashbox_transactions
          WHERE reference_type::text = $1 AND reference_id::text = $2
            AND is_void = FALSE
          ORDER BY id`,
        [refType, refId],
      );
      const cash_movements = origCashRows.map((r: any) => ({
        cashbox_id: r.cashbox_id,
        direction: (r.direction === 'in' ? 'out' : 'in') as 'in' | 'out',
        amount: Number(r.amount),
        category: `reversal_${r.category ?? ''}`.slice(0, 40),
        notes: `عكس: ${r.notes ?? ''}`.slice(0, 255),
      }));

      const res = await this.engine.recordTransaction({
        kind: 'reversal',
        reference_type: 'reversal',
        reference_id: orig.id, // idempotency per original entry
        entry_date: this.dateOnly(orig.entry_date),
        description: `عكس قيد ${orig.entry_no}: ${reason}`,
        gl_lines,
        cash_movements,
        user_id: userId,
        em,
        reversal_of: orig.id,
        reversal_reason: reason,
      });

      if (!res.ok) return { error: res.error };
      if ((res as any).skipped) {
        return { skipped: true, entry_id: (res as any).entry_id };
      }
      return {
        entry_id: (res as any).entry_id,
        reversed_of: orig.id,
      };
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
                cp.customer_id, cp.created_at, cp.is_void, cp.kind,
                cp.payment_method,
                cp.payment_account_id, cp.payment_account_snapshot
           FROM customer_payments cp WHERE cp.id = $1`,
        [paymentId],
      );
      if (!p || p.is_void) return null;
      const amt = Number(p.amount || 0);
      if (amt < 0.01) return null;

      const recvAcc = await this.accountIdByCode(q, '1121');
      // Deposit (عربون) goes to customer deposits liability, not receivables.
      const liabAcc = await this.accountIdByCode(q, '212');
      const creditAcc = p.kind === 'deposit' ? liabAcc : recvAcc;
      if (!creditAcc) return null;

      // PR-FIN-PAYACCT-4C — DR account resolution:
      //   • cash       → cashbox-GL (resolved via cashboxAccountId)
      //   • non-cash   → snapshot.gl_account_code (frozen at write
      //                  time) → live.gl_account_code (back-compat
      //                  for legacy non-cash rows that pre-date this
      //                  PR) → THROW (the legacy fall-through to
      //                  cashbox-GL on non-cash silently routed
      //                  InstaPay etc to GL 1111 which is what we are
      //                  fixing).
      let drAccId: string | null;
      let drCashboxId: string | undefined;
      let drDescription = `مقبوضة من عميل ${p.payment_no}`;

      if (isCashMethod(p.payment_method)) {
        drAccId = await this.cashboxAccountId(q, p.cashbox_id);
        drCashboxId = p.cashbox_id ?? undefined;
      } else {
        let glCode: string | undefined =
          p.payment_account_snapshot?.gl_account_code ?? undefined;
        let displayName: string | undefined =
          p.payment_account_snapshot?.display_name ?? undefined;
        if (!glCode && p.payment_account_id && this.payments) {
          // PaymentsService.resolveForPosting expects an object with
          // a `.query()` method; wrap the bare QueryFn `q` to match.
          const live = await this.payments.resolveForPosting(
            p.payment_account_id,
            { query: q },
          );
          if (live) {
            glCode = live.gl_account_code;
            displayName = live.display_name;
          }
        }
        if (!glCode) {
          // Last-resort method default — keeps legacy non-cash rows
          // posting until a follow-up PR backfills the snapshot.
          glCode = PAYMENT_METHOD_ACCOUNT_CODE[p.payment_method];
        }
        if (!glCode) {
          throw new Error(
            `postInvoicePayment: no GL account for payment_method='${p.payment_method}' ` +
              `(payment ${p.payment_no}). Attach a payment_account_id whose ` +
              `gl_account_code is set, or seed a method default.`,
          );
        }
        drAccId = await this.accountIdByCode(q, glCode);
        if (!drAccId) {
          throw new Error(
            `postInvoicePayment: chart_of_accounts has no row for code '${glCode}' ` +
              `(payment ${p.payment_no}).`,
          );
        }
        // Non-cash legs do NOT tag a cashbox_id — they live on the
        // bank/wallet GL bucket, not on a physical drawer.
        drCashboxId = undefined;
        if (displayName) {
          drDescription = `${displayName} - مقبوضة ${p.payment_no}`;
        }
      }
      if (!drAccId) return null;

      return this.createEntry(q, {
        entry_date: this.dateOnly(p.created_at),
        description: `مقبوضة من عميل ${p.payment_no}`,
        reference_type: 'customer_payment',
        reference_id: paymentId,
        lines: [
          {
            account_id: drAccId,
            debit: amt,
            credit: 0,
            cashbox_id: drCashboxId,
            description: drDescription,
          },
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

  /** Supplier payment → DR Suppliers Payable  CR Cash/Bank/Wallet */
  async postSupplierPayment(
    paymentId: string,
    userId: string,
    em?: EntityManager,
  ) {
    return this.safe('supplier_payment', paymentId, em, async (q) => {
      const [p] = await q(
        `SELECT sp.id, sp.payment_no, sp.amount, sp.cashbox_id,
                sp.supplier_id, sp.created_at, sp.is_void,
                sp.payment_method,
                sp.payment_account_id, sp.payment_account_snapshot
           FROM supplier_payments sp WHERE sp.id = $1`,
        [paymentId],
      );
      if (!p || p.is_void) return null;
      const amt = Number(p.amount || 0);
      if (amt < 0.01) return null;

      const suppAcc = await this.accountIdByCode(q, '211');
      if (!suppAcc) return null;

      // PR-FIN-PAYACCT-4C — CR account resolution mirrors postInvoicePayment.
      let crAccId: string | null;
      let crCashboxId: string | undefined;
      let crDescription = `دفعة لمورد ${p.payment_no}`;

      if (isCashMethod(p.payment_method)) {
        crAccId = await this.cashboxAccountId(q, p.cashbox_id);
        crCashboxId = p.cashbox_id ?? undefined;
      } else {
        let glCode: string | undefined =
          p.payment_account_snapshot?.gl_account_code ?? undefined;
        let displayName: string | undefined =
          p.payment_account_snapshot?.display_name ?? undefined;
        if (!glCode && p.payment_account_id && this.payments) {
          // PaymentsService.resolveForPosting expects an object with
          // a `.query()` method; wrap the bare QueryFn `q` to match.
          const live = await this.payments.resolveForPosting(
            p.payment_account_id,
            { query: q },
          );
          if (live) {
            glCode = live.gl_account_code;
            displayName = live.display_name;
          }
        }
        if (!glCode) {
          glCode = PAYMENT_METHOD_ACCOUNT_CODE[p.payment_method];
        }
        if (!glCode) {
          throw new Error(
            `postSupplierPayment: no GL account for payment_method='${p.payment_method}' ` +
              `(payment ${p.payment_no}).`,
          );
        }
        crAccId = await this.accountIdByCode(q, glCode);
        if (!crAccId) {
          throw new Error(
            `postSupplierPayment: chart_of_accounts has no row for code '${glCode}' ` +
              `(payment ${p.payment_no}).`,
          );
        }
        crCashboxId = undefined;
        if (displayName) {
          crDescription = `${displayName} - دفعة ${p.payment_no}`;
        }
      }
      if (!crAccId) return null;

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
          {
            account_id: crAccId,
            debit: 0,
            credit: amt,
            cashbox_id: crCashboxId,
            description: crDescription,
          },
        ],
        created_by: userId,
      });
    });
  }

  /**
   * Approved expense → delegates to FinancialEngineService.recordExpense.
   *
   * Migration 063 tightened the write guards. Rather than compose the
   * INSERT statements here (which would leave engine_bypass_alerts
   * breadcrumbs), we hand the spec to the engine. Idempotency,
   * cashbox movement, and financial_event_log bookkeeping all stay in
   * one place — the engine.
   */
  async postExpense(expenseId: string, userId: string, em?: EntityManager) {
    if (!this.engine) {
      // Engine missing in a stubbed test — return no-op rather than
      // fall through to direct SQL (the guard would reject anyway).
      return null;
    }
    const runner = em ?? this.ds.manager;
    // is_advance + employee_user_id MUST be read and forwarded to the
    // engine. FinancialEngineService.recordExpense routes the debit to
    // 1123 Employee Receivables (tagged with employee_user_id) ONLY when
    // both flags are present; otherwise it falls through to the expense
    // category account (→ 529 for unmapped). Dropping these fields here
    // caused shift-driven advances (is_advance=TRUE in the expense row)
    // to post as DR 529 / CR 1111 with NULL employee dimension,
    // hiding employee payouts inside miscellaneous expense and
    // zeroing v_employee_gl_balance for the affected employees.
    const [e] = await runner.query(
      `SELECT e.id, e.expense_no, e.amount, e.cashbox_id, e.category_id,
              e.expense_date, e.is_approved, e.payment_method,
              e.description, e.is_advance, e.employee_user_id,
              ec.account_id AS category_account_id
         FROM expenses e
         LEFT JOIN expense_categories ec ON ec.id = e.category_id
        WHERE e.id = $1`,
      [expenseId],
    );
    if (!e || !e.is_approved) return null;
    const amt = Number(e.amount || 0);
    if (amt < 0.01) return null;
    const res = await this.engine.recordExpense({
      expense_id: e.id,
      expense_no: e.expense_no,
      amount: amt,
      category_account_id: e.category_account_id ?? null,
      cashbox_id: e.cashbox_id ?? null,
      payment_method: e.payment_method ?? 'cash',
      user_id: userId,
      entry_date: this.dateOnly(e.expense_date),
      description: e.description ?? undefined,
      is_advance: e.is_advance === true,
      employee_user_id: e.employee_user_id ?? null,
      em,
    });
    return res.ok ? { entry_id: (res as any).entry_id } : null;
  }

  /**
   * Shift close with variance → delegates to
   * FinancialEngineService.recordShiftVariance (migration 063).
   *
   * The legacy shape (431/521, direct INSERTs) is retired. The engine
   * already encodes the same accounting — surplus to 421, deficit to
   * 531 — plus the variance-treatment options added in migration 060.
   */
  async postShiftClose(shiftId: string, userId: string, em?: EntityManager) {
    if (!this.engine) return null;
    const runner = em ?? this.ds.manager;
    const [s] = await runner.query(
      `SELECT id, shift_no, cashbox_id, actual_closing, expected_closing,
              closed_at, status
         FROM shifts WHERE id = $1`,
      [shiftId],
    );
    if (!s || s.status !== 'closed' || !s.closed_at) return null;
    const variance =
      Number(s.actual_closing || 0) - Number(s.expected_closing || 0);
    if (Math.abs(variance) < 0.01) return null;
    const res = await this.engine.recordShiftVariance({
      shift_id: s.id,
      shift_no: s.shift_no,
      cashbox_id: s.cashbox_id,
      variance,
      user_id: userId,
      entry_date: this.dateOnly(s.closed_at),
      em,
    });
    return res.ok ? { entry_id: (res as any).entry_id } : null;
  }

  /** Cashbox-to-cashbox transfer → DR destination-cash, CR source-cash. */
  /**
   * Cashbox → Cashbox transfer — delegates to the engine recipe
   * (migration 069 partial migration). The engine already encodes the
   * same Dr dest / Cr source shape plus matching IN/OUT cashbox
   * movements; we hand the spec over instead of writing to
   * journal_entries directly.
   */
  async postCashboxTransfer(
    txnId: string,
    fromCashboxId: string,
    toCashboxId: string,
    amount: number,
    description: string,
    userId: string,
    em?: EntityManager,
  ) {
    if (!this.engine) return null;
    if (!(amount > 0)) return null;
    const res = await this.engine.recordCashboxTransfer({
      transfer_id: txnId,
      from_cashbox_id: fromCashboxId,
      to_cashbox_id: toCashboxId,
      amount,
      notes: description,
      user_id: userId,
      em,
    });
    return res.ok ? { entry_id: (res as any).entry_id } : null;
  }

  /**
   * Manual cashbox deposit / withdrawal — delegates to
   * engine.recordManualAdjustment. Capital (31) / drawings (32)
   * counter-accounts are encoded by the engine; identical shape to
   * the legacy path.
   */
  async postCashboxDeposit(
    txnId: string,
    direction: 'in' | 'out',
    amount: number,
    cashboxId: string,
    userId: string,
    em?: EntityManager,
  ) {
    if (!this.engine) return null;
    if (!(amount > 0)) return null;
    const res = await this.engine.recordManualAdjustment({
      reference_id: txnId,
      cashbox_id: cashboxId,
      direction,
      amount,
      user_id: userId,
      notes: direction === 'in' ? 'إيداع نقدي يدوي' : 'سحب نقدي يدوي',
      em,
    });
    return res.ok ? { entry_id: (res as any).entry_id } : null;
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
    // Thread the EntityManager onto the query-fn closure so createEntry
    // can hand it to the engine — keeps the GL post inside the same
    // transaction as the source operation (invoice/return/purchase/etc).
    (q as any).__em__ = em;
    try {
      // Phase 2.2/2.3 migration: the actual INSERTs now run inside
      // FinancialEngineService.recordTransaction(), which raises the
      // canonical `engine:recordTransaction` context. We no longer need
      // the `service:*` fallback context at this layer — keeping it would
      // only log a stray bypass alert before the engine re-sets its own
      // context. The engine's own idempotency check is authoritative;
      // the one below is a micro-optimisation to short-circuit replays
      // without opening a new transaction.

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

  /**
   * Create + post a journal entry — Phase 2.2/2.3 migration.
   *
   * Previously this method composed the INSERTs itself, which left every
   * call (returns, purchases, supplier/customer payments, depreciation,
   * inventory adjustments, year-close) logging an `engine_bypass_alerts`
   * row because the write carried `service:*` context instead of
   * `engine:*`. The recipes in each public method above are unchanged;
   * only the final writer has moved into FinancialEngineService — the
   * same primitive POS sales already use.
   *
   * Result: seven previously-legacy flows now post through the engine
   * with no bypass alert, no direct INSERT, and with the engine's own
   * idempotency + balance + lockdown guards in effect.
   */
  private async createEntry(
    q: QueryFn,
    args: {
      entry_date: string;
      description: string;
      reference_type: string;
      reference_id: string;
      lines: PostingLine[];
      created_by: string | null;
      /** Optional physical cash moves; engine writes via fn_record_cashbox_txn. */
      cash_movements?: Array<{
        cashbox_id: string;
        direction: 'in' | 'out';
        amount: number;
        category: string;
        notes?: string;
      }>;
      /** Optional engine kind override (else derived from reference_type). */
      kind?: TransactionKind;
    },
  ) {
    if (!this.engine) {
      this.logger.error(
        `createEntry called without engine available — refusing to post ${args.reference_type}/${args.reference_id}`,
      );
      return { error: 'engine_unavailable' };
    }

    // Pre-flight: quick balance + non-zero check. The engine enforces
    // this again (and the DB trigger is the final backstop) — keeping the
    // check here preserves the same error surface callers relied on.
    const totalD = args.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const totalC = args.lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    if (Math.abs(totalD - totalC) > 0.01) {
      this.logger.error(
        `unbalanced ${args.reference_type}/${args.reference_id}: DR ${totalD} vs CR ${totalC}`,
      );
      return { error: 'unbalanced' };
    }
    if (totalD < 0.01) return null;

    // reference_type → TransactionKind. Recipes know what they're posting
    // so we keep this mapping tight; anything unmapped routes to
    // manual_adjustment (engine treats it like a free-form balanced entry).
    const kind: TransactionKind =
      args.kind ?? this.kindFromRefType(args.reference_type);

    // Hand the lines to the engine in-place — PostingLine and EngineGlLine
    // overlap on every field the recipes above use (account_id + debit +
    // credit + description + cashbox_id + warehouse_id + customer_id +
    // supplier_id). Lines that resolve by account_code instead of
    // account_id (a few of the newer recipes) pass through unchanged.
    const gl_lines = args.lines.map((l) => ({
      account_id: l.account_id,
      account_code: l.account_code,
      resolve_from_cashbox_id: l.resolve_from_cashbox_id,
      debit: Number(l.debit || 0),
      credit: Number(l.credit || 0),
      description: l.description ?? args.description,
      cashbox_id: l.cashbox_id ?? undefined,
      warehouse_id: l.warehouse_id ?? undefined,
      customer_id: l.customer_id ?? undefined,
      supplier_id: l.supplier_id ?? undefined,
    }));

    // The engine runs its own transaction unless we pass an EntityManager.
    // All posting.service callers already execute inside the source
    // operation's EntityManager (invoice/return/purchase/expense etc.),
    // but createEntry only sees the QueryFn closure. We derive the em
    // from the closure by pulling it from the wrapping `safe()` — which
    // already threads it through. Since we don't have direct access to
    // `em` here, we run the engine against its own transaction when we
    // weren't given one; that stays correct because the engine is
    // idempotent on (reference_type, reference_id), so a retry after a
    // caller's rollback is safe.
    //
    // To avoid double-wrapping when safe() already has an `em`, we peek
    // at the marker the caller can set. Missing → engine opens its own.
    const em: EntityManager | undefined = (q as any).__em__;

    const res = await this.engine.recordTransaction({
      kind,
      reference_type: args.reference_type,
      reference_id: args.reference_id,
      entry_date: args.entry_date,
      description: args.description,
      gl_lines,
      cash_movements: args.cash_movements ?? [],
      user_id: args.created_by,
      em,
    });

    if (!res.ok) {
      return { error: res.error };
    }
    return { entry_id: (res as any).entry_id };
  }

  /** Map a posting reference_type to the engine's TransactionKind union. */
  private kindFromRefType(refType: string): TransactionKind {
    const m: Record<string, TransactionKind> = {
      invoice: 'sale',
      return: 'refund',
      purchase: 'purchase',
      purchase_return: 'purchase_return',
      customer_payment: 'customer_payment',
      supplier_payment: 'supplier_payment',
      expense: 'expense',
      shift_variance: 'shift_variance',
      cashbox_transfer: 'cashbox_transfer',
      opening_balance: 'opening_balance',
      manual: 'manual_adjustment',
      inventory_adjustment: 'inventory_adjustment',
      depreciation: 'depreciation',
      year_close: 'year_close',
      reversal: 'reversal',
    };
    return m[refType] ?? 'manual_adjustment';
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
   * PR-DRIFT-3F — resolve cashbox_id for a journal_line tag using the
   * priority specified by the audit:
   *   1) direct cashbox_id on the source row
   *   2) shifts.cashbox_id via the source row's shift_id
   *   3) any active cashbox_transactions on the same (reference_type,
   *      reference_id) — only when unambiguous (single distinct cashbox)
   *
   * Returns NULL when no source resolves the cashbox — callers must
   * accept that some legacy/manual entries will not have an attribution.
   * The helper NEVER guesses; an ambiguous CT pairing returns NULL.
   *
   * Read-only — does NOT write any cashbox_transactions or update
   * cashboxes.current_balance. Used purely to populate
   * `journal_lines.cashbox_id` so v_cashbox_drift_per_ref's strict
   * (cashbox, ref_id) join can pair the JE with its CT.
   */
  async resolveCashboxIdForPosting(
    em: EntityManager | undefined,
    args: {
      cashbox_id?: string | null;
      shift_id?: string | null;
      reference_type?: string;
      reference_id?: string;
    },
  ): Promise<string | null> {
    if (args.cashbox_id) return args.cashbox_id;
    const runner = em ?? this.ds.manager;
    if (args.shift_id) {
      const [s] = await runner.query(
        `SELECT cashbox_id FROM shifts WHERE id = $1`,
        [args.shift_id],
      );
      if (s?.cashbox_id) return s.cashbox_id;
    }
    if (args.reference_type && args.reference_id) {
      const rows: { cashbox_id: string }[] = await runner.query(
        `SELECT DISTINCT cashbox_id
           FROM cashbox_transactions
          WHERE reference_type::text = $1
            AND reference_id = $2
            AND COALESCE(is_void, FALSE) = FALSE
            AND cashbox_id IS NOT NULL`,
        [args.reference_type, args.reference_id],
      );
      if (rows.length === 1) return rows[0].cashbox_id;
      // 0 or >1 distinct cashboxes: refuse to guess.
    }
    return null;
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
  /**
   * Supply ONE of account_id / account_code / resolve_from_cashbox_id.
   * Most recipes here pre-resolve to account_id; the newer ones (invoice,
   * opening balance, shift close) lean on the engine's code/cashbox
   * resolver.
   */
  account_id?: string;
  account_code?: string;
  resolve_from_cashbox_id?: string;
  debit?: number;
  credit?: number;
  description?: string;
  cashbox_id?: string | null;
  warehouse_id?: string | null;
  customer_id?: string | null;
  supplier_id?: string | null;
}
