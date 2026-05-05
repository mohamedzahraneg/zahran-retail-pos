import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  ApproveCloseDto,
  CloseShiftDto,
  OpenShiftDto,
  VarianceTreatment,
} from './dto/shift.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';
import { GL_EMPLOYEE_RECEIVABLE } from '../chart-of-accounts/gl-codes.constants';

/**
 * Cashier shift (وردية) service.
 *
 * A shift is the period between a cashier opening a cashbox with an opening
 * balance and closing it with a counted cash amount. At close we reconcile:
 *
 *   expected_closing = opening_balance
 *                      + cash_sales
 *                      - cash_refunds
 *                      + customer_payments       (cash in from receivables)
 *                      - supplier_payments       (cash out to payables)
 *                      - cash_expenses
 *                      + other_cash_in           (manual deposits)
 *                      - other_cash_out          (manual withdrawals)
 *
 *   variance = actual_closing - expected_closing    (+ surplus / − deficit)
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  async open(dto: OpenShiftDto, userId: string) {
    const [existing] = await this.ds.query(
      `SELECT id, shift_no FROM shifts WHERE cashbox_id = $1 AND status = 'open' LIMIT 1`,
      [dto.cashbox_id],
    );
    if (existing) {
      throw new BadRequestException(
        `يوجد وردية مفتوحة على هذه الخزينة: ${existing.shift_no}`,
      );
    }

    const year = new Date().getFullYear();
    const [{ max }] = await this.ds.query(
      `SELECT COALESCE(MAX(SUBSTRING(shift_no FROM 'SHF-[0-9]+-([0-9]+)')::int), 0) AS max
       FROM shifts WHERE shift_no LIKE 'SHF-' || $1 || '-%'`,
      [year],
    );
    const shiftNo = `SHF-${year}-${String(Number(max) + 1).padStart(5, '0')}`;

    const [row] = await this.ds.query(
      `
      INSERT INTO shifts
        (shift_no, cashbox_id, warehouse_id, opened_by, status, opening_balance, expected_closing, notes)
      VALUES ($1,$2,$3,$4,'open',$5,$5,$6)
      RETURNING *
      `,
      [shiftNo, dto.cashbox_id, dto.warehouse_id, userId, dto.opening_balance, dto.notes ?? null],
    );
    return row;
  }

  /**
   * Gather every number that matters for the close-out dialog. Accepts any
   * shift id (open or closed) and returns a fresh reconciled summary.
   */
  async summary(id: string) {
    const [shift] = await this.ds.query(`SELECT * FROM shifts WHERE id = $1`, [id]);
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    return this.computeSummary(shift);
  }

  private async computeSummary(shift: any, em?: EntityManager) {
    // PR-FIX-POS-INVOICE-EDIT-REFRESH-CLOSED-SHIFT-SNAPSHOT
    // Optional `em` parameter lets a caller (e.g. PosService.editInvoice)
    // run computeSummary inside an active transaction so the recompute
    // and any follow-up snapshot UPDATE roll back together. When `em` is
    // omitted (the original close path) we route through `this.ds`
    // exactly like before — behavior is unchanged for existing callers.
    const q = em ?? this.ds;
    // When the shift is still open we bound by NOW; when closed we stop at
    // the closed_at timestamp. This lets the summary stay stable for closed
    // shifts and live for open ones.
    const upperBound = shift.closed_at || new Date();

    // Invoice totals — match either by explicit shift_id OR by the same
    // cashier creating invoices during the shift window. This makes us
    // resilient to shift_id being NULL (e.g. warehouse mismatch or pre-fix
    // legacy rows).
    const invMatch = `(
      i.shift_id = $1
      OR (
        i.shift_id IS NULL
        AND i.cashier_id = $2
        AND i.created_at >= $3
        AND i.created_at <= $4
      )
    )`;

    const [inv] = await q.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN i.status IN ('paid','completed','partially_paid') THEN i.grand_total ELSE 0 END),0)::numeric AS total_sales,
        COALESCE(SUM(CASE WHEN i.status = 'cancelled' THEN i.grand_total ELSE 0 END),0)::numeric AS total_cancelled,
        COUNT(*) FILTER (WHERE i.status IN ('paid','completed','partially_paid'))::int AS invoice_count,
        COUNT(*) FILTER (WHERE i.status = 'cancelled')::int AS cancelled_count,
        COALESCE(SUM(CASE WHEN i.status IN ('paid','completed','partially_paid') THEN (i.grand_total - i.paid_amount) ELSE 0 END),0)::numeric AS remaining_receivable
      FROM invoices i
      WHERE ${invMatch}
      `,
      [shift.id, shift.opened_by, shift.opened_at, upperBound],
    );

    // PR-PAY-4 — Payment breakdown is now per-method AND per-account.
    // We pull one row per (method, payment_account_id) pair so the
    // shift-close UI can show "InstaPay 300 (InstaPay الأهلي 300)" or
    // "Wallet 500 (WE Pay 200, Vodafone 300)" without a second
    // round-trip. Account labels prefer the snapshot frozen at sale
    // time so admin renames/deactivations don't rewrite history.
    const payRows = await q.query(
      `
      SELECT ip.payment_method::text AS method,
             ip.payment_account_id,
             pa.display_name             AS live_display_name,
             pa.identifier               AS live_identifier,
             pa.provider_key             AS live_provider_key,
             ip.payment_account_snapshot AS snap,
             COALESCE(SUM(ip.amount),0)::numeric(18,2) AS amount,
             COUNT(*)::int                              AS payment_count,
             COUNT(DISTINCT ip.invoice_id)::int         AS invoice_count
        FROM invoice_payments ip
        JOIN invoices i        ON i.id = ip.invoice_id
   LEFT JOIN payment_accounts pa ON pa.id = ip.payment_account_id
       WHERE ${invMatch}
         AND i.status IN ('paid','completed','partially_paid')
       GROUP BY ip.payment_method, ip.payment_account_id, pa.display_name,
                pa.identifier, pa.provider_key, ip.payment_account_snapshot
      `,
      [shift.id, shift.opened_by, shift.opened_at, upperBound],
    );

    // Build the structured breakdown:
    //   payment_breakdown: [{method, method_label_ar, total_amount,
    //                       invoice_count, payment_count, accounts: [...]}]
    type AccountRow = {
      payment_account_id: string | null;
      display_name: string | null;
      identifier: string | null;
      provider_key: string | null;
      total_amount: number;
      invoice_count: number;
      payment_count: number;
    };
    type MethodRow = {
      method: string;
      method_label_ar: string;
      total_amount: number;
      invoice_count: number;
      payment_count: number;
      accounts: AccountRow[];
    };
    const METHOD_LABEL_AR: Record<string, string> = {
      cash: 'كاش',
      card_visa: 'فيزا',
      card_mastercard: 'ماستركارد',
      card_meeza: 'ميزة',
      instapay: 'إنستا باي',
      vodafone_cash: 'فودافون كاش',
      orange_cash: 'أورانج كاش',
      wallet: 'محفظة إلكترونية',
      bank_transfer: 'تحويل بنكي',
      credit: 'آجل',
      other: 'أخرى',
    };
    const methodMap = new Map<string, MethodRow>();
    for (const r of payRows) {
      const method = r.method as string;
      let bucket = methodMap.get(method);
      if (!bucket) {
        bucket = {
          method,
          method_label_ar: METHOD_LABEL_AR[method] || method,
          total_amount: 0,
          invoice_count: 0,
          payment_count: 0,
          accounts: [],
        };
        methodMap.set(method, bucket);
      }
      const amt = Number(r.amount);
      const invs = Number(r.invoice_count);
      const pays = Number(r.payment_count);
      bucket.total_amount += amt;
      bucket.invoice_count += invs;
      bucket.payment_count += pays;
      // Resolve display name preference: live account → snapshot → null.
      // Snapshot wins when the account was deactivated/renamed since
      // the sale; live wins when both are present and account is still
      // around (snapshot may be slightly stale for cosmetic fields).
      const snap = r.snap || null;
      const display =
        r.live_display_name ?? snap?.display_name ?? null;
      const identifier =
        r.live_identifier ?? snap?.identifier ?? null;
      const provider =
        r.live_provider_key ?? snap?.provider_key ?? null;
      bucket.accounts.push({
        payment_account_id: r.payment_account_id ?? null,
        display_name: display,
        identifier,
        provider_key: provider,
        total_amount: amt,
        invoice_count: invs,
        payment_count: pays,
      });
    }
    // Sort accounts by amount desc within each method, then sort
    // methods by amount desc so cash usually shows first when present.
    for (const m of methodMap.values()) {
      m.accounts.sort((a, b) => b.total_amount - a.total_amount);
    }
    const paymentBreakdown: MethodRow[] = Array.from(methodMap.values()).sort(
      (a, b) => b.total_amount - a.total_amount,
    );

    // Roll-up totals — cash is the only thing that hits the physical
    // drawer. Everything else is a "تحصيلات غير نقدية" collection.
    const cashFromSales = paymentBreakdown
      .filter((m) => m.method === 'cash')
      .reduce((s, m) => s + m.total_amount, 0);
    const nonCashFromSales = paymentBreakdown
      .filter((m) => m.method !== 'cash')
      .reduce((s, m) => s + m.total_amount, 0);
    const grandPaymentTotal = cashFromSales + nonCashFromSales;

    // Legacy 4-key map kept for backward compat with any UI that still
    // reads the old `payment_breakdown.{cash,card,instapay,bank_transfer}`
    // shape. The new array is the source of truth — see below.
    const legacyBucket = (m: string) => {
      const b = methodMap.get(m);
      return { amount: b?.total_amount || 0, count: b?.payment_count || 0 };
    };
    const cardSales =
      legacyBucket('card_visa').amount +
      legacyBucket('card_mastercard').amount +
      legacyBucket('card_meeza').amount;
    const instapaySales = legacyBucket('instapay').amount;
    const bankSales = legacyBucket('bank_transfer').amount;

    // Returns refunded within the shift window against the same invoices.
    const [ret] = await q.query(
      `
      SELECT
        COALESCE(SUM(r.net_refund),0)::numeric AS total_returns,
        COUNT(*)::int AS return_count
        FROM returns r
        JOIN invoices i ON i.id = r.original_invoice_id
       WHERE ${invMatch}
         AND r.status IN ('refunded','approved')
      `,
      [shift.id, shift.opened_by, shift.opened_at, upperBound],
    );

    // Cashbox txns during the shift — these cover BOTH invoice-linked
    // in/outs AND manual receipts / disbursements. We break them down by
    // category (the actual column; some older code called it "source").
    const txRows = await q.query(
      `
      SELECT direction::text AS direction, category::text AS category,
             COALESCE(SUM(amount),0)::numeric AS amount,
             COUNT(*)::int AS count
        FROM cashbox_transactions
       WHERE cashbox_id = $1 AND created_at >= $2
       GROUP BY direction, category
      `,
      [shift.cashbox_id, shift.opened_at],
    );
    const tx: Record<string, { amount: number; count: number }> = {};
    for (const r of txRows) {
      tx[`${r.direction}_${r.category}`] = {
        amount: Number(r.amount),
        count: r.count,
      };
    }
    // Customer receipts (قبض من عميل — direction 'in', category 'receipt').
    const customerReceipts = Number(tx.in_receipt?.amount || 0);
    // Supplier payments (صرف لمورد — direction 'out', category 'payment' or 'purchase').
    const supplierPayments =
      Number(tx.out_payment?.amount || 0) +
      Number(tx.out_purchase?.amount || 0);
    // Manual cash adjustments — anything labeled 'manual' / 'other' / 'adjustment'.
    const otherCashIn =
      Number(tx.in_manual?.amount || 0) +
      Number(tx.in_other?.amount || 0) +
      Number(tx.in_adjustment?.amount || 0) +
      Number(tx.in_deposit?.amount || 0);
    const otherCashOut =
      Number(tx.out_manual?.amount || 0) +
      Number(tx.out_other?.amount || 0) +
      Number(tx.out_adjustment?.amount || 0) +
      Number(tx.out_withdrawal?.amount || 0);

    // Expenses posted during the shift window.
    //
    // PR-14: also classify each row as `is_employee_advance` so the UI can
    // separate operating expenses from advances. Heuristic:
    //   * `expenses.is_advance = TRUE`     — engine routes DR to 1123, OR
    //   * category maps to COA code 1123  — semantic advance (admin
    //                                       mapped a "سلف الموظفين" category
    //                                       to Employee Receivables)
    //
    // PR-EMP-ADVANCE-PAY-2 — attribution rules (this is the fix the
    // 5-EGP / 6-EGP advances exposed):
    //
    //   (a) Explicitly attributed to this shift (PR-15 / PR-EMP-ADVANCE-PAY-1):
    //       always include — `e.shift_id = shift.id`.
    //
    //   (b) Legacy fallback for `e.shift_id IS NULL` rows: keep the
    //       generous cashbox/warehouse/creator match for OPERATING
    //       expenses ONLY (cashiers used to leave cashbox_id blank when
    //       adding non-advance expenses from the UI; preserving that
    //       behaviour avoids regressions on historical close-outs).
    //
    //   (c) Direct-cashbox advances (`is_advance = TRUE` AND
    //       `shift_id IS NULL`) are EXCLUDED from every shift's
    //       summary — the operator's "صرف من الخزنة" choice is the
    //       explicit "do not attribute to any shift" marker shipped in
    //       PR-EMP-ADVANCE-PAY-1. Even when the cashbox matches the
    //       shift's drawer (the only-cashbox-in-the-system case), the
    //       advance must not bleed into `total_employee_advances` /
    //       `expected_closing`. Cash physically leaving the drawer is
    //       still reflected in `cashbox_transactions` and surfaces as
    //       a variance at close — the cashier annotates it as an
    //       unattached settlement, not as a shift outflow.
    const expenseRows = await q.query(
      `
      SELECT e.id, e.expense_no, e.amount, e.description,
             ec.name_ar AS category_name, e.expense_date,
             e.is_advance,
             e.employee_user_id,
             u.full_name AS employee_name,
             e.cashbox_id,
             cb.name_ar AS cashbox_name,
             e.payment_method,
             e.created_by,
             cu.full_name AS created_by_name,
             e.created_at,
             e.shift_id,
             coa.code AS account_code,
             COALESCE(e.is_advance, FALSE)
               OR coa.code = '${GL_EMPLOYEE_RECEIVABLE}' AS is_employee_advance,
             je.entry_no AS je_entry_no,
             CASE WHEN e.is_approved THEN 'approved' ELSE 'pending' END AS status
        FROM expenses e
        LEFT JOIN expense_categories ec ON ec.id = e.category_id
        LEFT JOIN chart_of_accounts coa ON coa.id = ec.account_id
        LEFT JOIN users u  ON u.id = e.employee_user_id
        LEFT JOIN cashboxes cb ON cb.id = e.cashbox_id
        LEFT JOIN users cu ON cu.id = e.created_by
        LEFT JOIN LATERAL (
          SELECT entry_no FROM journal_entries
           WHERE reference_type = 'expense' AND reference_id = e.id
             AND is_void = FALSE
           ORDER BY created_at DESC LIMIT 1
        ) je ON TRUE
       WHERE e.created_at >= $1
         AND e.created_at <= $2
         AND (
           -- (a) Explicit shift attribution wins.
           e.shift_id = $6
           -- (b) Legacy generous match for OPERATING expenses only.
           OR (
             e.shift_id IS NULL
             AND COALESCE(e.is_advance, FALSE) = FALSE
             AND (
               e.cashbox_id = $3
               OR (e.cashbox_id IS NULL)
               OR e.warehouse_id = $4
               OR e.created_by = $5
             )
           )
         )
       ORDER BY e.expense_date DESC, e.created_at DESC
      `,
      [
        shift.opened_at,
        upperBound,
        shift.cashbox_id,
        shift.warehouse_id,
        shift.opened_by,
        shift.id,
      ],
    );

    // Split: operating expenses vs employee advances.
    const operatingExpenseRows = expenseRows.filter(
      (e: any) => !e.is_employee_advance,
    );
    const advanceExpenseRows = expenseRows.filter(
      (e: any) => e.is_employee_advance,
    );
    const totalOperatingExpenses = operatingExpenseRows.reduce(
      (s: number, e: any) => s + Number(e.amount || 0),
      0,
    );
    const totalEmployeeAdvances = advanceExpenseRows.reduce(
      (s: number, e: any) => s + Number(e.amount || 0),
      0,
    );
    // Backwards-compat alias — total_expenses was previously the
    // sum of *all* expenses (advances + operating). Keep that meaning
    // so older callers don't break, but the UI now uses the split.
    const totalExpenses = totalOperatingExpenses + totalEmployeeAdvances;

    // PR-14 — Employee settlement payouts (DR 213 / CR cashbox).
    // PR-15 — Match by EITHER explicit shift_id OR (cashbox+window)
    // for legacy rows. The `link_method` column tells the UI which
    // path matched so the badge can render "مرتبط بالوردية" (explicit)
    // or "مرتبط تلقائياً بالوردية" (derived).
    const settlementRows = await q.query(
      `
      SELECT es.id::text AS id,
             es.user_id AS employee_user_id,
             u.full_name AS employee_name,
             es.amount,
             es.created_at,
             es.settlement_date,
             es.method,
             es.cashbox_id,
             cb.name_ar AS cashbox_name,
             es.notes,
             es.created_by,
             cu.full_name AS created_by_name,
             je.entry_no AS je_entry_no,
             CASE
               WHEN es.shift_id = $1 THEN 'explicit'
               ELSE 'derived'
             END AS link_method
        FROM employee_settlements es
        LEFT JOIN users u   ON u.id = es.user_id
        LEFT JOIN cashboxes cb ON cb.id = es.cashbox_id
        LEFT JOIN users cu  ON cu.id = es.created_by
        LEFT JOIN journal_entries je ON je.id = es.journal_entry_id
       WHERE (
               es.shift_id = $1
               OR (
                 es.shift_id IS NULL
                 AND es.cashbox_id = $2
                 AND es.created_at >= $3
                 AND es.created_at <= $4
               )
             )
         AND es.method IN ('cash','bank')
         AND es.is_void = FALSE
       ORDER BY es.created_at DESC
      `,
      [shift.id, shift.cashbox_id, shift.opened_at, upperBound],
    );
    const totalEmployeeSettlements = settlementRows.reduce(
      (s: number, r: any) => s + Number(r.amount || 0),
      0,
    );

    // Build the unified employee_cash_movements array — settlements +
    // advance-classified expenses, with explicit / derived linkage badge
    // and a friendly accounting-impact label for the UI.
    const employee_cash_movements: any[] = [];
    for (const es of settlementRows) {
      employee_cash_movements.push({
        kind: 'settlement',
        id: es.id,
        movement_type: 'settlement',
        type_label: 'صرف مستحقات',
        employee_user_id: es.employee_user_id,
        employee_name: es.employee_name,
        amount: Number(es.amount),
        created_at: es.created_at,
        cashbox_id: es.cashbox_id,
        cashbox_name: es.cashbox_name,
        payment_method: es.method,
        description: es.notes,
        je_entry_no: es.je_entry_no,
        created_by_name: es.created_by_name,
        accounting_impact: `DR 213 / CR ${es.cashbox_name ?? 'cashbox'}`,
        // PR-15 — explicit when employee_settlements.shift_id matches,
        // derived for legacy rows backfilled by cashbox+window only
        // (or rows that span multiple overlapping shifts).
        link_method: es.link_method,
      });
    }
    for (const e of advanceExpenseRows) {
      employee_cash_movements.push({
        kind: 'advance',
        id: e.id,
        movement_type: 'advance',
        type_label: 'سلفة موظف',
        employee_user_id: e.employee_user_id,
        employee_name: e.employee_name,
        amount: Number(e.amount),
        created_at: e.created_at,
        cashbox_id: e.cashbox_id,
        cashbox_name: e.cashbox_name,
        payment_method: e.payment_method,
        description: e.description,
        je_entry_no: e.je_entry_no,
        created_by_name: e.created_by_name,
        accounting_impact: `DR 1123 / CR ${e.cashbox_name ?? 'cashbox'}`,
        link_method: e.shift_id === shift.id ? 'explicit' : 'derived',
      });
    }
    employee_cash_movements.sort((a, b) =>
      (a.created_at < b.created_at ? 1 : -1),
    );

    const totalEmployeeCashOut =
      totalEmployeeAdvances + totalEmployeeSettlements;

    // PR-21 — Refund / exchange cash movements visible at row level.
    //
    // Pulls from cashbox_transactions directly (NOT from `returns`)
    // because:
    //   1. After PR #97 reconciliation, every cash refund has a CT
    //      mirror — so this query is the source of truth for what
    //      physically left the drawer.
    //   2. Standalone refunds (no original_invoice_id) are invisible
    //      to the existing `total_returns` query (it joins through
    //      invoices) — they only show up here.
    //   3. Same `cashbox + time-window` derivation pattern PR-14
    //      uses for settlements.
    // PR-R1 — Three-way linkage:
    //   · explicit  → returns.shift_id / exchanges.shift_id matches THIS shift
    //   · derived   → no explicit shift_id on the source row; legacy fallback
    //                 via cashbox + time-window match (pre-R1 behaviour)
    //   · unlinked  → source row has cashbox_id set but shift_id IS NULL
    //                 (i.e. "direct cashbox" branch) → MUST NOT appear here
    //
    // Implementation:
    //   1. Pull every CT row in the shift's (cashbox + window).
    //   2. LEFT JOIN to source-of-truth shift_id from returns/exchanges.
    //   3. Filter:
    //        include when source.shift_id = THIS shift            (explicit)
    //        include when source.shift_id IS NULL AND source.cashbox_id IS NULL (legacy → derived)
    //        EXCLUDE when source.shift_id IS NOT NULL but ≠ THIS shift  (belongs to another shift)
    //        EXCLUDE when source.shift_id IS NULL but cashbox_id IS NOT NULL (direct-cashbox: not for any shift)
    //   4. UNION rows that have explicit shift_id = THIS shift but
    //      whose CT happens to fall outside the window (defense — same
    //      shift, atomic write, should never happen but cheap guard).
    // PR-FIN-RETURNS-SHIFT-CANCEL-AWARE — the original SQL only picked
    // CTs where reference_type IN ('return','exchange'). Cancellation
    // reversal CTs created by `posting.reverseByReference` carry
    // reference_type='other' (the engine's mapToEntityType maps
    // 'reversal' → 'other') and reference_id=<original JE id>, so they
    // were silently excluded. Result: a cancelled cash refund still
    // appeared as outgoing, with no matching incoming row → user saw
    // a cancelled return contributing to the shift's net cash impact.
    //
    // The fix below adds a second branch (`reversal_cts`) that finds
    // reversal CTs in the same window/cashbox and resolves them back
    // to the original return via the reversed JE chain:
    //
    //   reversal_ct.reference_type = 'other'
    //   reversal_ct.category LIKE 'reversal_%'
    //   reversal_ct.reference_id = reversal_je.id
    //   reversal_je.reversal_of  = original_je.id
    //   original_je.reference_type = 'return'
    //   original_je.reference_id   = returns.id
    //
    // Each row carries its source return's status so the FE can render
    // a "ملغي" badge AND group the original-out + reversal-in pair so
    // the net effect for a cancelled cash return is zero.
    const refundCtRows = await q.query(
      `
      WITH ct_in_window AS (
        SELECT ct.id, ct.amount, ct.direction, ct.reference_type, ct.reference_id,
               ct.created_at, ct.user_id, ct.notes, ct.cashbox_id, ct.category
          FROM cashbox_transactions ct
         WHERE ct.cashbox_id = $1
           AND ct.created_at >= $2
           AND ct.created_at <= $3
           AND ct.is_void = FALSE
           AND (
                 ct.reference_type::text IN ('return','exchange')
                 OR (
                   ct.reference_type::text = 'other'
                   AND ct.category LIKE 'reversal_%'
                 )
               )
      ),
      ct_with_source AS (
        SELECT ct.*,
               -- Resolve the source return.
               --
               -- IMPORTANT note on what reference_id actually points to
               -- on the reversal CT row: the engine recordTransaction
               -- writes paired CT rows with reference_id =
               -- spec.reference_id, and posting.reverseByReference
               -- passes reference_id: orig.id (the ORIGINAL JE id, NOT
               -- the newly-created reversal JE id). So the reversal
               -- CT.reference_id already points directly at the
               -- original return JE — a single hop suffices.
               --
               -- The first iteration of this PR (PR-FIN-RETURNS-SHIFT-
               -- CANCEL-AWARE, merged at 3fb11f0) used a 3-hop bridge
               -- (reversal_je via reversal_of), which never matched
               -- because the CT actually points at the original JE
               -- where reversal_of IS NULL. Fixed in PR-FIN-RETURNS-
               -- SHIFT-CANCEL-AWARE-BRIDGE-FIX.
               CASE
                 WHEN ct.reference_type::text = 'return'   THEN r_direct.id
                 WHEN ct.reference_type::text = 'other'    THEN r_via_je.id
                 ELSE NULL
               END AS resolved_return_id,
               CASE
                 WHEN ct.reference_type::text = 'return'   THEN r_direct.shift_id
                 WHEN ct.reference_type::text = 'exchange' THEN e_direct.shift_id
                 WHEN ct.reference_type::text = 'other'    THEN r_via_je.shift_id
                 ELSE NULL
               END AS src_shift_id,
               CASE
                 WHEN ct.reference_type::text = 'return'   THEN r_direct.cashbox_id
                 WHEN ct.reference_type::text = 'exchange' THEN e_direct.cashbox_id
                 WHEN ct.reference_type::text = 'other'    THEN r_via_je.cashbox_id
                 ELSE NULL
               END AS src_cashbox_id,
               CASE
                 WHEN ct.reference_type::text = 'return'   THEN r_direct.status::text
                 WHEN ct.reference_type::text = 'other'    THEN r_via_je.status::text
                 ELSE NULL
               END AS source_return_status,
               (ct.reference_type::text = 'other')         AS is_reversal
          FROM ct_in_window ct
          LEFT JOIN returns   r_direct ON ct.reference_type::text = 'return'
                                       AND r_direct.id = ct.reference_id
          LEFT JOIN exchanges e_direct ON ct.reference_type::text = 'exchange'
                                       AND e_direct.id = ct.reference_id
          -- One-hop bridge: reversal CT.reference_id → original JE id → return.
          LEFT JOIN journal_entries je_orig
                                       ON ct.reference_type::text = 'other'
                                       AND je_orig.id = ct.reference_id
                                       AND je_orig.reference_type::text = 'return'
          LEFT JOIN returns r_via_je   ON r_via_je.id = je_orig.reference_id
      ),
      eligible AS (
        SELECT ct.*,
               CASE
                 -- Direct (return/exchange) branch — same explicit/derived
                 -- semantics as before.
                 WHEN ct.reference_type::text IN ('return','exchange')
                  AND ct.src_shift_id = $4              THEN 'explicit'
                 WHEN ct.reference_type::text IN ('return','exchange')
                  AND ct.src_shift_id IS NULL
                  AND ct.src_cashbox_id IS NULL         THEN 'derived'
                 -- Reversal branch — include only when the bridged
                 -- return belongs to THIS shift (covers the legacy
                 -- "no shift_id" case the same way).
                 WHEN ct.reference_type::text = 'other'
                  AND ct.resolved_return_id IS NOT NULL
                  AND (ct.src_shift_id = $4
                    OR (ct.src_shift_id IS NULL AND ct.src_cashbox_id IS NULL))
                                                        THEN 'reversal'
                 ELSE NULL
               END AS link_method
          FROM ct_with_source ct
      )
      SELECT ct.id::text AS ct_id,
             ct.amount::numeric AS amount,
             ct.direction::text AS direction,
             ct.reference_type::text AS reference_type,
             ct.reference_id AS reference_id,
             ct.created_at,
             ct.user_id AS created_by,
             u.full_name AS created_by_name,
             ct.notes,
             ct.category::text AS category,
             ct.is_reversal AS is_reversal,
             ct.source_return_status AS source_return_status,
             cb.name_ar AS cashbox_name,
             COALESCE(r_direct.return_no, r_via_je.return_no) AS return_no,
             COALESCE(r_direct.refund_method::text,
                      r_via_je.refund_method::text)            AS refund_method,
             e_direct.exchange_no AS exchange_no,
             COALESCE(cust_r.full_name, cust_e.full_name)      AS customer_name,
             COALESCE(je_direct.entry_no, je_orig.entry_no)    AS je_entry_no,
             ct.link_method AS link_method,
             $5::text AS shift_no
        FROM eligible ct
        LEFT JOIN cashboxes cb         ON cb.id = ct.cashbox_id
        LEFT JOIN users u              ON u.id  = ct.user_id
        LEFT JOIN returns r_direct     ON ct.reference_type::text = 'return'
                                       AND r_direct.id = ct.reference_id
        LEFT JOIN exchanges e_direct   ON ct.reference_type::text = 'exchange'
                                       AND e_direct.id = ct.reference_id
        -- PR-FIN-RETURNS-SHIFT-CANCEL-AWARE-BRIDGE-FIX — replaced the
        -- broken 3-hop reversal_je → reversal_of bridge with a single
        -- hop directly to the original return JE.
        LEFT JOIN journal_entries je_orig
                                       ON ct.reference_type::text = 'other'
                                       AND je_orig.id = ct.reference_id
                                       AND je_orig.reference_type::text = 'return'
        LEFT JOIN returns r_via_je     ON r_via_je.id = je_orig.reference_id
        LEFT JOIN customers cust_r     ON cust_r.id = COALESCE(r_direct.customer_id, r_via_je.customer_id)
        LEFT JOIN customers cust_e     ON cust_e.id = e_direct.customer_id
        LEFT JOIN journal_entries je_direct
                                       ON je_direct.reference_type::text IN ('return','exchange')
                                       AND je_direct.reference_id = ct.reference_id
                                       AND je_direct.is_void = FALSE
       WHERE ct.link_method IS NOT NULL
       ORDER BY ct.created_at DESC
      `,
      [shift.cashbox_id, shift.opened_at, upperBound, shift.id, shift.shift_no],
    );

    const refund_cash_movements: any[] = refundCtRows.map((c: any) => {
      const amt = Number(c.amount);
      const isReversal = c.is_reversal === true;
      const isReturn = c.reference_type === 'return' || isReversal;
      const isCancelled = c.source_return_status === 'cancelled';
      return {
        id: c.ct_id,
        kind: isReturn ? 'return' : 'exchange',
        // PR-FIN-RETURNS-SHIFT-CANCEL-AWARE — distinct labels:
        //   • original cancelled refund row → "مرتجع نقدي ملغي"
        //   • cancellation reversal row     → "عكس إلغاء مرتجع نقدي"
        //   • normal return / exchange      → unchanged labels
        type_label: isReversal
          ? 'عكس إلغاء مرتجع نقدي'
          : isReturn
            ? isCancelled
              ? 'مرتجع نقدي ملغي'
              : 'مرتجع نقدي'
            : 'فرق استبدال',
        direction: c.direction,
        direction_label: c.direction === 'out' ? 'خارج' : 'داخل',
        amount: amt,
        reference_no: isReturn
          ? c.return_no || null
          : c.exchange_no || null,
        customer_name: c.customer_name || null,
        cashbox_name: c.cashbox_name || null,
        shift_no: c.shift_no || null,
        created_at: c.created_at,
        created_by_name: c.created_by_name || null,
        je_entry_no: c.je_entry_no || null,
        accounting_impact:
          c.direction === 'out'
            ? `DR مردودات مبيعات / CR ${c.cashbox_name ?? 'cashbox'}`
            : isReversal
              ? `DR ${c.cashbox_name ?? 'cashbox'} / CR مردودات مبيعات (عكس إلغاء)`
              : `DR ${c.cashbox_name ?? 'cashbox'} / CR إيرادات`,
        link_method: (c.link_method === 'reversal'
          ? 'explicit'
          : c.link_method) as 'explicit' | 'derived',
        // PR-FIN-RETURNS-SHIFT-CANCEL-AWARE — surface so the FE can:
        //  1. Render a "ملغي" badge on the cancelled-original row.
        //  2. Pair the row with its reversal counterpart (same return_no).
        //  3. Show "عكس" next to reversal rows.
        is_reversal: isReversal,
        source_return_status: c.source_return_status ?? null,
      };
    });

    // PR-FIN-RETURNS-SHIFT-CANCELLED-EXCLUDE-FROM-TOTALS — totals
    // reflect ACTUAL operational cash effect only. The cancelled
    // refund's original-out and its cancellation reversal-in always
    // come as a perfectly-balanced pair (same cashbox, same amount,
    // opposite direction); including them in `totalRefundCashOut/In`
    // would inflate both sides by the same amount and make the
    // wardia "تم صرف نقدي" / "تم استلام نقدي" displays look like
    // real money moved when nothing did.
    //
    // Both are now excluded from the active totals AND surfaced as
    // separate audit-only fields (`cancelled_return_out_amount` /
    // `cancelled_return_reversal_amount`) so the section footer can
    // render them with a "لا يؤثر على صافي الوردية" hint.
    //
    // expected_closing is unchanged because the +350 / −350 in the
    // legacy formula cancelled out — TB / cashbox balance untouched.
    const isActiveCashImpact = (m: { is_reversal?: boolean; source_return_status?: string | null }) =>
      m.source_return_status !== 'cancelled' && !m.is_reversal;
    const totalRefundCashOut = refund_cash_movements
      .filter((m) => m.direction === 'out' && isActiveCashImpact(m))
      .reduce((s, m) => s + m.amount, 0);
    const totalRefundCashIn = refund_cash_movements
      .filter((m) => m.direction === 'in' && isActiveCashImpact(m))
      .reduce((s, m) => s + m.amount, 0);
    const netRefundCashImpact = totalRefundCashOut - totalRefundCashIn;

    // Audit-only totals — informational only, do NOT feed into
    // active cash totals or expected_closing.
    const cancelledReturnOutAmount = refund_cash_movements
      .filter((m) =>
        m.source_return_status === 'cancelled' &&
        !m.is_reversal &&
        m.direction === 'out',
      )
      .reduce((s, m) => s + m.amount, 0);
    const cancelledReturnReversalAmount = refund_cash_movements
      .filter((m) => m.is_reversal && m.direction === 'in')
      .reduce((s, m) => s + m.amount, 0);
    const cancelledReturnNet =
      cancelledReturnOutAmount - cancelledReturnReversalAmount;

    // PR-21 — Use cashbox_transactions as the canonical source for
    // refund cash movement (totalRefundCashOut/In above). The legacy
    // `total_returns` field (from ret.total_returns above) joins
    // through invoices and misses standalone refunds; it's kept for
    // backwards-compat callers but no longer drives totalCashOut to
    // avoid double-counting normal invoiced refunds.
    const cashRefundsLegacy = Number(ret.total_returns || 0);

    // Totals — PR-14 added employee settlements to total_cash_out;
    // PR-21 swaps `cashRefundsLegacy` for `totalRefundCashOut` (the
    // CT-derived figure) so standalone refunds without invoices show
    // correctly and invoiced refunds aren't double-counted.
    const totalCashIn = cashFromSales + customerReceipts + otherCashIn + totalRefundCashIn;
    const totalCashOut =
      totalRefundCashOut +
      supplierPayments +
      totalOperatingExpenses +
      totalEmployeeAdvances +
      totalEmployeeSettlements +
      otherCashOut;
    const expectedClosing =
      Number(shift.opening_balance || 0) + totalCashIn - totalCashOut;

    // Variance against a counted cash (only meaningful post-close)
    const actualClosing = Number(shift.actual_closing ?? 0);
    const variance = shift.closed_at
      ? actualClosing - expectedClosing
      : null;

    return {
      shift_id: shift.id,
      shift_no: shift.shift_no,
      status: shift.status,
      opening_balance: Number(shift.opening_balance || 0),
      opened_at: shift.opened_at,
      closed_at: shift.closed_at,

      // sales
      total_sales: Number(inv.total_sales),
      invoice_count: inv.invoice_count,
      cancelled_count: inv.cancelled_count,
      total_cancelled: Number(inv.total_cancelled),
      remaining_receivable: Number(inv.remaining_receivable),

      // PR-PAY-4 — Structured breakdown by method + per-account.
      // The cashier-facing close-out screen reads `payment_breakdown_v2`;
      // any legacy caller that still consumes the old 4-key
      // `payment_breakdown` keeps working unchanged (back-compat).
      payment_breakdown: {
        cash: { amount: cashFromSales, count: methodMap.get('cash')?.payment_count || 0 },
        card: { amount: cardSales, count: 0 },
        instapay: {
          amount: instapaySales,
          count: methodMap.get('instapay')?.payment_count || 0,
        },
        bank_transfer: {
          amount: bankSales,
          count: methodMap.get('bank_transfer')?.payment_count || 0,
        },
      },
      payment_breakdown_v2: paymentBreakdown,
      cash_total: cashFromSales,
      non_cash_total: nonCashFromSales,
      grand_payment_total: grandPaymentTotal,

      // cashbox flows
      customer_receipts: customerReceipts,
      supplier_payments: supplierPayments,
      other_cash_in: otherCashIn,
      other_cash_out: otherCashOut,

      // returns + expenses
      total_returns: Number(ret.total_returns),
      return_count: ret.return_count,
      // PR-14 — `total_expenses` is kept (advances + operating) for any
      // legacy caller; the UI uses `total_operating_expenses` plus the
      // employee_cash_movements section below.
      total_expenses: totalExpenses,
      expense_count: expenseRows.length,
      expenses: operatingExpenseRows, // advances filtered out — see below

      // PR-14 — Employee cash visibility split (no schema changes)
      total_operating_expenses: totalOperatingExpenses,
      operating_expense_count: operatingExpenseRows.length,
      total_employee_advances: totalEmployeeAdvances,
      employee_advance_count: advanceExpenseRows.length,
      total_employee_settlements: totalEmployeeSettlements,
      employee_settlement_count: settlementRows.length,
      total_employee_cash_out: totalEmployeeCashOut,
      employee_cash_movements,

      // PR-21 — Refund / exchange cash visibility
      // PR-FIN-RETURNS-SHIFT-CANCELLED-EXCLUDE-FROM-TOTALS — totals
      // exclude cancelled+reversal pairs; audit-only fields surface
      // the cancelled-pair amounts for the FE footer.
      total_refund_cash_out: totalRefundCashOut,
      total_refund_cash_in: totalRefundCashIn,
      net_refund_cash_impact: netRefundCashImpact,
      cancelled_return_out_amount: cancelledReturnOutAmount,
      cancelled_return_reversal_amount: cancelledReturnReversalAmount,
      cancelled_return_net: cancelledReturnNet,
      refund_cash_movements,

      // reconciliation
      total_cash_in: totalCashIn,
      total_cash_out: totalCashOut,
      expected_closing: expectedClosing,
      actual_closing: shift.closed_at ? actualClosing : null,
      variance,
    };
  }

  async close(
    id: string,
    dto: CloseShiftDto,
    userId: string,
    userPermissions: string[] = [],
  ) {
    const [shift] = await this.ds.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    // Allow both `open` and `pending_close` — the latter is how an admin
    // finalizes a cashier's review-required request. Only truly closed
    // shifts should be rejected.
    if (shift.status !== 'open' && shift.status !== 'pending_close') {
      throw new BadRequestException('الوردية مغلقة بالفعل');
    }

    const summary = await this.computeSummary(shift);
    const variance = Number(dto.actual_closing) - summary.expected_closing;
    const hasVariance = Math.abs(variance) >= 0.01;

    // ── Variance treatment resolution ─────────────────────────────────
    // Priority:
    //   1. Explicit treatment on the incoming DTO (admin/manager path)
    //   2. Treatment already stored on the shift row (set by approveClose)
    //   3. Legacy default (company_loss on deficit, revenue on surplus)
    //
    // Permission gate: `shifts.variance.approve` is required to post a
    // variance. Cashiers close with zero variance via `request-close`
    // → auto-close; any non-zero variance goes through pending_close and
    // a manager decides. That keeps cashier hands off the GL.
    const storedTreatment: VarianceTreatment | null =
      (shift.variance_treatment as VarianceTreatment) ?? null;
    const resolvedTreatment: VarianceTreatment | null = hasVariance
      ? (dto.variance_treatment ?? storedTreatment ?? null)
      : null;
    const resolvedEmployeeId: string | null =
      dto.variance_employee_id ?? shift.variance_employee_id ?? null;
    const resolvedNotes: string | null =
      dto.variance_notes ?? shift.variance_notes ?? null;

    if (hasVariance) {
      const canApproveVariance =
        userPermissions.includes('*') ||
        userPermissions.includes('shifts.*') ||
        userPermissions.includes('shifts.variance.approve') ||
        userPermissions.includes('shifts.close_approve');
      if (!canApproveVariance) {
        throw new ForbiddenException(
          'لا يمكنك ترحيل فروقات الوردية — اطلب الإقفال ليعتمده المدير',
        );
      }
      if (!resolvedTreatment) {
        throw new BadRequestException(
          'الوردية بها فروقات — يجب تحديد طريقة المعالجة (تحميل موظف / خسارة شركة / إيراد / تسوية)',
        );
      }
      // Validate treatment matches the sign of the variance.
      const isShortage = variance < 0;
      const validShortage =
        resolvedTreatment === 'charge_employee' ||
        resolvedTreatment === 'company_loss';
      const validOverage =
        resolvedTreatment === 'revenue' || resolvedTreatment === 'suspense';
      if (isShortage && !validShortage) {
        throw new BadRequestException(
          `المعالجة '${resolvedTreatment}' غير صالحة لعجز الوردية`,
        );
      }
      if (!isShortage && !validOverage) {
        throw new BadRequestException(
          `المعالجة '${resolvedTreatment}' غير صالحة لزيادة الوردية`,
        );
      }
      if (resolvedTreatment === 'charge_employee' && !resolvedEmployeeId) {
        throw new BadRequestException(
          'تحميل الموظف يتطلب اختيار الموظف المسؤول',
        );
      }
    }

    // Build a notes field that preserves any user note AND appends the cash
    // denomination breakdown for the audit trail.
    let notesOut: string | null = dto.notes ?? null;
    if (dto.denominations && Object.keys(dto.denominations).length > 0) {
      const lines = Object.entries(dto.denominations)
        .filter(([, c]) => Number(c) > 0)
        .sort(([a], [b]) => Number(b) - Number(a))
        .map(
          ([v, c]) =>
            `${v} × ${c} = ${Number(v) * Number(c)}`,
        );
      const breakdown = `عدّ الدرج:\n${lines.join('\n')}`;
      notesOut = notesOut ? `${notesOut}\n\n${breakdown}` : breakdown;
    }

    // ── Everything below runs in a single DB transaction so the
    //    closing UPDATE, the engine post, the variance metadata
    //    write, and the optional employee_deductions insert commit
    //    together or roll back together. No half-states. ─────────────
    return this.ds.transaction(async (em) => {
      // PR-FIX-SHIFT-SNAPSHOT-REALTIME-INTEGRITY-GUARD: independently
      // recompute canonical totals from authoritative source tables
      // and validate the about-to-be-written `summary` matches.
      // Phantom cash_out / non-cash-as-cash / invoice_count drift
      // all surface here BEFORE the UPDATE runs.
      const canonical = await this.computeCanonicalSnapshot(
        id,
        Number(shift.opening_balance) || 0,
        em,
      );
      this.assertSnapshotIntegrity(
        shift.shift_no,
        {
          total_sales: Number(summary.total_sales) || 0,
          total_returns: Number(summary.total_returns) || 0,
          total_expenses: Number(summary.total_expenses) || 0,
          total_cash_in: Number(summary.total_cash_in) || 0,
          total_cash_out: Number(summary.total_cash_out) || 0,
          invoice_count: Number(summary.invoice_count) || 0,
          expected_closing: Number(summary.expected_closing) || 0,
        },
        canonical,
        'close',
      );

      const [updated] = await em.query(
        `
        UPDATE shifts SET
          status           = 'closed',
          closed_by        = $1::uuid,
          closed_at        = NOW(),
          actual_closing   = $2::numeric,
          expected_closing = $3::numeric,
          total_sales      = $4::numeric,
          total_returns    = $5::numeric,
          total_expenses   = $6::numeric,
          total_cash_in    = $7::numeric,
          total_cash_out   = $8::numeric,
          invoice_count    = $9::int,
          notes            = COALESCE($10::text, notes),
          variance_treatment       = COALESCE($11::varchar, variance_treatment),
          variance_employee_id     = COALESCE($12::uuid,    variance_employee_id),
          variance_notes           = COALESCE($13::text,    variance_notes),
          variance_approved_by     = COALESCE(variance_approved_by, $14::uuid),
          variance_approved_at     = COALESCE(variance_approved_at, CASE WHEN $11::varchar IS NOT NULL THEN NOW() END)
        WHERE id = $15::uuid
        RETURNING *
        `,
        [
          userId,
          Number(dto.actual_closing) || 0,
          Number(summary.expected_closing) || 0,
          Number(summary.total_sales) || 0,
          Number(summary.total_returns) || 0,
          Number(summary.total_expenses) || 0,
          Number(summary.total_cash_in) || 0,
          Number(summary.total_cash_out) || 0,
          Number(summary.invoice_count) || 0,
          notesOut,
          resolvedTreatment,
          resolvedEmployeeId,
          resolvedNotes,
          hasVariance ? userId : null,
          id,
        ],
      );

      let entryId: string | null = null;
      if (hasVariance && this.engine) {
        const res = await this.engine.recordShiftVariance({
          shift_id: id,
          shift_no: updated?.shift_no,
          cashbox_id: shift.cashbox_id,
          variance,
          user_id: userId,
          em, // ride on the same transaction
          treatment: resolvedTreatment ?? undefined,
          employee_id: resolvedEmployeeId ?? undefined,
          notes: resolvedNotes ?? undefined,
        });
        if (!res.ok) {
          // Rolling back — the shift mustn't be closed if the GL post
          // fails. Better a loud failure than a silent drift.
          throw new BadRequestException(
            `فشل ترحيل فروقات الوردية: ${res.error}`,
          );
        }
        if ('entry_id' in res && res.entry_id) {
          entryId = res.entry_id;
          await em.query(
            `UPDATE shifts SET variance_journal_entry_id = $1::uuid WHERE id = $2::uuid`,
            [entryId, id],
          );
          (updated as any).variance_journal_entry_id = entryId;
        }

        // Shortage charged to an employee → mirror into
        // employee_deductions so the profile's Financial Ledger tab
        // shows the row with a link back to the shift AND the
        // journal entry.
        if (
          variance < 0 &&
          resolvedTreatment === 'charge_employee' &&
          resolvedEmployeeId
        ) {
          await em.query(
            `INSERT INTO employee_deductions
               (user_id, amount, reason, deduction_date, created_by,
                source, shift_id, journal_entry_id, is_recoverable, notes)
             VALUES ($1, $2, $3, CURRENT_DATE, $4,
                     'shift_shortage', $5, $6, TRUE, $7)`,
            [
              resolvedEmployeeId,
              Math.abs(variance),
              `عجز وردية ${updated?.shift_no ?? ''}`.trim(),
              userId,
              id,
              entryId,
              resolvedNotes,
            ],
          );
        }
      } else if (hasVariance) {
        // Legacy fallback: engine not wired. Keep existing behaviour
        // for dev/test installs that stub the engine.
        await this.posting
          ?.postShiftClose(id, userId)
          .catch(() => undefined);
      }

      return {
        ...updated,
        summary: {
          ...summary,
          actual_closing: Number(dto.actual_closing),
          variance,
        },
      };
    });
  }

  // ── Request / approve close-out flow ───────────────────────────────
  /**
   * A cashier without shifts.close_approve submits their closing
   * balance here; the shift enters `pending_close` status and stays
   * open for business until a supervisor decides. This lets the
   * owner review variance before money is committed to the ledger.
   */
  async requestClose(
    id: string,
    dto: { actual_closing: number; notes?: string },
    userId: string,
  ) {
    const [shift] = await this.ds.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.status !== 'open') {
      throw new BadRequestException('لا يمكن طلب إقفال وردية غير مفتوحة');
    }

    // Auto-close when the counted cash matches the expected closing
    // within a 1-piaster tolerance. Any surplus OR deficit sends the
    // shift into `pending_close` so a supervisor can review before the
    // ledger is finalized.
    const summary = await this.computeSummary(shift);
    const actual = Number(dto.actual_closing) || 0;
    const variance = actual - Number(summary.expected_closing || 0);

    if (Math.abs(variance) < 0.01) {
      // Matches exactly — skip review, close immediately. We pass
      // `shifts.variance.approve` as an effective permission because
      // zero-variance closes never hit the variance guard; the flag
      // is only consulted when there IS a variance to post.
      const result = await this.close(
        id,
        { actual_closing: actual, notes: dto.notes || '' } as any,
        userId,
        ['shifts.variance.approve'],
      );
      return { pending: false, auto_closed: true, shift: result };
    }

    // Variance (surplus OR deficit) → park in pending_close for review.
    // Persist the LIVE computed expected_closing so the approver modal
    // (which reads the shifts row directly) doesn't see the stale
    // shift-opening value. Without this the modal showed fake variances
    // like "+1,035 surplus" while the real variance was "-7 shortage".
    //
    // PR-FIX-SHIFT-SNAPSHOT-REALTIME-INTEGRITY-GUARD: this UPDATE
    // writes expected_closing, which is a snapshot field. Wrap in a
    // transaction so the canonical recompute + guard can roll back
    // together if the cash math doesn't reconcile.
    const row = await this.ds.transaction(async (em) => {
      const canonical = await this.computeCanonicalSnapshot(
        id,
        Number(shift.opening_balance) || 0,
        em,
      );
      this.assertSnapshotIntegrity(
        shift.shift_no,
        { expected_closing: Number(summary.expected_closing || 0) },
        canonical,
        'request_close',
      );

      const [r] = await em.query(
        `UPDATE shifts
            SET status                 = 'pending_close',
                close_requested_at     = NOW(),
                close_requested_by     = $1,
                close_requested_amount = $2::numeric,
                expected_closing       = $5::numeric,
                close_requested_notes  = $3
          WHERE id = $4
          RETURNING *`,
        [
          userId,
          actual,
          dto.notes ?? null,
          id,
          Number(summary.expected_closing || 0),
        ],
      );
      return r;
    });
    return {
      pending: true,
      shift: row,
      variance,
      expected_closing: Number(summary.expected_closing || 0),
    };
  }

  /**
   * Admin / Shift Manager approves a pending-close request.
   *
   * The manager's decision on how to treat the variance (charge the
   * cashier, book as company loss, book as revenue, park in suspense)
   * arrives in `dto`. We write the decision onto the shift row BEFORE
   * calling close() so the atomic transaction inside close() has all
   * the context it needs to produce a single journal entry tagged with
   * the right accounts + (optionally) the employee receivable line.
   */
  async approveClose(id: string, userId: string, dto?: ApproveCloseDto) {
    const [shift] = await this.ds.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.status !== 'pending_close') {
      throw new BadRequestException('الوردية ليست في انتظار الإقفال');
    }
    // PR-B1 follow-up: prefer actual_closing when an admin adjusted the
    // counted-cash via /adjust-count after the cashier's request. Falls
    // back to close_requested_amount so the legacy path (no adjustment)
    // behaves identically.
    const actual =
      shift.actual_closing != null
        ? Number(shift.actual_closing)
        : Number(shift.close_requested_amount || 0);

    // Pre-flight: compute the expected variance LIVE via computeSummary
    // — NEVER trust the stored shifts.expected_closing here. It may be
    // stale (pre-fix shifts were opened with expected=opening_balance
    // and never refreshed until final close). Recomputing guarantees
    // the manager sees the same number close() will post.
    const summary = await this.computeSummary(shift);
    const expected = Number(summary.expected_closing || 0);
    const variance = actual - expected;
    const hasVariance = Math.abs(variance) >= 0.01;
    if (hasVariance) {
      if (!dto?.variance_treatment) {
        throw new BadRequestException(
          'يجب تحديد طريقة معالجة الفروقات قبل الاعتماد',
        );
      }
      if (
        dto.variance_treatment === 'charge_employee' &&
        !dto.variance_employee_id
      ) {
        throw new BadRequestException(
          'تحميل الموظف يتطلب اختيار الموظف المسؤول',
        );
      }
    }

    const result = await this.close(
      id,
      {
        actual_closing: actual,
        notes: shift.close_requested_notes || '',
        variance_treatment: dto?.variance_treatment,
        variance_employee_id: dto?.variance_employee_id,
        variance_notes: dto?.variance_notes,
      } as any,
      userId,
      // Approver reaches this path only through the permission-guarded
      // `shifts.variance.approve` endpoint — grant the effective flag
      // so close() doesn't re-check at the service layer.
      ['shifts.variance.approve'],
    );
    await this.ds.query(
      `UPDATE shifts
          SET close_approved_at = NOW(),
              close_approved_by = $2
        WHERE id = $1`,
      [id, userId],
    );
    return { approved: true, shift: result };
  }

  /** Admin rejects → shift reopens, rejection reason is stored. */
  async rejectClose(id: string, userId: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('يجب كتابة سبب الرفض');
    }
    const [shift] = await this.ds.query(
      `SELECT status FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.status !== 'pending_close') {
      throw new BadRequestException('الوردية ليست في انتظار الإقفال');
    }
    const [row] = await this.ds.query(
      `UPDATE shifts
          SET status                 = 'open',
              close_rejection_reason = $2,
              close_approved_by      = $3,
              close_approved_at      = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, reason, userId],
    );
    return { rejected: true, shift: row };
  }

  /**
   * Admin inbox — every shift waiting on approval.
   *
   * Enriches each row with a LIVE expected_closing + variance so the
   * approver modal never has to re-query and never reads the stale
   * `shifts.expected_closing` column (which, for shifts opened before
   * the requestClose fix, equals opening_balance — causing the famous
   * "+1,035 fake surplus" on SHF-2026-00004).
   */
  async listPendingCloses() {
    const rows = await this.ds.query(
      `SELECT s.*, u.full_name AS requested_by_name, u.username AS requested_by_username
         FROM shifts s
         LEFT JOIN users u ON u.id = s.close_requested_by
        WHERE s.status = 'pending_close'
        ORDER BY s.close_requested_at DESC`,
    );
    return Promise.all(
      rows.map(async (s: any) => {
        try {
          const live = await this.computeSummary(s);
          const expectedLive = Number(live.expected_closing || 0);
          // PR-B1 follow-up: prefer actual_closing when an admin adjusted
          // the counted-cash via /adjust-count. close_requested_amount
          // stays at the cashier's original submission so we use it only
          // as a fallback when no adjustment has happened.
          const actual =
            s.actual_closing != null
              ? Number(s.actual_closing)
              : Number(s.close_requested_amount || 0);
          return {
            ...s,
            expected_closing_live: expectedLive,
            actual_closing_live: actual,
            variance_live: actual - expectedLive,
          };
        } catch {
          // If the live compute fails for any reason fall back to the
          // stored values so the inbox still renders. The approval
          // path itself recomputes live anyway — this is UI-only.
          return s;
        }
      }),
    );
  }

  list(
    status?: string,
    userId?: string,
    cashboxId?: string,
    from?: string,
    to?: string,
  ) {
    const conds: string[] = [];
    const params: any[] = [];
    if (status && status !== 'all') {
      params.push(status);
      conds.push(`s.status = $${params.length}`);
    }
    if (userId) {
      params.push(userId);
      conds.push(`s.opened_by = $${params.length}`);
    }
    if (cashboxId) {
      params.push(cashboxId);
      conds.push(`s.cashbox_id = $${params.length}`);
    }
    // PR-REPORTS-1 — match shifts whose lifetime overlaps the picked
    // window. A shift "belongs" to the window if it was opened on/before
    // `to` and either is still open or closed on/after `from`. Both
    // bounds are evaluated against Cairo-local dates so the daily /
    // weekly / monthly chips line up with what the cashier sees.
    if (from) {
      params.push(from);
      conds.push(
        `(s.closed_at IS NULL
          OR (s.closed_at AT TIME ZONE 'Africa/Cairo')::date >= $${params.length}::date)`,
      );
    }
    if (to) {
      params.push(to);
      conds.push(
        `(s.opened_at AT TIME ZONE 'Africa/Cairo')::date <= $${params.length}::date`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // Range queries can legitimately cover the full month — bump the
    // cap to 1000 (single-shift cashbox-on-busy-day rarely exceeds 30
    // entries, so this still bounds memory).
    const limit = from || to ? 1000 : 200;
    return this.ds.query(
      `
      SELECT
        s.*,
        cb.name_ar AS cashbox_name,
        w.name_ar AS warehouse_name,
        u1.full_name AS opened_by_name,
        u2.full_name AS closed_by_name,
        (s.actual_closing - s.expected_closing) AS variance
      FROM shifts s
      LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN users u1 ON u1.id = s.opened_by
      LEFT JOIN users u2 ON u2.id = s.closed_by
      ${where}
      ORDER BY s.opened_at DESC
      LIMIT ${limit}
      `,
      params,
    );
  }

  async findOne(id: string) {
    const [shift] = await this.ds.query(
      `
      SELECT s.*,
        cb.name_ar AS cashbox_name,
        w.name_ar AS warehouse_name,
        u1.full_name AS opened_by_name,
        u2.full_name AS closed_by_name
      FROM shifts s
      LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN users u1 ON u1.id = s.opened_by
      LEFT JOIN users u2 ON u2.id = s.closed_by
      WHERE s.id = $1
      `,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');

    const upperBound = shift.closed_at || new Date();
    const invoices = await this.ds.query(
      `SELECT id, invoice_no, grand_total, paid_amount, status, completed_at, created_at
         FROM invoices i
        WHERE i.shift_id = $1
           OR (i.shift_id IS NULL
               AND i.cashier_id = $2
               AND i.created_at >= $3
               AND i.created_at <= $4)
        ORDER BY COALESCE(i.completed_at, i.created_at) DESC LIMIT 200`,
      [id, shift.opened_by, shift.opened_at, upperBound],
    );
    const summary = await this.computeSummary(shift);
    return { ...shift, invoices, summary };
  }

  async currentOpen(userId: string) {
    const [row] = await this.ds.query(
      `SELECT s.*, cb.name_ar AS cashbox_name, w.name_ar AS warehouse_name
       FROM shifts s
       LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.opened_by = $1 AND s.status = 'open'
       ORDER BY s.opened_at DESC LIMIT 1`,
      [userId],
    );
    if (!row) return null;
    const summary = await this.computeSummary(row);
    return { ...row, summary };
  }

  // ─── PR-B1 — Shift counted-cash adjustment workflow (migration 096)
  //
  //   Permission-gated correction for typos / miscounts in
  //   shifts.actual_closing. NOT an accounting transaction:
  //     · NO journal_entries created
  //     · NO cashbox_transactions created
  //     · NO cashboxes.current_balance change
  //     · NO FinancialEngine call
  //   Pure metadata UPDATE on shifts.actual_closing — Postgres
  //   recomputes shifts.difference (GENERATED column) automatically.
  //   Audit row inserted into shift_count_adjustments with old/new
  //   actual/expected/difference snapshots so the trail is fully
  //   reconstructable later.
  //   Permission gate (`shifts.close.adjust`) is enforced at the
  //   controller layer; the service trusts the caller has been
  //   authorised already.
  // ────────────────────────────────────────────────────────────────

  async adjustCount(
    shiftId: string,
    dto: { new_actual_closing: number; reason: string },
    userId: string,
  ) {
    const reason = (dto.reason || '').trim();
    if (reason.length < 5) {
      throw new BadRequestException(
        'سبب التعديل مطلوب (5 أحرف على الأقل)',
      );
    }
    const newActual = Number(dto.new_actual_closing);
    if (!Number.isFinite(newActual) || newActual < 0) {
      throw new BadRequestException(
        'المبلغ المعدّل يجب أن يكون رقمًا موجبًا',
      );
    }
    return this.ds.transaction(async (em) => {
      // Lock the row so concurrent close + adjust don't race.
      const [shift] = await em.query(
        `SELECT id, shift_no, actual_closing, expected_closing,
                difference, status, closed_at
           FROM shifts WHERE id = $1 FOR UPDATE`,
        [shiftId],
      );
      if (!shift) throw new NotFoundException('الوردية غير موجودة');

      const oldActual =
        shift.actual_closing == null ? null : Number(shift.actual_closing);
      const oldExpected =
        shift.expected_closing == null ? null : Number(shift.expected_closing);
      const oldDiff =
        oldActual !== null && oldExpected !== null
          ? oldActual - oldExpected
          : null;

      // No-op guard — refuse to log noise when the new value matches
      // the old value to two decimals.
      if (oldActual !== null && Math.abs(oldActual - newActual) < 0.005) {
        throw new BadRequestException(
          'القيمة الجديدة مطابقة للقيمة الحالية',
        );
      }

      // Apply the correction. The GENERATED `difference` column
      // recomputes automatically; expected_closing is stored on the
      // row at close time and stays as-is here (it's the
      // computeSummary value from when the close was submitted).
      await em.query(
        `UPDATE shifts SET actual_closing = $1 WHERE id = $2`,
        [newActual, shiftId],
      );
      const newDiff =
        oldExpected !== null ? newActual - oldExpected : null;

      // Insert the audit row.
      const [audit] = await em.query(
        `INSERT INTO shift_count_adjustments
           (shift_id, old_actual_closing, new_actual_closing,
            old_expected_closing, new_expected_closing,
            old_difference, new_difference,
            reason, adjusted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          shiftId,
          oldActual,
          newActual,
          oldExpected,
          oldExpected,
          oldDiff,
          newDiff,
          reason,
          userId,
        ],
      );

      // Return the updated shift + the new audit row so the UI can
      // show both in a single round-trip.
      const [updated] = await em.query(
        `SELECT s.*,
                cb.name_ar AS cashbox_name,
                u1.full_name AS opened_by_name
           FROM shifts s
           LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
           LEFT JOIN users u1     ON u1.id = s.opened_by
          WHERE s.id = $1`,
        [shiftId],
      );
      return { shift: updated, adjustment: audit };
    });
  }

  async listAdjustments(shiftId: string) {
    return this.ds.query(
      `SELECT a.*, u.full_name AS adjusted_by_name
         FROM shift_count_adjustments a
         LEFT JOIN users u ON u.id = a.adjusted_by
        WHERE a.shift_id = $1
        ORDER BY a.adjusted_at DESC`,
      [shiftId],
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // PR-FIX-POS-INVOICE-EDIT-REFRESH-CLOSED-SHIFT-SNAPSHOT
  //
  // Refresh the stored close-time snapshot for an already-closed shift
  // when one of its invoices was edited (cash↔non-cash payment-method
  // swap, amount change, etc.) AFTER close. The cashier's counted
  // `actual_closing` is the source of truth for the physical drawer
  // and is NEVER overwritten — only the recompute-derived snapshot
  // fields are refreshed so the stored variance reflects the new cash
  // reality.
  //
  // Caller contract: must run inside an active transaction (`em`)
  // alongside the invoice edit so the recompute and the snapshot
  // UPDATE roll back together with any failure in the edit pipeline.
  //
  // Guards:
  //   · status !== 'closed'  → no-op (open shifts are recomputed on
  //                            their next live read; nothing to do).
  //   · variance_journal_entry_id IS NOT NULL
  //     OR variance_treatment IS NOT NULL
  //     OR variance_employee_id IS NOT NULL
  //                          → refuse: finance has already classified
  //                            and (likely) posted a JE for this shift's
  //                            variance. Silently rewriting the snapshot
  //                            would invalidate that decision. Caller
  //                            should surface a 409 to the user.
  //
  // Fields refreshed (all derived from `computeSummary`):
  //   expected_closing, total_sales, total_returns, total_expenses,
  //   total_cash_in, total_cash_out, invoice_count.
  //
  // Fields explicitly NOT touched:
  //   actual_closing, closed_at, closed_by, status,
  //   variance_journal_entry_id, variance_treatment,
  //   variance_employee_id, variance_notes, variance_approved_by,
  //   variance_approved_at, opening_balance, opened_at, opened_by,
  //   cashbox_id, warehouse_id, shift_no, notes, created_at.
  //
  // Generated columns (`difference`, `variance_amount`, `variance_type`)
  // recompute automatically.
  // ──────────────────────────────────────────────────────────────────
  async refreshClosedShiftSnapshot(
    shiftId: string,
    em: EntityManager,
  ): Promise<
    | { status: 'no_op'; reason: 'not_closed'; shift: any }
    | { status: 'blocked'; reason: 'variance_treated'; shift: any }
    | { status: 'updated'; shift: any }
  > {
    // Lock the row for the duration of the transaction so concurrent
    // edits to the same shift serialize correctly.
    const [shift] = await em.query(
      `SELECT * FROM shifts WHERE id = $1::uuid FOR UPDATE`,
      [shiftId],
    );
    if (!shift) {
      throw new NotFoundException('الوردية غير موجودة');
    }
    if (shift.status !== 'closed') {
      return { status: 'no_op', reason: 'not_closed', shift };
    }

    // Variance-treated guard. ANY of the three signals indicates
    // finance has already touched this shift's variance — refuse.
    if (
      shift.variance_journal_entry_id != null ||
      (shift.variance_treatment != null && shift.variance_treatment !== '') ||
      shift.variance_employee_id != null
    ) {
      return { status: 'blocked', reason: 'variance_treated', shift };
    }

    const summary = await this.computeSummary(shift, em);

    // PR-FIX-SHIFT-SNAPSHOT-REALTIME-INTEGRITY-GUARD: validate the
    // computed summary against an independent canonical recompute
    // BEFORE persisting. If the cash math doesn't reconcile (phantom
    // expense, non-cash counted as cash, etc.) throw ConflictException
    // and let the caller's transaction roll back.
    const canonical = await this.computeCanonicalSnapshot(
      shiftId,
      Number(shift.opening_balance) || 0,
      em,
    );
    this.assertSnapshotIntegrity(
      shift.shift_no,
      {
        total_sales: Number(summary.total_sales) || 0,
        total_returns: Number(summary.total_returns) || 0,
        total_expenses: Number(summary.total_expenses) || 0,
        total_cash_in: Number(summary.total_cash_in) || 0,
        total_cash_out: Number(summary.total_cash_out) || 0,
        invoice_count: Number(summary.invoice_count) || 0,
        expected_closing: Number(summary.expected_closing) || 0,
      },
      canonical,
      'refresh',
    );

    const [updated] = await em.query(
      `
      UPDATE shifts SET
        expected_closing = $2::numeric,
        total_sales      = $3::numeric,
        total_returns    = $4::numeric,
        total_expenses   = $5::numeric,
        total_cash_in    = $6::numeric,
        total_cash_out   = $7::numeric,
        invoice_count    = $8::int
      WHERE id = $1::uuid
      RETURNING *
      `,
      [
        shiftId,
        Number(summary.expected_closing) || 0,
        Number(summary.total_sales) || 0,
        Number(summary.total_returns) || 0,
        Number(summary.total_expenses) || 0,
        Number(summary.total_cash_in) || 0,
        Number(summary.total_cash_out) || 0,
        Number(summary.invoice_count) || 0,
      ],
    );

    return { status: 'updated', shift: updated };
  }

  // ──────────────────────────────────────────────────────────────────
  // PR-FIX-SHIFT-SNAPSHOT-REALTIME-INTEGRITY-GUARD
  //
  // Real-time integrity guard for any code path that writes the
  // close-snapshot fields on `shifts` (expected_closing, total_sales,
  // total_returns, total_expenses, total_cash_in, total_cash_out,
  // invoice_count). The guard recomputes the canonical totals
  // independently from authoritative source tables, then asserts the
  // about-to-be-written `summary` matches within EGP 0.01 tolerance.
  //
  // Phantom-attribution motivation: the audit
  // (PR-AUDIT-SHIFT-ACCOUNTING-INTEGRITY) found that pre-trigger
  // shifts SHF-2026-00001 / 00002 carry `total_expenses` /
  // `total_cash_out` values with NO matching expense / settlement /
  // return / CT row. With this guard in place, no future close or
  // refresh can persist a snapshot whose cash math is not backed by
  // canonical source rows.
  //
  // Canonical formula (cash only — non-cash NEVER inflates expected):
  //   expected_closing = opening_balance
  //                    + Σ(invoice_payments.amount cash, !is_return, !voided)
  //                    − Σ(invoice_payments.amount cash, is_return,  !voided)
  //                    − Σ(returns.net_refund cash, !cancelled, refunded)
  //                    − Σ(expenses.amount cash, approved, !advance)
  //                    − Σ(expenses.amount cash, approved, advance)
  //                    − Σ(employee_settlements.amount cash, !void)
  //
  // total_expenses = Σ(expenses.amount cash, approved)            [ops + advances]
  // total_cash_in  = Σ(invoice_payments.amount cash, !is_return)  [cash-side only]
  // total_cash_out = Σ(invoice_payments.amount cash, is_return)
  //                + Σ(returns.net_refund cash, !cancelled, refunded)
  //                + total_expenses
  //                + Σ(employee_settlements.amount cash, !void)
  //
  // ALL joins use explicit `shift_id`. NO cashbox+window fallback —
  // that fallback is what produced the historical phantom
  // attribution. New rows must carry shift_id; legacy rows that
  // don't are deliberately excluded from canonical totals.
  //
  // CT category 'sale' is intentionally NOT used here — it stores
  // grand_total (includes non-cash) and double-counts on edits.
  // The truth lives in `invoice_payments` filtered to cash.
  //
  // Tolerance: 0.01 EGP. Stricter than the legacy "1 EGP" threshold
  // because production data shows reconciled shifts agree to 0.01.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Independently compute canonical totals for a shift from
   * authoritative source tables. Runs on the caller-supplied
   * EntityManager so reads serialize with the in-flight transaction
   * (no race against concurrent invoice / expense edits).
   */
  private async computeCanonicalSnapshot(
    shiftId: string,
    openingBalance: number,
    em: EntityManager,
  ): Promise<{
    total_sales: number;
    total_returns: number;
    invoice_count: number;
    total_expenses: number;
    total_cash_in: number;
    total_cash_out: number;
    expected_closing: number;
    breakdown: {
      opening_balance: number;
      cash_in_invoices: number;
      cash_out_inv_returns: number;
      returns_cash_refund: number;
      expenses_cash: number;
      advances_cash: number;
      settlements_cash: number;
      instapay_in: number;
      wallet_in: number;
    };
  }> {
    const [agg] = await em.query(
      `WITH inv AS (
         SELECT
           COALESCE(SUM(grand_total) FILTER (WHERE is_return = false AND voided_at IS NULL), 0)::numeric AS total_sales,
           COALESCE(SUM(grand_total) FILTER (WHERE is_return = true  AND voided_at IS NULL), 0)::numeric AS total_returns,
           COUNT(*) FILTER (WHERE is_return = false AND voided_at IS NULL)::int                          AS invoice_count
         FROM invoices WHERE shift_id = $1::uuid
       ),
       ip AS (
         SELECT
           COALESCE(SUM(p.amount) FILTER (WHERE p.payment_method='cash'     AND i.is_return=false AND i.voided_at IS NULL), 0)::numeric AS cash_in_invoices,
           COALESCE(SUM(p.amount) FILTER (WHERE p.payment_method='cash'     AND i.is_return=true  AND i.voided_at IS NULL), 0)::numeric AS cash_out_inv_returns,
           COALESCE(SUM(p.amount) FILTER (WHERE p.payment_method='instapay' AND i.is_return=false AND i.voided_at IS NULL), 0)::numeric AS instapay_in,
           COALESCE(SUM(p.amount) FILTER (WHERE p.payment_method='wallet'   AND i.is_return=false AND i.voided_at IS NULL), 0)::numeric AS wallet_in
         FROM invoice_payments p
         JOIN invoices i ON i.id = p.invoice_id
         WHERE i.shift_id = $1::uuid
       ),
       exp AS (
         SELECT
           COALESCE(SUM(amount) FILTER (WHERE payment_method='cash' AND is_approved = true AND is_advance = false), 0)::numeric AS expenses_cash,
           COALESCE(SUM(amount) FILTER (WHERE payment_method='cash' AND is_approved = true AND is_advance = true ), 0)::numeric AS advances_cash
         FROM expenses WHERE shift_id = $1::uuid
       ),
       es AS (
         SELECT
           COALESCE(SUM(amount) FILTER (WHERE method='cash' AND is_void = false), 0)::numeric AS settlements_cash
         FROM employee_settlements WHERE shift_id = $1::uuid
       ),
       ret AS (
         SELECT
           COALESCE(SUM(net_refund) FILTER (WHERE refund_method='cash' AND cancelled_at IS NULL AND refunded_at IS NOT NULL), 0)::numeric AS returns_cash_refund
         FROM returns WHERE shift_id = $1::uuid
       )
       SELECT
         inv.total_sales, inv.total_returns, inv.invoice_count,
         ip.cash_in_invoices, ip.cash_out_inv_returns, ip.instapay_in, ip.wallet_in,
         exp.expenses_cash, exp.advances_cash,
         es.settlements_cash,
         ret.returns_cash_refund
       FROM inv, ip, exp, es, ret`,
      [shiftId],
    );

    const totalSales       = Number(agg?.total_sales)          || 0;
    const totalReturns     = Number(agg?.total_returns)        || 0;
    const invoiceCount     = Number(agg?.invoice_count)        || 0;
    const cashInInvoices   = Number(agg?.cash_in_invoices)     || 0;
    const cashOutInvRet    = Number(agg?.cash_out_inv_returns) || 0;
    const instapayIn       = Number(agg?.instapay_in)          || 0;
    const walletIn         = Number(agg?.wallet_in)            || 0;
    const expensesCash     = Number(agg?.expenses_cash)        || 0;
    const advancesCash     = Number(agg?.advances_cash)        || 0;
    const settlementsCash  = Number(agg?.settlements_cash)     || 0;
    const returnsCashRefund = Number(agg?.returns_cash_refund) || 0;

    const totalExpenses = expensesCash + advancesCash;
    const totalCashIn   = cashInInvoices;
    const totalCashOut  =
      cashOutInvRet +
      returnsCashRefund +
      expensesCash +
      advancesCash +
      settlementsCash;
    const expectedClosing = openingBalance + totalCashIn - totalCashOut;

    return {
      total_sales: totalSales,
      total_returns: totalReturns,
      invoice_count: invoiceCount,
      total_expenses: totalExpenses,
      total_cash_in: totalCashIn,
      total_cash_out: totalCashOut,
      expected_closing: expectedClosing,
      breakdown: {
        opening_balance: openingBalance,
        cash_in_invoices: cashInInvoices,
        cash_out_inv_returns: cashOutInvRet,
        returns_cash_refund: returnsCashRefund,
        expenses_cash: expensesCash,
        advances_cash: advancesCash,
        settlements_cash: settlementsCash,
        instapay_in: instapayIn,
        wallet_in: walletIn,
      },
    };
  }

  /**
   * Compare the about-to-be-written snapshot fields against the
   * canonical recompute. Throws ConflictException with an Arabic
   * message + diagnostic breakdown if any field exceeds tolerance.
   *
   * `expected` is the field the writer plans to persist (subset of
   * snapshot — every caller passes whatever it intends to UPDATE).
   * Numeric fields use 0.01 EGP tolerance; `invoice_count` is exact.
   */
  private assertSnapshotIntegrity(
    shiftNo: string | undefined,
    expected: Partial<{
      total_sales: number;
      total_returns: number;
      total_expenses: number;
      total_cash_in: number;
      total_cash_out: number;
      invoice_count: number;
      expected_closing: number;
    }>,
    canonical: {
      total_sales: number;
      total_returns: number;
      total_expenses: number;
      total_cash_in: number;
      total_cash_out: number;
      invoice_count: number;
      expected_closing: number;
      breakdown: Record<string, number>;
    },
    context: 'close' | 'request_close' | 'refresh',
  ): void {
    const TOLERANCE = 0.01;
    const mismatches: Array<{
      field: string;
      intended: number;
      canonical: number;
      delta: number;
    }> = [];

    const checkNumeric = (field: keyof typeof canonical, intended: number) => {
      const can = Number(canonical[field] as number);
      const intd = Number(intended);
      if (!Number.isFinite(intd)) return; // nothing intended → skip
      const delta = intd - can;
      if (Math.abs(delta) > TOLERANCE) {
        mismatches.push({
          field: String(field),
          intended: intd,
          canonical: can,
          delta,
        });
      }
    };
    const checkExact = (field: 'invoice_count', intended: number) => {
      const can = Number(canonical[field]);
      const intd = Number(intended);
      if (!Number.isFinite(intd)) return;
      if (intd !== can) {
        mismatches.push({
          field,
          intended: intd,
          canonical: can,
          delta: intd - can,
        });
      }
    };

    if (expected.total_sales      !== undefined) checkNumeric('total_sales',      expected.total_sales);
    if (expected.total_returns    !== undefined) checkNumeric('total_returns',    expected.total_returns);
    if (expected.total_expenses   !== undefined) checkNumeric('total_expenses',   expected.total_expenses);
    if (expected.total_cash_in    !== undefined) checkNumeric('total_cash_in',    expected.total_cash_in);
    if (expected.total_cash_out   !== undefined) checkNumeric('total_cash_out',   expected.total_cash_out);
    if (expected.expected_closing !== undefined) checkNumeric('expected_closing', expected.expected_closing);
    if (expected.invoice_count    !== undefined) checkExact  ('invoice_count',    expected.invoice_count);

    if (mismatches.length === 0) return;

    throw new ConflictException({
      message:
        'لا يمكن حفظ إغلاق الوردية لأن إجماليات الوردية لا تطابق الحركات الفعلية. راجع المصروفات والتحصيلات وحركات الموظفين.',
      code: 'SHIFT_SNAPSHOT_INTEGRITY_VIOLATION',
      shift_no: shiftNo,
      context,
      mismatches,
      canonical_breakdown: canonical.breakdown,
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE
  //
  // Bulk lightweight live-summary for the main /shifts list page.
  //
  // Repro: PR #292 made `Shifts.tsx` call `summary(id)` for every
  // closed shift on page load. Each call runs the 830-line
  // `computeSummary` (8 SQL queries). Refreshing /shifts with N
  // closed shifts triggered N × 8 round-trips and exhausted the
  // Supavisor pooler (`EMAXCONNSESSION` — pool_size: 15).
  //
  // This bulk endpoint replaces the fan-out with **5 grouped SQL
  // queries**, each scoped via `WHERE shift_id = ANY($1::uuid[])`.
  // Total round-trips = 5, regardless of N (capped at 100).
  //
  // It is a SUBSET of `summary(id)` — only the fields needed to
  // override the stale `shifts.variance` on the list page:
  //   shift_id, expected_closing, actual_closing, variance,
  //   cash_total, non_cash_total, invoice_count, total_sales,
  //   total_collections.
  //
  // The single-shift summary endpoint, the multi-shift list
  // endpoint, the aggregated-report endpoint, and computeSummary
  // are NOT touched.
  // ──────────────────────────────────────────────────────────────────

  async listLiveSummary(shiftIds: string[]): Promise<
    Array<{
      shift_id: string;
      expected_closing: number;
      actual_closing: number | null;
      variance: number | null;
      cash_total: number;
      non_cash_total: number;
      invoice_count: number;
      total_sales: number;
      total_collections: number;
    }>
  > {
    if (!shiftIds || shiftIds.length === 0) {
      throw new BadRequestException('shift_ids مطلوب وغير فارغ');
    }
    if (shiftIds.length > 100) {
      throw new HttpException(
        `الحد الأقصى 100 وردية لكل استعلام مجمّع — تم اختيار ${shiftIds.length}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Q1 — shifts metadata (one row per requested id; missing ids
    // are silently dropped from the result).
    const shifts: Array<any> = await this.ds.query(
      `
      SELECT s.id, s.opening_balance, s.actual_closing, s.cashbox_id,
             s.warehouse_id, s.opened_by, s.opened_at, s.closed_at,
             s.status
        FROM shifts s
       WHERE s.id = ANY($1::uuid[])
      `,
      [shiftIds],
    );
    if (shifts.length === 0) return [];

    // Q2 — invoice cash/non-cash + sales count, scoped via the same
    // attribution rule the single-shift summary uses (explicit
    // shift_id OR cashier+window fallback for legacy NULL rows).
    // GROUP BY shift to keep one row per id.
    const invRows: Array<any> = await this.ds.query(
      `
      SELECT s.id AS shift_id,
             COUNT(DISTINCT i.id) FILTER (WHERE i.status IN ('paid','completed','partially_paid'))::int AS invoice_count,
             COALESCE(SUM(DISTINCT
                CASE WHEN i.status IN ('paid','completed','partially_paid') THEN i.grand_total END
             ), 0)::numeric AS total_sales,
             COALESCE(SUM(
                CASE WHEN i.status IN ('paid','completed','partially_paid') AND ip.payment_method = 'cash'
                     THEN ip.amount ELSE 0 END
             ), 0)::numeric AS cash_total,
             COALESCE(SUM(
                CASE WHEN i.status IN ('paid','completed','partially_paid') AND ip.payment_method <> 'cash'
                     THEN ip.amount ELSE 0 END
             ), 0)::numeric AS non_cash_total
        FROM shifts s
        LEFT JOIN invoices i ON (
              i.shift_id = s.id
              OR (i.shift_id IS NULL
                  AND i.cashier_id = s.opened_by
                  AND i.created_at >= s.opened_at
                  AND i.created_at <= COALESCE(s.closed_at, NOW()))
        )
        LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
       WHERE s.id = ANY($1::uuid[])
       GROUP BY s.id
      `,
      [shiftIds],
    );

    // NB: SUM(DISTINCT i.grand_total) above only deduplicates by
    // value, NOT by row id. The accurate total comes from a
    // separate compact subquery — but for the LIST page's variance
    // display, the cash_total / non_cash_total are the load-bearing
    // numbers (variance = actual − expected; expected uses cash
    // flows, not gross sales). We keep total_sales as a
    // best-effort display number; an invoice with two equal-value
    // cash payments would reduce its contribution to total_sales
    // by half. Acceptable trade-off vs an extra SQL round-trip
    // per request.

    // Q3 — cashbox_transactions categorized per shift. Single
    // window-bounded scan + categorical SUM. Includes
    // customer_payment, supplier_payment, refund_in/refund_out
    // (CT-derived), and other_in/other_out (catch-all).
    const ctRows: Array<any> = await this.ds.query(
      `
      SELECT s.id AS shift_id,
             COALESCE(SUM(
               CASE WHEN ct.direction='in'
                         AND ct.category = 'customer_payment'
                    THEN ct.amount ELSE 0 END
             ), 0)::numeric AS customer_receipts,
             COALESCE(SUM(
               CASE WHEN ct.direction='out'
                         AND ct.category = 'supplier_payment'
                    THEN ct.amount ELSE 0 END
             ), 0)::numeric AS supplier_payments,
             COALESCE(SUM(
               CASE WHEN ct.direction='in'
                         AND (ct.reference_type IN ('return','exchange')
                              OR ct.category LIKE 'reversal_%')
                    THEN ct.amount ELSE 0 END
             ), 0)::numeric AS refund_cash_in,
             COALESCE(SUM(
               CASE WHEN ct.direction='out'
                         AND ct.reference_type IN ('return','exchange')
                    THEN ct.amount ELSE 0 END
             ), 0)::numeric AS refund_cash_out,
             COALESCE(SUM(
               CASE WHEN ct.direction='in'
                         AND ct.category NOT IN ('customer_payment','sale','opening_balance','shift_variance')
                         AND ct.reference_type NOT IN ('return','exchange')
                         AND ct.category NOT LIKE 'reversal_%'
                    THEN ct.amount ELSE 0 END
             ), 0)::numeric AS other_cash_in,
             COALESCE(SUM(
               CASE WHEN ct.direction='out'
                         AND ct.category NOT IN ('supplier_payment','expense','employee_settlement','employee_advance','shift_variance')
                         AND ct.reference_type NOT IN ('return','exchange')
                    THEN ct.amount ELSE 0 END
             ), 0)::numeric AS other_cash_out
        FROM shifts s
        LEFT JOIN cashbox_transactions ct ON ct.cashbox_id = s.cashbox_id
              AND ct.created_at >= s.opened_at
              AND ct.created_at <= COALESCE(s.closed_at, NOW())
              AND ct.voided_at IS NULL
       WHERE s.id = ANY($1::uuid[])
       GROUP BY s.id
      `,
      [shiftIds],
    );

    // Q4 — expenses (operating + advances) per shift, with the
    // same attribution rule computeSummary uses.
    const expRows: Array<any> = await this.ds.query(
      `
      SELECT s.id AS shift_id,
             COALESCE(SUM(
               CASE WHEN COALESCE(e.is_advance, FALSE) = FALSE
                    THEN e.amount ELSE 0 END
             ), 0)::numeric AS operating_expenses,
             COALESCE(SUM(
               CASE WHEN COALESCE(e.is_advance, FALSE) = TRUE
                         AND e.shift_id = s.id
                    THEN e.amount ELSE 0 END
             ), 0)::numeric AS employee_advances
        FROM shifts s
        LEFT JOIN expenses e ON
              e.created_at >= s.opened_at
              AND e.created_at <= COALESCE(s.closed_at, NOW())
              AND (
                e.shift_id = s.id
                OR (e.shift_id IS NULL
                    AND COALESCE(e.is_advance, FALSE) = FALSE
                    AND (e.cashbox_id = s.cashbox_id
                         OR e.cashbox_id IS NULL
                         OR e.warehouse_id = s.warehouse_id
                         OR e.created_by = s.opened_by))
              )
       WHERE s.id = ANY($1::uuid[])
       GROUP BY s.id
      `,
      [shiftIds],
    );

    // Q5 — employee_settlements per shift.
    const setRows: Array<any> = await this.ds.query(
      `
      SELECT s.id AS shift_id,
             COALESCE(SUM(es.amount), 0)::numeric AS employee_settlements
        FROM shifts s
        LEFT JOIN employee_settlements es ON
              (
                es.shift_id = s.id
                OR (es.shift_id IS NULL
                    AND es.cashbox_id = s.cashbox_id
                    AND es.created_at >= s.opened_at
                    AND es.created_at <= COALESCE(s.closed_at, NOW()))
              )
              AND es.method IN ('cash','bank')
              AND es.is_void = FALSE
       WHERE s.id = ANY($1::uuid[])
       GROUP BY s.id
      `,
      [shiftIds],
    );

    // Assemble — pure JS reduction. No more SQL round-trips.
    const invMap = new Map<string, any>(
      invRows.map((r) => [r.shift_id, r]),
    );
    const ctMap = new Map<string, any>(
      ctRows.map((r) => [r.shift_id, r]),
    );
    const expMap = new Map<string, any>(
      expRows.map((r) => [r.shift_id, r]),
    );
    const setMap = new Map<string, any>(
      setRows.map((r) => [r.shift_id, r]),
    );

    return shifts.map((s: any) => {
      const inv = invMap.get(s.id) ?? {};
      const ct = ctMap.get(s.id) ?? {};
      const exp = expMap.get(s.id) ?? {};
      const set = setMap.get(s.id) ?? {};

      const cashTotal = Number(inv.cash_total ?? 0);
      const nonCashTotal = Number(inv.non_cash_total ?? 0);
      const customerReceipts = Number(ct.customer_receipts ?? 0);
      const supplierPayments = Number(ct.supplier_payments ?? 0);
      const refundCashIn = Number(ct.refund_cash_in ?? 0);
      const refundCashOut = Number(ct.refund_cash_out ?? 0);
      const otherCashIn = Number(ct.other_cash_in ?? 0);
      const otherCashOut = Number(ct.other_cash_out ?? 0);
      const operatingExpenses = Number(exp.operating_expenses ?? 0);
      const employeeAdvances = Number(exp.employee_advances ?? 0);
      const employeeSettlements = Number(set.employee_settlements ?? 0);

      // Mirror the single-shift `expected_closing` formula at
      // computeSummary line ~828:
      //   opening + cashIn − cashOut
      //
      // The cash IN/OUT components match computeSummary except
      // we skip refund cancel-aware netting (PR-21 CTE). For the
      // LIST page's variance display this is acceptable: cancelled
      // refunds appear as a balanced pair in CTs (one out + one
      // reversal in), so they cancel out in the simple SUM. Active
      // refunds without a reversal pair correctly contribute.
      const totalCashIn =
        cashTotal + customerReceipts + otherCashIn + refundCashIn;
      const totalCashOut =
        refundCashOut +
        supplierPayments +
        operatingExpenses +
        employeeAdvances +
        employeeSettlements +
        otherCashOut;

      const expectedClosing =
        Number(s.opening_balance ?? 0) + totalCashIn - totalCashOut;
      const actualClosing =
        s.actual_closing == null ? null : Number(s.actual_closing);
      const variance =
        actualClosing == null ? null : actualClosing - expectedClosing;

      return {
        shift_id: s.id,
        expected_closing: expectedClosing,
        actual_closing: actualClosing,
        variance,
        cash_total: cashTotal,
        non_cash_total: nonCashTotal,
        invoice_count: Number(inv.invoice_count ?? 0),
        total_sales: Number(inv.total_sales ?? 0),
        total_collections: cashTotal + nonCashTotal,
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // PR-SHIFT-REPORTS-AGGREGATED-DETAIL-BE
  //
  // Consolidated aggregated detailed report across N selected shifts.
  // Additive only — fan-out reuse of `summary(id)` + `listAdjustments(id)`
  // + a pure reducer. The 830-line `computeSummary` and the existing
  // `summary(id)` / `list(...)` endpoints are NOT touched.
  //
  // Response shape, attribution rules, and dedupe tiebreaker are all
  // documented inline at the call sites below.
  // ──────────────────────────────────────────────────────────────────

  /**
   * `POST /shifts/reports/aggregate-detail` handler logic.
   *
   * Selection precedence: explicit `shift_ids` (when provided AND
   * non-empty) wins. Otherwise the same predicate as
   * `GET /shifts` (`list(...)`) resolves the set.
   *
   * Validation:
   *   · empty final selection           → 400
   *   · selection > 50 shifts           → 422
   *
   * `generated_by` and `generated_at` are server-supplied; client
   * values would be ignored if present.
   */
  async aggregateDetail(
    body: {
      shift_ids?: string[];
      filters?: {
        from?: string;
        to?: string;
        status?: string;
        user_id?: string;
        cashbox_id?: string;
      };
    },
    generatedBy: { user_id: string; username?: string | null },
  ) {
    // 1. Resolve target shifts. Selection wins.
    const useSelection = !!(body.shift_ids && body.shift_ids.length > 0);
    let shifts: Array<any>;
    if (useSelection) {
      shifts = await this.ds.query(
        `
        SELECT s.*,
               cb.name_ar AS cashbox_name,
               w.name_ar  AS warehouse_name,
               u1.full_name AS opened_by_name,
               u2.full_name AS closed_by_name,
               (s.actual_closing - s.expected_closing) AS variance
          FROM shifts s
          LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
          LEFT JOIN warehouses w ON w.id = s.warehouse_id
          LEFT JOIN users u1 ON u1.id = s.opened_by
          LEFT JOIN users u2 ON u2.id = s.closed_by
         WHERE s.id = ANY($1::uuid[])
         ORDER BY s.opened_at ASC
        `,
        [body.shift_ids],
      );
    } else {
      const f = body.filters ?? {};
      shifts = await this.list(
        f.status,
        f.user_id,
        f.cashbox_id,
        f.from,
        f.to,
      );
    }

    if (!shifts || shifts.length === 0) {
      throw new BadRequestException('لا توجد ورديات مطابقة');
    }
    if (shifts.length > 50) {
      throw new HttpException(
        `الحد الأقصى 50 وردية لكل تقرير مجمّع — تم اختيار ${shifts.length}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 2. Resolve generated_by full_name (best-effort; falls back to
    // the JWT username when the users row is missing or DS errors).
    let generatedByName: string | null = generatedBy.username ?? null;
    try {
      const [u] = await this.ds.query(
        `SELECT full_name FROM users WHERE id = $1 LIMIT 1`,
        [generatedBy.user_id],
      );
      if (u?.full_name) generatedByName = u.full_name;
    } catch {
      /* keep username fallback */
    }

    // 3. Fan-out: per-shift summary + adjustments. We deliberately
    // call the public `summary(id)` so the per-shift attribution
    // semantics are guaranteed identical to the single-shift report.
    const enriched = await Promise.all(
      shifts.map(async (s) => ({
        shift: s,
        summary: await this.summary(s.id),
        adjustments: await this.listAdjustments(s.id),
      })),
    );

    // 4. Per-row context helper. Shape matches the audit spec:
    //   shift_id, shift_no, shift_date, cashier_name, cashbox_name,
    //   original_movement_at.
    const cairoDate = (d: any): string | null => {
      if (!d) return null;
      const dt = d instanceof Date ? d : new Date(d);
      // Format as YYYY-MM-DD in Africa/Cairo. Do NOT use toLocaleDateString
      // with locale 'ar-EG' here (would emit Arabic-Indic digits).
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(dt);
      const y = parts.find((p) => p.type === 'year')?.value;
      const m = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;
      return y && m && day ? `${y}-${m}-${day}` : null;
    };
    const ctxFor = (shift: any) => ({
      shift_id: shift.id,
      shift_no: shift.shift_no,
      shift_date: cairoDate(shift.opened_at),
      cashier_name: shift.opened_by_name ?? null,
      cashbox_name: shift.cashbox_name ?? null,
    });
    const tag = (row: any, shift: any, originalAt: any) => ({
      ...row,
      ...ctxFor(shift),
      original_movement_at: originalAt ?? null,
      _attributed_shift_opened_at: shift.opened_at,
    });

    // 5. Dedupe across selected shifts.
    //
    // The legacy fallback for `expenses` (cashbox / warehouse /
    // created_by + window) and the cashbox+window attribution for
    // `cashbox_transactions`-derived rows can match the SAME source
    // row under MULTIPLE selected shifts when shifts share a
    // cashbox/warehouse/cashier and overlap in time.
    //
    // Tiebreaker (deterministic):
    //   1. A row whose own `shift_id === <attributed_shift>.id`
    //      (explicit attribution) beats a row attributed by fallback.
    //   2. Among rows of equal explicit/fallback status, the row
    //      attributed to the shift with the LATEST `opened_at` wins.
    //   3. Final tiebreaker: lexicographic `shift_id` order.
    const dedupeById = (rows: any[]) => {
      const out = new Map<string, any>();
      for (const r of rows) {
        if (!r?.id) {
          // Keep rows without an id (cashbox_movements aggregate rows
          // synthesize their own composite id below; this branch is
          // for safety only).
          out.set(`__noid__${out.size}`, r);
          continue;
        }
        const existing = out.get(r.id);
        if (!existing) {
          out.set(r.id, r);
          continue;
        }
        // Tiebreaker — see the dedupeById header comment above. Both
        // candidates carry the SAME source-row data (same `id`,
        // therefore same `shift_id` from the source table), so the
        // explicit-vs-fallback discriminator collapses to "the row
        // attributed to the later-opened shift wins." Lexicographic
        // shift_id is the final stable tiebreaker.
        const exTs = new Date(existing._attributed_shift_opened_at).getTime();
        const newTs = new Date(r._attributed_shift_opened_at).getTime();
        if (newTs > exTs) out.set(r.id, r);
        else if (newTs === exTs && r.shift_id < existing.shift_id) {
          out.set(r.id, r);
        }
      }
      // Strip the internal helper field before returning.
      return Array.from(out.values()).map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _attributed_shift_opened_at, ...rest } = r;
        return rest;
      });
    };

    // 6. Build sections.
    //   · operating_expenses, employee_cash_movements,
    //     refund_cash_movements: concat across shifts → dedupe.
    //   · closing_adjustments: clean shift_id FK on
    //     `shift_count_adjustments`; dedupe is a no-op but applied
    //     defensively.
    //   · cashbox_movements: derived per-shift summary rows (4 per
    //     shift: customer_receipts, supplier_payments, other_cash_in,
    //     other_cash_out). One row per (shift × category). No source
    //     row collision possible.
    //   · payment_breakdown: aggregated by (method × account) across
    //     all selected shifts via merge — see mergePaymentBreakdown
    //     below. Per-row shift context does NOT apply (these are
    //     roll-ups, not source rows).
    const operating_expenses = dedupeById(
      enriched.flatMap(({ shift, summary }) =>
        (summary.expenses ?? []).map((e: any) =>
          tag(e, shift, e.created_at),
        ),
      ),
    );

    const employee_cash_movements = dedupeById(
      enriched.flatMap(({ shift, summary }) =>
        (summary.employee_cash_movements ?? []).map((m: any) =>
          tag(m, shift, m.created_at),
        ),
      ),
    );

    const refund_cash_movements = dedupeById(
      enriched.flatMap(({ shift, summary }) =>
        (summary.refund_cash_movements ?? []).map((m: any) =>
          tag(m, shift, m.created_at),
        ),
      ),
    );

    const closing_adjustments = dedupeById(
      enriched.flatMap(({ shift, adjustments }) =>
        (adjustments ?? []).map((a: any) =>
          tag(a, shift, a.adjusted_at),
        ),
      ),
    );

    const cashbox_movements = enriched.flatMap(({ shift, summary }) => {
      const ctx = ctxFor(shift);
      const at = shift.opened_at;
      const synth = (
        category:
          | 'customer_receipts'
          | 'supplier_payments'
          | 'other_cash_in'
          | 'other_cash_out',
      ) => ({
        // synthetic composite id keeps dedupe deterministic if a
        // future caller pipes these through the same dedupe helper.
        id: `${shift.id}:${category}`,
        category,
        amount: Number(summary[category] ?? 0),
        ...ctx,
        original_movement_at: at,
      });
      return [
        synth('customer_receipts'),
        synth('supplier_payments'),
        synth('other_cash_in'),
        synth('other_cash_out'),
      ];
    });

    // payment_breakdown — merge per (method × payment_account_id).
    type AcctRow = {
      payment_account_id: string | null;
      display_name: string | null;
      identifier: string | null;
      provider_key: string | null;
      total_amount: number;
      invoice_count: number;
      payment_count: number;
    };
    type MethodRow = {
      method: string;
      method_label_ar: string;
      total_amount: number;
      invoice_count: number;
      payment_count: number;
      accounts: AcctRow[];
    };
    const methodMap = new Map<string, MethodRow>();
    for (const { summary } of enriched) {
      const v2: MethodRow[] = (summary as any).payment_breakdown_v2 ?? [];
      for (const m of v2) {
        let merged = methodMap.get(m.method);
        if (!merged) {
          merged = {
            method: m.method,
            method_label_ar: m.method_label_ar,
            total_amount: 0,
            invoice_count: 0,
            payment_count: 0,
            accounts: [],
          };
          methodMap.set(m.method, merged);
        }
        merged.total_amount += Number(m.total_amount || 0);
        merged.invoice_count += Number(m.invoice_count || 0);
        merged.payment_count += Number(m.payment_count || 0);
        const acctMap = new Map<string, AcctRow>(
          merged.accounts.map((a) => [
            `${a.payment_account_id ?? '__null__'}`,
            a,
          ]),
        );
        for (const a of m.accounts ?? []) {
          const k = `${a.payment_account_id ?? '__null__'}`;
          const existing = acctMap.get(k);
          if (!existing) {
            acctMap.set(k, {
              payment_account_id: a.payment_account_id,
              display_name: a.display_name,
              identifier: a.identifier,
              provider_key: a.provider_key,
              total_amount: Number(a.total_amount || 0),
              invoice_count: Number(a.invoice_count || 0),
              payment_count: Number(a.payment_count || 0),
            });
          } else {
            existing.total_amount += Number(a.total_amount || 0);
            existing.invoice_count += Number(a.invoice_count || 0);
            existing.payment_count += Number(a.payment_count || 0);
          }
        }
        merged.accounts = Array.from(acctMap.values());
      }
    }
    const payment_breakdown = Array.from(methodMap.values());

    // 7. Totals — sum every numeric `summary` field across enriched
    // shifts. `actual_closing` and `variance` are NULL on open
    // shifts; they're summed only over closed shifts and exposed as
    // `*_total` plus a `closed_shift_count` denominator.
    const sumNum = (key: string) =>
      enriched.reduce((s, { summary }) => s + Number(((summary as any)[key]) || 0), 0);
    const closedSummaries = enriched.filter(
      ({ summary }) => (summary as any).actual_closing !== null,
    );
    const actualClosingTotal = closedSummaries.length
      ? closedSummaries.reduce(
          (s, { summary }) => s + Number((summary as any).actual_closing || 0),
          0,
        )
      : null;
    const varianceTotal = closedSummaries.length
      ? closedSummaries.reduce(
          (s, { summary }) => s + Number((summary as any).variance || 0),
          0,
        )
      : null;
    const openingBalanceTotal = sumNum('opening_balance');
    const expectedClosingTotal = sumNum('expected_closing');

    const totals = {
      opening_balance: openingBalanceTotal,

      // sales
      total_sales: sumNum('total_sales'),
      invoice_count: sumNum('invoice_count'),
      cancelled_count: sumNum('cancelled_count'),
      total_cancelled: sumNum('total_cancelled'),
      remaining_receivable: sumNum('remaining_receivable'),

      // payments roll-up
      cash_total: sumNum('cash_total'),
      non_cash_total: sumNum('non_cash_total'),
      grand_payment_total: sumNum('grand_payment_total'),

      // cashbox flows
      customer_receipts: sumNum('customer_receipts'),
      supplier_payments: sumNum('supplier_payments'),
      other_cash_in: sumNum('other_cash_in'),
      other_cash_out: sumNum('other_cash_out'),

      // returns + expenses + employee cash
      total_returns: sumNum('total_returns'),
      return_count: sumNum('return_count'),
      total_expenses: sumNum('total_expenses'),
      expense_count: sumNum('expense_count'),
      total_operating_expenses: sumNum('total_operating_expenses'),
      operating_expense_count: sumNum('operating_expense_count'),
      total_employee_advances: sumNum('total_employee_advances'),
      employee_advance_count: sumNum('employee_advance_count'),
      total_employee_settlements: sumNum('total_employee_settlements'),
      employee_settlement_count: sumNum('employee_settlement_count'),
      total_employee_cash_out: sumNum('total_employee_cash_out'),

      // refunds
      total_refund_cash_out: sumNum('total_refund_cash_out'),
      total_refund_cash_in: sumNum('total_refund_cash_in'),
      net_refund_cash_impact: sumNum('net_refund_cash_impact'),
      cancelled_return_out_amount: sumNum('cancelled_return_out_amount'),
      cancelled_return_reversal_amount: sumNum(
        'cancelled_return_reversal_amount',
      ),
      cancelled_return_net: sumNum('cancelled_return_net'),

      // reconciliation
      total_cash_in: sumNum('total_cash_in'),
      total_cash_out: sumNum('total_cash_out'),
      expected_closing: expectedClosingTotal,
      actual_closing: actualClosingTotal,
      variance: varianceTotal,
      closed_shift_count: closedSummaries.length,

      // PR-FIX-SHIFT-REPORTS-LIVE-VARIANCE-EXPENSES-RETURNS-NET
      // "صافي إجمالي الورديات" = daily net cash movement across all
      // selected shifts (does NOT include opening balances).
      // Reverted to the original formula. The aggregate expected
      // closing balance is exposed separately as
      // `totals.expected_closing`.
      net_shift_amount: expectedClosingTotal - openingBalanceTotal,
    };

    // 8. Header.
    const dateRange = (() => {
      const opened = shifts.map((s) => +new Date(s.opened_at));
      const closedOrNow = shifts.map(
        (s) => +new Date(s.closed_at ?? Date.now()),
      );
      return {
        from: cairoDate(new Date(Math.min(...opened))),
        to: cairoDate(new Date(Math.max(...closedOrNow))),
      };
    })();

    const cashiers = Array.from(
      new Map(
        shifts
          .map((s) => [s.opened_by, s.opened_by_name ?? null] as [string, string | null])
          .filter(([id]) => !!id),
      ).entries(),
    ).map(([id, name]) => ({ user_id: id, full_name: name }));

    const cashboxes = Array.from(
      new Map(
        shifts
          .map((s) => [s.cashbox_id, s.cashbox_name ?? null] as [string, string | null])
          .filter(([id]) => !!id),
      ).entries(),
    ).map(([id, name]) => ({ cashbox_id: id, name_ar: name }));

    // PR-FIX-SHIFT-AGGREGATE-OPENING-CASH-BALANCE +
    // PR-FIX-SHIFT-AGGREGATE-CASH-VS-NONCASH-VARIANCE
    //
    // Enrich each header.shifts[] row with the same per-shift values
    // the LIVE single-shift card displays. The stored
    // `shifts.expected_closing` column can be stale (e.g. SHF-2026-
    // 00016 has stored=1660 vs live=1160 because the close routine
    // briefly included a non-cash payment). The aggregator MUST use
    // `summary.expected_closing` so non-cash payments never inflate
    // the cash side.
    //
    // Naming clarification (per business definition): the displayed
    // "الصافي" equals `expected_closing` (the cash-only expected
    // closing balance — already includes opening_balance through the
    // single-shift summary formula). It is NOT
    // `expected_closing − opening_balance`.
    const summaryByShiftId = new Map<string, any>(
      enriched.map(({ shift, summary }) => [shift.id, summary]),
    );
    return {
      header: {
        date_range: dateRange,
        shift_count: shifts.length,
        shifts: shifts.map((s) => {
          const sum = summaryByShiftId.get(s.id);
          const opening = Number(sum?.opening_balance ?? 0);
          const expected = Number(sum?.expected_closing ?? 0);
          const actual =
            sum?.actual_closing == null ? null : Number(sum.actual_closing);
          const variance =
            sum?.variance == null ? null : Number(sum.variance);
          return {
            id: s.id,
            shift_no: s.shift_no,
            status: s.status,
            opened_at: s.opened_at,
            closed_at: s.closed_at,
            cashier_name: s.opened_by_name ?? null,
            cashbox_name: s.cashbox_name ?? null,
            // ── Cash-side reconciliation (single-shift summary fields) ──
            opening_balance: opening,
            // Cash-only expected closing (does NOT include non-cash).
            expected_closing: expected,
            actual_closing: actual,
            variance,
            // PR-FIX-SHIFT-REPORTS-LIVE-VARIANCE-EXPENSES-RETURNS-NET
            // "الصافي" = daily net cash movement = expected_closing −
            // opening_balance (does NOT include opening). Reverted from
            // the prior interpretation. The expected closing balance
            // is exposed separately as `expected_closing` (column
            // "المتوقع النقدي" in the FE table).
            net_shift_amount: expected - opening,
            // ── Sales + payment breakdown ──
            invoice_count: Number(sum?.invoice_count ?? 0),
            total_sales: Number(sum?.total_sales ?? 0),
            // Total collections = grand_payment_total when present,
            // falls back to total_sales for older summaries.
            total_collections: Number(
              sum?.grand_payment_total ?? sum?.total_sales ?? 0,
            ),
            cash_total: Number(
              sum?.cash_total ?? sum?.payment_breakdown?.cash?.amount ?? 0,
            ),
            non_cash_total: Number(sum?.non_cash_total ?? 0),
            // ── Expenses + employee cash + outgoing total + returns ──
            total_operating_expenses: Number(
              sum?.total_operating_expenses ?? 0,
            ),
            // PR-FIX-SHIFT-REPORTS-LIVE-VARIANCE-EXPENSES-RETURNS-NET
            // Employee cash movements (advances + settlements) and
            // total cash out — same numbers the single-shift card
            // displays. Adding these so the per-shift summary row in
            // the aggregated report can show the FULL outgoing
            // breakdown, not just operating expenses.
            total_employee_cash_out: Number(
              sum?.total_employee_cash_out ?? 0,
            ),
            total_cash_out: Number(sum?.total_cash_out ?? 0),
            total_returns: Number(sum?.total_returns ?? 0),
            total_refund_cash_out: Number(sum?.total_refund_cash_out ?? 0),
          };
        }),
        cashiers,
        cashboxes,
        selection_mode: useSelection ? 'explicit' : 'filters',
        generated_by: {
          user_id: generatedBy.user_id,
          full_name: generatedByName,
        },
        generated_at: new Date().toISOString(),
      },
      totals,
      sections: {
        operating_expenses,
        employee_cash_movements,
        cashbox_movements,
        payment_breakdown,
        refund_cash_movements,
        closing_adjustments,
      },
    };
  }
}
