import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ApproveCloseDto,
  CloseShiftDto,
  OpenShiftDto,
  VarianceTreatment,
} from './dto/shift.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

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

  private async computeSummary(shift: any) {
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

    const [inv] = await this.ds.query(
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
    const payRows = await this.ds.query(
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
    const [ret] = await this.ds.query(
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
    const txRows = await this.ds.query(
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

    // Expenses posted during the shift window. Match generously: same
    // cashbox OR same warehouse OR created by the shift opener — cashiers
    // often leave cashbox_id blank when adding expenses from the UI.
    //
    // PR-14: also classify each row as `is_employee_advance` so the UI can
    // separate operating expenses from advances. Heuristic:
    //   * `expenses.is_advance = TRUE`     — engine routes DR to 1123, OR
    //   * category maps to COA code 1123  — semantic advance (admin
    //                                       mapped a "سلف الموظفين" category
    //                                       to Employee Receivables)
    const expenseRows = await this.ds.query(
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
               OR coa.code = '1123' AS is_employee_advance,
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
           e.cashbox_id = $3
           OR (e.cashbox_id IS NULL)
           OR e.warehouse_id = $4
           OR e.created_by = $5
         )
       ORDER BY e.expense_date DESC, e.created_at DESC
      `,
      [
        shift.opened_at,
        upperBound,
        shift.cashbox_id,
        shift.warehouse_id,
        shift.opened_by,
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
    const settlementRows = await this.ds.query(
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
    const refundCtRows = await this.ds.query(
      `
      WITH ct_in_window AS (
        SELECT ct.id, ct.amount, ct.direction, ct.reference_type, ct.reference_id,
               ct.created_at, ct.user_id, ct.notes, ct.cashbox_id
          FROM cashbox_transactions ct
         WHERE ct.cashbox_id = $1
           AND ct.created_at >= $2
           AND ct.created_at <= $3
           AND ct.reference_type::text IN ('return','exchange')
      ),
      ct_with_source AS (
        SELECT ct.*,
               CASE ct.reference_type::text
                 WHEN 'return'   THEN r.shift_id
                 WHEN 'exchange' THEN e.shift_id
               END AS src_shift_id,
               CASE ct.reference_type::text
                 WHEN 'return'   THEN r.cashbox_id
                 WHEN 'exchange' THEN e.cashbox_id
               END AS src_cashbox_id
          FROM ct_in_window ct
          LEFT JOIN returns   r ON ct.reference_type::text = 'return'
                                AND r.id = ct.reference_id
          LEFT JOIN exchanges e ON ct.reference_type::text = 'exchange'
                                AND e.id = ct.reference_id
      ),
      eligible AS (
        SELECT ct.*,
               CASE
                 WHEN ct.src_shift_id = $4              THEN 'explicit'
                 WHEN ct.src_shift_id IS NULL
                  AND ct.src_cashbox_id IS NULL         THEN 'derived'
                 ELSE NULL  -- another shift's row, or a direct-cashbox row
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
             cb.name_ar AS cashbox_name,
             r.return_no AS return_no,
             r.refund_method::text AS refund_method,
             e.exchange_no AS exchange_no,
             COALESCE(cust_r.full_name, cust_e.full_name) AS customer_name,
             je.entry_no AS je_entry_no,
             ct.link_method AS link_method,
             $5::text AS shift_no
        FROM eligible ct
        LEFT JOIN cashboxes cb         ON cb.id = ct.cashbox_id
        LEFT JOIN users u              ON u.id  = ct.user_id
        LEFT JOIN returns r            ON ct.reference_type::text = 'return'
                                       AND r.id = ct.reference_id
        LEFT JOIN exchanges e          ON ct.reference_type::text = 'exchange'
                                       AND e.id = ct.reference_id
        LEFT JOIN customers cust_r     ON cust_r.id = r.customer_id
        LEFT JOIN customers cust_e     ON cust_e.id = e.customer_id
        LEFT JOIN journal_entries je   ON je.reference_type::text IN ('return','exchange')
                                       AND je.reference_id = ct.reference_id
                                       AND je.is_void = FALSE
       WHERE ct.link_method IS NOT NULL
       ORDER BY ct.created_at DESC
      `,
      [shift.cashbox_id, shift.opened_at, upperBound, shift.id, shift.shift_no],
    );

    const refund_cash_movements: any[] = refundCtRows.map((c: any) => {
      const amt = Number(c.amount);
      const isReturn = c.reference_type === 'return';
      return {
        id: c.ct_id,
        kind: c.reference_type, // 'return' | 'exchange'
        type_label: isReturn ? 'مرتجع نقدي' : 'فرق استبدال',
        direction: c.direction,
        direction_label: c.direction === 'out' ? 'خارج' : 'داخل',
        amount: amt,
        reference_no: isReturn
          ? c.return_no || null
          : c.exchange_no || null,
        customer_name: c.customer_name || null,
        cashbox_name: c.cashbox_name || null,
        shift_no: c.shift_no || null, // PR-R1 — populated for the
                                      // closing shift (always THIS one
                                      // since direct-cashbox + cross-shift
                                      // rows are excluded in the WHERE)
        created_at: c.created_at,
        created_by_name: c.created_by_name || null,
        je_entry_no: c.je_entry_no || null,
        accounting_impact:
          c.direction === 'out'
            ? `DR مردودات مبيعات / CR ${c.cashbox_name ?? 'cashbox'}`
            : `DR ${c.cashbox_name ?? 'cashbox'} / CR إيرادات`,
        link_method: c.link_method as 'explicit' | 'derived',
      };
    });

    const totalRefundCashOut = refund_cash_movements
      .filter((m) => m.direction === 'out')
      .reduce((s, m) => s + m.amount, 0);
    const totalRefundCashIn = refund_cash_movements
      .filter((m) => m.direction === 'in')
      .reduce((s, m) => s + m.amount, 0);
    const netRefundCashImpact = totalRefundCashOut - totalRefundCashIn;

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
      total_refund_cash_out: totalRefundCashOut,
      total_refund_cash_in: totalRefundCashIn,
      net_refund_cash_impact: netRefundCashImpact,
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
    const [row] = await this.ds.query(
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

  list(status?: string, userId?: string) {
    const conds: string[] = [];
    const params: any[] = [];
    if (status) {
      params.push(status);
      conds.push(`s.status = $${params.length}`);
    }
    if (userId) {
      params.push(userId);
      conds.push(`s.opened_by = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
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
      LIMIT 200
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
}
