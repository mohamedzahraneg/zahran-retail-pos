/**
 * finance-dashboard.service.ts — PR-FIN-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Composes the Financial Dashboard response. STRICTLY read-only —
 * every method is a `SELECT`. No INSERT/UPDATE/DELETE on any
 * financial table. No FinancialEngine calls. No mutation of any
 * existing accounting state.
 *
 * Design notes:
 *   · Profit comes from `invoices.cogs_total` + `invoices.gross_profit`
 *     (pre-computed at sale time → High confidence). When those are
 *     NULL we fall back to `invoice_lines.cost_total` (still High),
 *     then to product `base_cost`/`cost_price` (Medium). Below that,
 *     the line is dropped from the aggregate and counted as Low.
 *   · "Departments" has no dedicated table in this schema — we use
 *     `categories` as the dimension per PR-FIN-1 §13 Q3.
 *   · "Cards" total is forced to 0.00 with a tooltip per Q4 — the
 *     `cashboxes.kind` enum doesn't carry a 'card' variant yet.
 *   · "Recent movements" returns 20; the UI shows 8 (per Q6).
 *   · Quick reports availability is a static map: any report whose
 *     route exists today is `available=true`, the rest are
 *     placeholders.
 *
 * PR-FIN-2-HOTFIX-4 — dashboard clarity (read-only UX fixes):
 *   The PR-FIN-2 health card collapsed two distinct invariants
 *   ("Cashbox Drift" mixed real per-cashbox money drift with
 *   per-reference labeling drift). The expenses card was named
 *   "اليوم" but only made sense when today actually had expenses.
 *   The supplier card relied on a single legacy source. HOTFIX-4
 *   surfaces the right shape:
 *     · health.cashbox_balance_drift_count (NEW) — real money drift
 *     · health.engine_bypass_alerts_last_seen (NEW) — historical context
 *     · daily_expenses.{today_*, period_*} — both slices reported
 *     · balances.suppliers.{effective_source, sources_checked} —
 *       fallback chain: suppliers.current_balance → GL 211 →
 *       unpaid purchases. Pure SELECT; no writes anywhere.
 *
 * PR-FIN-2-HOTFIX-3 — employee balances column-name fix:
 *   The original PR-FIN-2 read employee balances from
 *   `v_employee_gl_balance` using `net_balance`, but the view
 *   exposes the column under the name `balance`. The query threw
 *   `42703: column "net_balance" does not exist` on every request;
 *   the defensive `.catch` returned zeros so the bug surfaced as
 *   the employees card silently rendering 0/0/0 instead of a 500.
 *   Fix: use `balance` throughout. A regression test in the spec
 *   asserts the SQL never references `net_balance` again.
 *
 * PR-FIN-2-HOTFIX-2 — connection-pool exhaustion fix:
 *   The original PR-FIN-2 fired 18 aggregators through a top-level
 *   `Promise.all`, plus an inner `Promise.all` of 3 inside `balances()`,
 *   plus multi-query helpers (`profit_trend`, `alerts`). On a typical
 *   request that meant ~28 concurrent SELECTs against the DB. Supabase's
 *   session-mode pooler caps at `pool_size: 15`, so the dashboard
 *   reliably returned `EMAXCONNSESSION max clients reached in session
 *   mode`. Fix: sequential awaits everywhere — concurrent queries
 *   per request capped at 1.
 *
 * PR-FIN-2-HOTFIX-1 — invoice_status enum fix:
 *   The original PR-FIN-2 SQL excluded out-of-scope invoices via
 *   `i.status NOT IN ('voided','cancelled')`. The Postgres
 *   `invoice_status` enum is {draft, completed, partially_paid,
 *   paid, refunded, cancelled} — NO 'voided' value — so every query
 *   threw `invalid input value for enum invoice_status: "voided"`
 *   at runtime, breaking the dashboard. The canonical "voided"
 *   indicator on `invoices` is the timestamp `voided_at` (paired
 *   with `voided_by` + `void_reason`). Fixed by replacing the bad
 *   filter with `i.status <> 'cancelled' AND i.voided_at IS NULL`.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ConfidenceTier,
  DashboardFilters,
  FinanceDashboardResponse,
} from './finance-dashboard.types';

@Injectable()
export class FinanceDashboardService {
  constructor(private readonly ds: DataSource) {}

  // ─── Public entry ────────────────────────────────────────────────
  async dashboard(filters: DashboardFilters): Promise<FinanceDashboardResponse> {
    const range = this.resolveRange(filters);
    const prevRange = this.previousRange(range);

    // PR-FIN-2-HOTFIX-2 — sequentialised aggregators.
    //
    // The original implementation fired all 18 aggregators through a
    // single `Promise.all` which, combined with the inner Promise.all
    // in `balances()` and the multi-query helpers, drove ~28 SELECTs
    // concurrent. Supabase's session-mode pooler caps at 15 clients
    // per session, so the dashboard reliably exhausted the pool with:
    //
    //   EMAXCONNSESSION max clients reached in session mode
    //
    // Sequential awaits cap concurrent queries at exactly 1 per
    // request — well under the pool limit, and the cumulative wall
    // time is acceptable because each query is a small SELECT
    // (typical < 50ms). Any future need for parallelism should use a
    // bounded concurrency limiter (max 2-3) plus a single shared
    // queryRunner — see Plan §13 in PR-FIN-2-HOTFIX-2 PR description.
    const health = await this.health();
    const liquidity = await this.liquidity(filters);
    const dailyExpenses = await this.dailyExpensesTodayAndPeriod(range);
    const balances = await this.balances();
    const profitNow = await this.profitTotals(range, filters);
    const profitPrev = await this.profitTotals(prevRange, filters);
    const profitTrend = await this.profitTrendDaily(range, filters);
    const paymentChannels = await this.paymentChannelsMix(range, filters);
    const groupProfits = await this.profitByCategoryGroups(range, filters);
    const topProducts = await this.topProducts(range, filters, 10);
    const profitByCustomer = await this.profitByCustomer(range, filters, 5);
    const profitBySupplier = await this.profitBySupplier(range, filters, 5);
    const profitByDepartment = await this.profitByDepartment(range, filters, 5);
    const profitByShift = await this.profitByShift(range, filters, 5);
    const profitByPaymentMethod = await this.profitByPaymentMethod(range, filters);
    const cashAccounts = await this.cashAccountsTable(filters);
    const recentMovements = await this.recentMovements(range, filters, 20);
    const alerts = await this.alerts();

    return {
      range,
      generated_at: new Date().toISOString(),
      filters_applied: this.echoFilters(filters),
      health,
      liquidity,
      daily_expenses: dailyExpenses,
      balances,
      // best_* surfaced from the already-computed aggregates so Row 2
      // doesn't render "لا يتوفر بعد" while the underlying tables show
      // concrete winners. Aggregates are pre-sorted by
      // (gross_profit DESC, name_ar ASC) so row 0 is the canonical
      // tie-broken winner.
      profit: this.composeProfit(profitNow, profitPrev, {
        topCustomer: profitByCustomer[0],
        topSupplier: profitBySupplier[0],
        topProduct: topProducts[0],
      }),
      profit_trend: profitTrend,
      payment_channels: paymentChannels,
      group_profits: groupProfits,
      top_products: topProducts,
      profit_by_customer: profitByCustomer,
      profit_by_supplier: profitBySupplier,
      profit_by_department: profitByDepartment,
      profit_by_shift: profitByShift,
      profit_by_payment_method: profitByPaymentMethod,
      cash_accounts: cashAccounts,
      recent_movements: recentMovements,
      alerts,
      quick_reports: this.quickReports(),
    };
  }

  // ─── Range helpers ───────────────────────────────────────────────
  private resolveRange(f: DashboardFilters): { from: string; to: string } {
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

  /** Same length, ending the day before `from`. */
  private previousRange(r: { from: string; to: string }): {
    from: string;
    to: string;
  } {
    const fromMs = new Date(`${r.from}T00:00:00Z`).getTime();
    const toMs = new Date(`${r.to}T00:00:00Z`).getTime();
    const lengthDays = Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
    const prevTo = new Date(fromMs - 86_400_000);
    const prevFrom = new Date(prevTo.getTime() - lengthDays * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: iso(prevFrom), to: iso(prevTo) };
  }

  private echoFilters(f: DashboardFilters): DashboardFilters {
    const out: DashboardFilters = {};
    if (f.cashbox_id) out.cashbox_id = f.cashbox_id;
    if (f.payment_account_id) out.payment_account_id = f.payment_account_id;
    if (f.user_id) out.user_id = f.user_id;
    if (f.shift_id) out.shift_id = f.shift_id;
    return out;
  }

  // ─── Health (مؤشرات السلامة المالية) ──────────────────────────────
  /**
   * PR-FIN-2-HOTFIX-4 — health response now reports three distinct
   * invariants instead of conflating cashbox-balance drift with
   * per-reference labeling drift:
   *
   *   · `cashbox_balance_drift_count` — count of cashboxes where
   *     `current_balance ≠ Σ cashbox_transactions(signed)`. This is
   *     the ONLY metric that means "money is unaccounted for".
   *   · `cashbox_drift_count` / `cashbox_drift_total` — the v_cashbox
   *     drift view (per-reference labeling mismatch). Money totals
   *     per cashbox still match; this only flags ledger hygiene.
   *   · `engine_bypass_alerts_7d` + `..._last_seen` — historical
   *     legacy-path writes; the timestamp lets the UI mark them as
   *     "تنبيهات تاريخية" when last_seen is older than ~24h.
   *
   * Status logic unchanged from PR-FIN-2: warnings come from
   * either drift type or bypass count; criticals from imbalance or
   * unbalanced JEs.
   */
  private async health(): Promise<FinanceDashboardResponse['health']> {
    const rows = await this.ds.query(`
      WITH tb AS (
        SELECT COALESCE(SUM(jl.debit), 0)  AS total_debit,
               COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.is_posted = TRUE AND je.is_void = FALSE
      ),
      cashbox_money_drift AS (
        -- REAL money drift: per-cashbox current_balance vs SUM(ct.signed)
        SELECT COUNT(*) AS n FROM (
          SELECT c.id
          FROM cashboxes c
          WHERE ROUND(c.current_balance - COALESCE((
            SELECT SUM(CASE WHEN ct.direction='in' THEN ct.amount ELSE -ct.amount END)
            FROM cashbox_transactions ct
            WHERE ct.cashbox_id = c.id AND ct.is_void = FALSE
          ), 0), 2) <> 0
        ) s
      ),
      ref_drift AS (
        SELECT COUNT(*) AS n,
               COALESCE(SUM(ABS(drift_amount)), 0) AS total_abs
        FROM v_cashbox_drift_per_ref
        WHERE drift_amount <> 0
      ),
      bypass AS (
        SELECT COUNT(*) AS n,
               MAX(created_at) AS last_seen
        FROM engine_bypass_alerts
        WHERE created_at > now() - INTERVAL '7 days'
      ),
      unbalanced AS (
        SELECT COUNT(*) AS n FROM (
          SELECT je.id
          FROM journal_entries je
          JOIN journal_lines  jl ON jl.entry_id = je.id
          WHERE je.is_posted = TRUE AND je.is_void = FALSE
          GROUP BY je.id
          HAVING ROUND(SUM(jl.debit), 2) <> ROUND(SUM(jl.credit), 2)
        ) s
      )
      SELECT
        (SELECT total_debit          FROM tb)                  AS total_debit,
        (SELECT total_credit         FROM tb)                  AS total_credit,
        (SELECT n                    FROM cashbox_money_drift) AS cashbox_balance_drift_count,
        (SELECT n                    FROM ref_drift)           AS drift_count,
        (SELECT total_abs            FROM ref_drift)           AS drift_abs,
        (SELECT n                    FROM bypass)              AS bypass_7d,
        (SELECT last_seen            FROM bypass)              AS bypass_last_seen,
        (SELECT n                    FROM unbalanced)          AS unbalanced_count
    `);
    const r = rows[0] ?? {};
    const imbalance = Number(r.total_debit ?? 0) - Number(r.total_credit ?? 0);
    const balanceDriftCount = Number(r.cashbox_balance_drift_count ?? 0);
    const driftAbs = Number(r.drift_abs ?? 0);
    const bypass7d = Number(r.bypass_7d ?? 0);
    const unbalanced = Number(r.unbalanced_count ?? 0);

    let overall: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (Math.abs(imbalance) > 0.01 || unbalanced > 0 || balanceDriftCount > 0) {
      overall = 'critical';
    } else if (driftAbs > 0 || bypass7d > 0) {
      overall = 'warning';
    }

    return {
      trial_balance_imbalance: round2(imbalance),
      cashbox_balance_drift_count: balanceDriftCount,
      cashbox_drift_total: round2(driftAbs),
      cashbox_drift_count: Number(r.drift_count ?? 0),
      engine_bypass_alerts_7d: bypass7d,
      engine_bypass_alerts_last_seen:
        r.bypass_last_seen instanceof Date
          ? r.bypass_last_seen.toISOString()
          : r.bypass_last_seen
            ? String(r.bypass_last_seen)
            : null,
      unbalanced_entries_count: unbalanced,
      overall,
    };
  }

  // ─── Liquidity (النقدية وما في حكمها) ─────────────────────────────
  private async liquidity(
    f: DashboardFilters,
  ): Promise<FinanceDashboardResponse['liquidity']> {
    const rows = await this.ds.query(
      `SELECT
         kind,
         COALESCE(SUM(current_balance), 0) AS total
       FROM cashboxes
       WHERE is_active = TRUE
         ${f.cashbox_id ? 'AND id = $1' : ''}
       GROUP BY kind`,
      f.cashbox_id ? [f.cashbox_id] : [],
    );
    const sumByKind = (kind: string) =>
      Number(
        (rows.find((r: any) => r.kind === kind) ?? { total: 0 }).total ?? 0,
      );

    const cashboxes = sumByKind('cash');
    const banks = sumByKind('bank');
    const wallets = sumByKind('ewallet');
    // Cards total is intentionally 0.00 — see Q4 of the plan.
    // We do NOT fabricate; cashboxes.kind has no 'card' value yet.
    const cards = 0;
    const total = round2(cashboxes + banks + wallets + cards);
    return {
      cashboxes_total: round2(cashboxes),
      banks_total: round2(banks),
      wallets_total: round2(wallets),
      cards_total: 0,
      total_cash_equivalents: total,
    };
  }

  // ─── Expenses (المصروفات — اليوم / الفترة) ───────────────────────
  /**
   * PR-FIN-2-HOTFIX-4 — split `dailyExpensesToday()` into a combined
   * today + period helper. The card title was "المصروفات اليوم" in
   * PR-FIN-2 but rendered zero whenever today had no expenses, which
   * looked broken even though the user had real expense activity in
   * the selected period. We now return BOTH:
   *
   *   · `today_*` — Cairo today's date only (hard-bound, ignores the
   *     dashboard's range filter so "اليوم" always means today).
   *   · `period_*` — uses the dashboard's `range` filter so the
   *     period total respects whatever the user picked in the
   *     filter bar.
   *
   * Both slices read-only from `expenses`; the DailyExpenses page
   * and `POST /accounting/expenses/daily` are NOT touched.
   */
  private async dailyExpensesTodayAndPeriod(
    range: { from: string; to: string },
  ): Promise<FinanceDashboardResponse['daily_expenses']> {
    const rows = await this.ds.query(
      `WITH today_expenses AS (
         SELECT e.amount, c.name_ar AS category
         FROM expenses e
         LEFT JOIN expense_categories c ON c.id = e.category_id
         WHERE e.expense_date = (now() AT TIME ZONE 'Africa/Cairo')::date
       ),
       period_expenses AS (
         SELECT e.amount, c.name_ar AS category
         FROM expenses e
         LEFT JOIN expense_categories c ON c.id = e.category_id
         WHERE e.expense_date >= $1::date
           AND e.expense_date <= $2::date
       ),
       today_largest AS (
         SELECT category, amount FROM today_expenses
         ORDER BY amount DESC LIMIT 1
       ),
       period_largest AS (
         SELECT category, amount FROM period_expenses
         ORDER BY amount DESC LIMIT 1
       )
       SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM today_expenses)  AS today_total,
         (SELECT COUNT(*)                  FROM today_expenses)  AS today_count,
         (SELECT category FROM today_largest)                    AS today_largest_cat,
         (SELECT amount   FROM today_largest)                    AS today_largest_amt,
         (SELECT COALESCE(SUM(amount), 0) FROM period_expenses) AS period_total,
         (SELECT COUNT(*)                  FROM period_expenses) AS period_count,
         (SELECT category FROM period_largest)                   AS period_largest_cat,
         (SELECT amount   FROM period_largest)                   AS period_largest_amt`,
      [range.from, range.to],
    );
    const r = rows[0] ?? {};
    return {
      today_total: round2(r.today_total ?? 0),
      today_count: Number(r.today_count ?? 0),
      today_largest:
        r.today_largest_amt != null
          ? {
              category: r.today_largest_cat ?? null,
              amount: round2(r.today_largest_amt),
            }
          : null,
      period_total: round2(r.period_total ?? 0),
      period_count: Number(r.period_count ?? 0),
      period_largest:
        r.period_largest_amt != null
          ? {
              category: r.period_largest_cat ?? null,
              amount: round2(r.period_largest_amt),
            }
          : null,
    };
  }

  // ─── Balances (customers / suppliers / employees) ─────────────────
  private async balances(): Promise<FinanceDashboardResponse['balances']> {
    // PR-FIN-2-HOTFIX-2 — sequentialised. The original `Promise.all`
    // contributed 3 of the ~28 concurrent queries that exhausted the
    // pool. Each helper SELECT here is small; sequential is fine.
    const customers = await this.ds.query(`
      WITH active AS (
        SELECT id, full_name, COALESCE(current_balance, 0) AS bal
        FROM customers
        WHERE deleted_at IS NULL
          AND COALESCE(current_balance, 0) > 0
      )
      SELECT
        COALESCE(SUM(bal), 0) AS total,
        COUNT(*)              AS n,
        (SELECT full_name FROM active ORDER BY bal DESC, full_name ASC LIMIT 1) AS top_name,
        (SELECT bal       FROM active ORDER BY bal DESC, full_name ASC LIMIT 1) AS top_amount
      FROM active
    `);
    // PR-FIN-2-HOTFIX-4 — supplier balances now consult three
    // independent sources and pick the most authoritative non-zero
    // value per supplier:
    //   1. `suppliers.current_balance` (legacy sub-ledger)
    //   2. GL account 211 summed per supplier_id from journal_lines
    //   3. `purchases.grand_total - paid_amount` per supplier
    // The card shows the aggregate of effective balances + a label
    // describing which sources contributed (`effective_source`).
    // When all three agree on zero, `effective_source = 'none'` and
    // the UI renders "لا توجد أرصدة موردين مسجلة حاليًا".
    // Nothing is fabricated; nothing is written.
    const suppliers = await this.ds.query(`
      WITH coa_211 AS (
        SELECT id FROM chart_of_accounts WHERE code = '211' LIMIT 1
      ),
      sources AS (
        SELECT
          s.id,
          s.name,
          COALESCE(s.current_balance, 0)                                 AS table_bal,
          COALESCE((
            SELECT SUM(jl.credit) - SUM(jl.debit)
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.entry_id
            JOIN coa_211 ca ON jl.account_id = ca.id
            WHERE je.is_posted = TRUE AND je.is_void = FALSE
              AND jl.supplier_id = s.id
          ), 0)                                                          AS gl_bal,
          COALESCE((
            SELECT SUM(p.grand_total - COALESCE(p.paid_amount, 0))
            FROM purchases p
            WHERE p.supplier_id = s.id
              AND COALESCE(p.grand_total, 0) > COALESCE(p.paid_amount, 0)
          ), 0)                                                          AS purchase_bal
        FROM suppliers s
        WHERE s.deleted_at IS NULL
      ),
      effective AS (
        SELECT
          id, name, table_bal, gl_bal, purchase_bal,
          CASE
            WHEN table_bal    <> 0 THEN table_bal
            WHEN gl_bal       <> 0 THEN gl_bal
            WHEN purchase_bal <> 0 THEN purchase_bal
            ELSE 0
          END AS bal,
          CASE
            WHEN table_bal    <> 0 THEN 'suppliers_table'
            WHEN gl_bal       <> 0 THEN 'gl_211'
            WHEN purchase_bal <> 0 THEN 'purchases'
            ELSE 'none'
          END AS source
        FROM sources
      )
      SELECT
        COALESCE(SUM(GREATEST(bal, 0)), 0) AS total,
        COUNT(*) FILTER (WHERE bal > 0) AS n,
        (SELECT name FROM effective WHERE bal > 0 ORDER BY bal DESC, name ASC LIMIT 1) AS top_name,
        (SELECT bal  FROM effective WHERE bal > 0 ORDER BY bal DESC, name ASC LIMIT 1) AS top_amount,
        bool_or(table_bal    <> 0) AS has_table,
        bool_or(gl_bal       <> 0) AS has_gl,
        bool_or(purchase_bal <> 0) AS has_purchase
      FROM effective
    `).catch(() => [{
      total: 0, n: 0, top_name: null, top_amount: null,
      has_table: false, has_gl: false, has_purchase: false,
    }]);
    // PR-FIN-2-HOTFIX-3 — `v_employee_gl_balance` exposes the column
    // `balance`, NOT `net_balance`. The original PR-FIN-2 query used
    // `net_balance` (anticipated naming) which threw at runtime; the
    // surrounding `.catch` silently returned zeros, so the dashboard
    // rendered 0/0/0 for the employees card and the bug went
    // unnoticed at the controller layer. The column rename is fixed
    // here. The defensive `.catch` is preserved for genuine view
    // unavailability, but tests now assert the SQL never compares
    // against `net_balance` again — see the regression block in
    // finance-dashboard.service.spec.ts (PR-FIN-2-HOTFIX-3).
    const employees = await this.ds.query(`
      SELECT
        COALESCE(SUM(CASE WHEN balance > 0 THEN  balance ELSE 0 END), 0) AS owed_to,
        COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END), 0) AS owed_by,
        COALESCE(SUM(balance), 0) AS net
      FROM v_employee_gl_balance
    `).catch(() => [{ owed_to: 0, owed_by: 0, net: 0 }]);

    const c = customers[0] ?? {};
    const s = suppliers[0] ?? {};
    const e = employees[0] ?? {};

    return {
      customers: {
        total_due: round2(c.total ?? 0),
        count: Number(c.n ?? 0),
        top:
          c.top_name && c.top_amount != null
            ? { name: c.top_name, amount: round2(c.top_amount) }
            : null,
      },
      suppliers: {
        total_due: round2(s.total ?? 0),
        count: Number(s.n ?? 0),
        top:
          s.top_name && s.top_amount != null
            ? { name: s.top_name, amount: round2(s.top_amount) }
            : null,
        // Tells the UI which source dominated. 'mixed' covers the
        // case where DIFFERENT suppliers had non-zero values from
        // different sources (e.g. one supplier from `gl_211` plus
        // another from `purchases`). 'none' means every source
        // agreed on zero — the UI renders an explicit
        // "لا توجد أرصدة موردين مسجلة حاليًا" message.
        effective_source: deriveSupplierSource({
          has_table: !!s.has_table,
          has_gl: !!s.has_gl,
          has_purchase: !!s.has_purchase,
        }),
        sources_checked: ['suppliers_table', 'gl_211', 'purchases'],
      },
      employees: {
        total_owed_to: round2(e.owed_to ?? 0),
        total_owed_by: round2(e.owed_by ?? 0),
        net: round2(e.net ?? 0),
      },
    };
  }

  // ─── Profit totals (within range) ─────────────────────────────────
  private async profitTotals(
    range: { from: string; to: string },
    f: DashboardFilters,
  ) {
    // Sales / COGS / gross profit from invoices within range, plus
    // confidence breakdown counted at the line level.
    const rows = await this.ds.query(
      `WITH inv AS (
         SELECT
           i.id,
           i.subtotal,
           i.cogs_total,
           i.gross_profit,
           i.is_return,
           i.status,
           i.shift_id,
           i.cashier_id
         FROM invoices i
         WHERE i.created_at >= $1::date
           AND i.created_at <  ($2::date + INTERVAL '1 day')
           AND i.is_return  = FALSE
           AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
           ${f.shift_id ? 'AND i.shift_id = $3' : ''}
           ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       ),
       lines AS (
         SELECT
           il.invoice_id,
           il.cost_total,
           il.line_total,
           il.unit_cost
         FROM invoice_lines il
         WHERE il.invoice_id IN (SELECT id FROM inv)
       ),
       expense_total AS (
         SELECT COALESCE(SUM(amount), 0) AS total
         FROM expenses
         WHERE expense_date >= $1::date
           AND expense_date <= $2::date
           ${f.cashbox_id ? `AND cashbox_id = ${this.expensesParamIdx(f)}` : ''}
       ),
       agg AS (
         SELECT
           COALESCE(SUM(subtotal),     0) AS sales,
           COALESCE(SUM(cogs_total),   0) AS cogs,
           COALESCE(SUM(gross_profit), 0) AS gross
         FROM inv
       ),
       conf AS (
         SELECT
           COUNT(*) FILTER (WHERE cost_total IS NOT NULL AND cost_total > 0)
             AS high_lines,
           COUNT(*) FILTER (
             WHERE (cost_total IS NULL OR cost_total = 0)
               AND unit_cost IS NOT NULL AND unit_cost > 0
           ) AS medium_lines,
           COUNT(*) FILTER (
             WHERE (cost_total IS NULL OR cost_total = 0)
               AND (unit_cost IS NULL OR unit_cost = 0)
           ) AS low_lines
         FROM lines
       )
       SELECT
         (SELECT sales        FROM agg)           AS sales,
         (SELECT cogs         FROM agg)           AS cogs,
         (SELECT gross        FROM agg)           AS gross,
         (SELECT total        FROM expense_total) AS expenses,
         (SELECT high_lines   FROM conf)          AS high_lines,
         (SELECT medium_lines FROM conf)          AS medium_lines,
         (SELECT low_lines    FROM conf)          AS low_lines`,
      this.profitParams(range, f),
    );
    const r = rows[0] ?? {};
    return {
      sales: round2(r.sales ?? 0),
      cogs: round2(r.cogs ?? 0),
      gross: round2(r.gross ?? 0),
      expenses: round2(r.expenses ?? 0),
      high_lines: Number(r.high_lines ?? 0),
      medium_lines: Number(r.medium_lines ?? 0),
      low_lines: Number(r.low_lines ?? 0),
    };
  }

  /**
   * The expense filter parameter position depends on which optional
   * filters are present. Keep the SQL builder in one helper.
   */
  private expensesParamIdx(f: DashboardFilters): string {
    let idx = 3;
    if (f.shift_id) idx++;
    if (f.user_id) idx++;
    return `$${idx}`;
  }

  private profitParams(
    range: { from: string; to: string },
    f: DashboardFilters,
  ): any[] {
    const out: any[] = [range.from, range.to];
    if (f.shift_id) out.push(f.shift_id);
    if (f.user_id) out.push(f.user_id);
    if (f.cashbox_id) out.push(f.cashbox_id);
    return out;
  }

  private composeProfit(
    now: Awaited<ReturnType<typeof this.profitTotals>>,
    prev: Awaited<ReturnType<typeof this.profitTotals>>,
    bests: {
      topCustomer?: { name_ar: string; gross_profit: number };
      topSupplier?: { name_ar: string; gross_profit: number };
      topProduct?: { name_ar: string; gross_profit: number };
    } = {},
  ): FinanceDashboardResponse['profit'] {
    const net = round2(now.gross - now.expenses);
    const margin = now.sales > 0 ? round2((now.gross / now.sales) * 100) : 0;
    const prevNet = round2(prev.gross - prev.expenses);
    const prevMargin =
      prev.sales > 0 ? (prev.gross / prev.sales) * 100 : 0;

    const tier: ConfidenceTier =
      now.high_lines + now.medium_lines + now.low_lines === 0
        ? 'N/A'
        : now.low_lines > 0
          ? 'Low'
          : now.medium_lines > 0
            ? 'Medium'
            : 'High';

    return {
      sales_total: now.sales,
      cogs_total: now.cogs,
      gross_profit: now.gross,
      expenses_total: now.expenses,
      net_profit: net,
      margin_pct: margin,
      delta_vs_previous: {
        sales_pct: pct(now.sales, prev.sales),
        cogs_pct: pct(now.cogs, prev.cogs),
        gross_pct: pct(now.gross, prev.gross),
        expenses_pct: pct(now.expenses, prev.expenses),
        net_pct: pct(net, prevNet),
        margin_pp: round2(margin - prevMargin),
      },
      // Pick row 0 of each aggregate. Aggregates are pre-sorted by
      // (gross_profit DESC, name_ar ASC) so row 0 honors the
      // approved Q5 tie-break. Skip when profit is non-positive — a
      // "best" with zero/negative profit is misleading.
      best_customer: pickBest(bests.topCustomer),
      best_supplier: pickBest(bests.topSupplier),
      best_product: pickBest(bests.topProduct),
      confidence: tier,
      confidence_breakdown: {
        high_lines: now.high_lines,
        medium_lines: now.medium_lines,
        low_lines: now.low_lines,
      },
    };
  }

  // ─── Profit trend (daily series for line chart) ───────────────────
  private async profitTrendDaily(
    range: { from: string; to: string },
    f: DashboardFilters,
  ): Promise<FinanceDashboardResponse['profit_trend']> {
    const rows = await this.ds.query(
      `SELECT
         (i.created_at AT TIME ZONE 'Africa/Cairo')::date AS d,
         COALESCE(SUM(i.gross_profit), 0) AS gross,
         COALESCE(SUM(i.cogs_total),   0) AS cogs,
         COALESCE(SUM(i.subtotal),     0) AS sales
       FROM invoices i
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY 1
       ORDER BY 1`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
      ],
    );
    // Daily expenses lookup, mapped by date for net-profit subtraction.
    const expenseRows = await this.ds.query(
      `SELECT expense_date AS d, COALESCE(SUM(amount), 0) AS total
       FROM expenses
       WHERE expense_date >= $1::date AND expense_date <= $2::date
       GROUP BY 1`,
      [range.from, range.to],
    );
    const expByDate: Record<string, number> = {};
    for (const r of expenseRows) {
      const k = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : r.d;
      expByDate[k] = Number(r.total);
    }
    return rows.map((r: any) => {
      const k = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : r.d;
      const exp = expByDate[k] ?? 0;
      return {
        date: k,
        gross_profit: round2(r.gross),
        cogs: round2(r.cogs),
        net_profit: round2(Number(r.gross) - exp),
      };
    });
  }

  // ─── Payment channels (donut chart — sales mix) ───────────────────
  private async paymentChannelsMix(
    range: { from: string; to: string },
    f: DashboardFilters,
  ): Promise<FinanceDashboardResponse['payment_channels']> {
    const rows = await this.ds.query(
      `SELECT
         ip.payment_method::text AS method,
         COALESCE(SUM(ip.amount), 0) AS sales
       FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY ip.payment_method
       ORDER BY sales DESC`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
      ],
    );
    const total = rows.reduce(
      (acc: number, r: any) => acc + Number(r.sales),
      0,
    );
    return rows.map((r: any) => ({
      method_key: r.method,
      label_ar: METHOD_LABEL_AR[r.method] ?? r.method,
      sales: round2(r.sales),
      pct: total > 0 ? round2((Number(r.sales) / total) * 100) : 0,
    }));
  }

  // ─── أرباح المجموعات (categories aggregation) ─────────────────────
  private async profitByCategoryGroups(
    range: { from: string; to: string },
    f: DashboardFilters,
  ): Promise<FinanceDashboardResponse['group_profits']> {
    const rows = await this.ds.query(
      `SELECT
         c.id AS category_id,
         c.name_ar AS label_ar,
         COALESCE(SUM(il.line_total - COALESCE(il.cost_total, 0)), 0) AS profit
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       JOIN products p ON p.id = il.variant_id OR p.id = (
         SELECT pv.product_id FROM product_variants pv WHERE pv.id = il.variant_id LIMIT 1
       )
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY c.id, c.name_ar
       ORDER BY profit DESC, c.name_ar ASC
       LIMIT 5`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
      ],
    ).catch(() => []);
    return rows.map((r: any) => ({
      group_id: r.category_id,
      label_ar: r.label_ar ?? 'أخرى',
      profit: round2(r.profit ?? 0),
    }));
  }

  // ─── Top 10 products by gross profit ──────────────────────────────
  private async topProducts(
    range: { from: string; to: string },
    f: DashboardFilters,
    limit: number,
  ): Promise<FinanceDashboardResponse['top_products']> {
    const rows = await this.ds.query(
      `SELECT
         p.id AS product_id,
         COALESCE(p.name_ar, p.name, p.name_en, '—') AS name_ar,
         COALESCE(SUM(il.line_total),                       0) AS sales,
         COALESCE(SUM(il.line_total - COALESCE(il.cost_total, 0)), 0) AS gross
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       LEFT JOIN product_variants pv ON pv.id = il.variant_id
       LEFT JOIN products p ON p.id = COALESCE(pv.product_id, il.variant_id)
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY p.id, p.name_ar, p.name, p.name_en
       ORDER BY gross DESC, name_ar ASC
       LIMIT $${this.dynLimitIdx(f)}`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
        limit,
      ],
    ).catch(() => []);
    return rows.map((r: any) => ({
      product_id: r.product_id,
      name_ar: r.name_ar,
      sales: round2(r.sales),
      gross_profit: round2(r.gross),
      margin_pct:
        Number(r.sales) > 0
          ? round2((Number(r.gross) / Number(r.sales)) * 100)
          : 0,
    }));
  }

  private dynLimitIdx(f: DashboardFilters): number {
    let i = 3;
    if (f.shift_id) i++;
    if (f.user_id) i++;
    return i;
  }

  // ─── Profit by customer ───────────────────────────────────────────
  private async profitByCustomer(
    range: { from: string; to: string },
    f: DashboardFilters,
    limit: number,
  ): Promise<FinanceDashboardResponse['profit_by_customer']> {
    const rows = await this.ds.query(
      `SELECT
         c.id AS customer_id,
         c.full_name AS name_ar,
         COUNT(DISTINCT i.id) AS invoices_count,
         COALESCE(SUM(i.subtotal),     0) AS sales,
         COALESCE(SUM(i.gross_profit), 0) AS gross
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY c.id, c.full_name
       ORDER BY gross DESC, c.full_name ASC
       LIMIT $${this.dynLimitIdx(f)}`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
        limit,
      ],
    ).catch(() => []);
    return rows.map((r: any) => ({
      customer_id: r.customer_id,
      name_ar: r.name_ar,
      sales: round2(r.sales),
      gross_profit: round2(r.gross),
      margin_pct:
        Number(r.sales) > 0
          ? round2((Number(r.gross) / Number(r.sales)) * 100)
          : 0,
      invoices_count: Number(r.invoices_count ?? 0),
    }));
  }

  // ─── Profit by supplier (rough — through products) ────────────────
  private async profitBySupplier(
    range: { from: string; to: string },
    f: DashboardFilters,
    limit: number,
  ): Promise<FinanceDashboardResponse['profit_by_supplier']> {
    const rows = await this.ds.query(
      `SELECT
         s.id AS supplier_id,
         s.name AS name_ar,
         COALESCE(SUM(il.line_total),                          0) AS sales,
         COALESCE(SUM(il.cost_total),                          0) AS cost,
         COALESCE(SUM(il.line_total - COALESCE(il.cost_total, 0)), 0) AS gross
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       LEFT JOIN product_variants pv ON pv.id = il.variant_id
       LEFT JOIN products p ON p.id = COALESCE(pv.product_id, il.variant_id)
       JOIN suppliers s ON s.id = p.supplier_id
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY s.id, s.name
       ORDER BY gross DESC, s.name ASC
       LIMIT $${this.dynLimitIdx(f)}`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
        limit,
      ],
    ).catch(() => []);
    return rows.map((r: any) => ({
      supplier_id: r.supplier_id,
      name_ar: r.name_ar,
      sales: round2(r.sales),
      cost: round2(r.cost),
      gross_profit: round2(r.gross),
      margin_pct:
        Number(r.sales) > 0
          ? round2((Number(r.gross) / Number(r.sales)) * 100)
          : 0,
    }));
  }

  // ─── Profit by department (uses categories as fallback per Q3) ────
  private async profitByDepartment(
    range: { from: string; to: string },
    f: DashboardFilters,
    limit: number,
  ): Promise<FinanceDashboardResponse['profit_by_department']> {
    // Same SQL as group profits but limited & marked as departments.
    const rows = await this.ds.query(
      `SELECT
         c.id AS department_id,
         COALESCE(c.name_ar, 'أخرى') AS name_ar,
         COALESCE(SUM(il.line_total), 0) AS sales,
         COALESCE(SUM(il.line_total - COALESCE(il.cost_total, 0)), 0) AS gross
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       LEFT JOIN product_variants pv ON pv.id = il.variant_id
       LEFT JOIN products p ON p.id = COALESCE(pv.product_id, il.variant_id)
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY c.id, c.name_ar
       ORDER BY gross DESC, c.name_ar ASC
       LIMIT $${this.dynLimitIdx(f)}`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
        limit,
      ],
    ).catch(() => []);
    return rows.map((r: any) => ({
      department_id: r.department_id,
      name_ar: r.name_ar,
      sales: round2(r.sales),
      gross_profit: round2(r.gross),
      margin_pct:
        Number(r.sales) > 0
          ? round2((Number(r.gross) / Number(r.sales)) * 100)
          : 0,
    }));
  }

  // ─── Profit by shift ─────────────────────────────────────────────
  private async profitByShift(
    range: { from: string; to: string },
    f: DashboardFilters,
    limit: number,
  ): Promise<FinanceDashboardResponse['profit_by_shift']> {
    const rows = await this.ds.query(
      `SELECT
         s.id AS shift_id,
         s.opened_at,
         COALESCE(SUM(i.subtotal),     0) AS sales,
         COALESCE(SUM(i.gross_profit), 0) AS gross,
         (COALESCE(s.total_cash_in, 0) - COALESCE(s.total_cash_out, 0)) AS cash_net
       FROM shifts s
       LEFT JOIN invoices i
         ON i.shift_id = s.id
        AND i.is_return = FALSE
        AND i.status <> 'cancelled'
        AND i.voided_at IS NULL
       WHERE s.opened_at >= $1::date
         AND s.opened_at <  ($2::date + INTERVAL '1 day')
       GROUP BY s.id, s.opened_at, s.total_cash_in, s.total_cash_out
       ORDER BY gross DESC, s.opened_at DESC
       LIMIT $3`,
      [range.from, range.to, limit],
    ).catch(() => []);
    return rows.map((r: any) => ({
      shift_id: r.shift_id,
      opened_at:
        r.opened_at instanceof Date
          ? r.opened_at.toISOString()
          : String(r.opened_at),
      sales: round2(r.sales),
      cash_net: round2(r.cash_net),
      gross_profit: round2(r.gross),
      margin_pct:
        Number(r.sales) > 0
          ? round2((Number(r.gross) / Number(r.sales)) * 100)
          : 0,
    }));
  }

  // ─── Profit by payment method (with payment_account fees if any) ──
  private async profitByPaymentMethod(
    range: { from: string; to: string },
    f: DashboardFilters,
  ): Promise<FinanceDashboardResponse['profit_by_payment_method']> {
    const rows = await this.ds.query(
      `SELECT
         ip.payment_method::text AS method_key,
         COALESCE(SUM(ip.amount), 0) AS sales
       FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
       WHERE i.created_at >= $1::date
         AND i.created_at <  ($2::date + INTERVAL '1 day')
         AND i.is_return  = FALSE
         AND i.status <> 'cancelled'
         AND i.voided_at IS NULL
         ${f.shift_id ? 'AND i.shift_id = $3' : ''}
         ${f.user_id ? `AND i.cashier_id = ${f.shift_id ? '$4' : '$3'}` : ''}
       GROUP BY ip.payment_method
       ORDER BY sales DESC`,
      [
        range.from,
        range.to,
        ...(f.shift_id ? [f.shift_id] : []),
        ...(f.user_id ? [f.user_id] : []),
      ],
    ).catch(() => []);
    return rows.map((r: any) => ({
      method_key: r.method_key,
      label_ar: METHOD_LABEL_AR[r.method_key] ?? r.method_key,
      sales: round2(r.sales),
      // Fees / costs not tracked at the line level today — placeholder 0.
      fees_or_costs: 0,
      net_collection: round2(r.sales),
      margin_pct: 0,
    }));
  }

  // ─── Cash accounts table ─────────────────────────────────────────
  private async cashAccountsTable(
    f: DashboardFilters,
  ): Promise<FinanceDashboardResponse['cash_accounts']> {
    const rows = await this.ds.query(
      `WITH movements AS (
         SELECT
           ct.cashbox_id,
           COALESCE(SUM(CASE WHEN ct.direction='in'  THEN ct.amount ELSE 0 END), 0) AS inflow,
           COALESCE(SUM(CASE WHEN ct.direction='out' THEN ct.amount ELSE 0 END), 0) AS outflow,
           MAX(ct.created_at) AS last_movement
         FROM cashbox_transactions ct
         WHERE ct.is_void = FALSE
         GROUP BY ct.cashbox_id
       )
       SELECT
         c.id,
         c.name_ar,
         c.kind,
         c.is_active,
         COALESCE(c.opening_balance, 0) AS opening_balance,
         COALESCE(m.inflow, 0)          AS inflow,
         COALESCE(m.outflow, 0)         AS outflow,
         c.current_balance,
         m.last_movement
       FROM cashboxes c
       LEFT JOIN movements m ON m.cashbox_id = c.id
       ${f.cashbox_id ? 'WHERE c.id = $1' : ''}
       ORDER BY c.is_active DESC, c.kind, c.name_ar`,
      f.cashbox_id ? [f.cashbox_id] : [],
    );
    return rows.map((r: any) => ({
      cashbox_id: r.id,
      name_ar: r.name_ar,
      kind: r.kind,
      opening_balance: round2(r.opening_balance),
      inflow: round2(r.inflow),
      outflow: round2(r.outflow),
      current_balance: round2(r.current_balance),
      last_movement_at:
        r.last_movement instanceof Date
          ? r.last_movement.toISOString()
          : r.last_movement
            ? String(r.last_movement)
            : null,
      status: r.is_active ? 'active' : 'inactive',
    }));
  }

  // ─── Recent movements (last 20 active JEs in range) ───────────────
  private async recentMovements(
    range: { from: string; to: string },
    f: DashboardFilters,
    limit: number,
  ): Promise<FinanceDashboardResponse['recent_movements']> {
    const rows = await this.ds.query(
      `SELECT
         je.created_at,
         je.entry_no,
         je.is_void,
         je.is_posted,
         je.reference_type,
         je.reference_id,
         u.full_name AS user_name,
         (SELECT COALESCE(SUM(jl.debit), 0)
            FROM journal_lines jl WHERE jl.entry_id = je.id) AS amount
       FROM journal_entries je
       LEFT JOIN users u ON u.id = je.created_by
       WHERE je.created_at >= $1::date
         AND je.created_at <  ($2::date + INTERVAL '1 day')
       ORDER BY je.created_at DESC
       LIMIT $3`,
      [range.from, range.to, limit],
    );
    return rows.map((r: any) => {
      const sourceLabel = this.formatSourceLabel(
        r.reference_type,
        r.reference_id,
        r.entry_no,
      );
      return {
        occurred_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
        user_name: r.user_name ?? null,
        operation_type: REF_TYPE_LABEL_AR[r.reference_type] ?? r.reference_type,
        source_label: sourceLabel,
        amount: round2(r.amount ?? 0),
        status: r.is_void ? 'voided' : r.is_posted ? 'active' : 'pending',
        journal_entry_no: r.entry_no ?? null,
        // Drill-down route is gated to PR-FIN-4 — null for now.
        drilldown_url: null,
      };
    });
  }

  private formatSourceLabel(
    refType: string | null,
    refId: string | null,
    entryNo: string | null,
  ): string {
    if (!refType) return entryNo ?? '—';
    return entryNo ?? `${refType} ${refId ?? ''}`.trim();
  }

  // ─── Alerts (التحذيرات والتنبيهات) ────────────────────────────────
  private async alerts(): Promise<FinanceDashboardResponse['alerts']> {
    const out: FinanceDashboardResponse['alerts'] = [];

    // 1) Cashbox drift
    const drift = await this.ds.query(`
      SELECT COUNT(*) AS n FROM v_cashbox_drift_per_ref WHERE drift_amount <> 0
    `);
    if (Number(drift[0]?.n ?? 0) > 0) {
      out.push({
        type: 'cashbox_drift',
        label_ar: 'انحراف صندوق النقدية',
        severity: 'warning',
        description: `${drift[0].n} مرجع يحتوي على فارق بين GL و cashbox`,
        deeplink: null,
      });
    }

    // 2) Engine bypass alerts (last 7d)
    const bypass = await this.ds.query(`
      SELECT COUNT(*) AS n FROM engine_bypass_alerts
      WHERE created_at > now() - INTERVAL '7 days'
    `);
    if (Number(bypass[0]?.n ?? 0) > 0) {
      out.push({
        type: 'engine_bypass',
        label_ar: 'تجاوز المحرك المالي',
        severity: 'warning',
        description: `${bypass[0].n} كتابة مالية مرّت بمسار قديم خلال آخر ٧ أيام`,
        deeplink: null,
      });
    }

    // 3) Pending employee requests
    const pendingReq = await this.ds.query(`
      SELECT COUNT(*) AS n FROM employee_requests WHERE status = 'pending'
    `).catch(() => [{ n: 0 }]);
    if (Number(pendingReq[0]?.n ?? 0) > 0) {
      out.push({
        type: 'employee_request',
        label_ar: 'طلب موظف مفتوح',
        severity: 'info',
        description: `${pendingReq[0].n} طلب بانتظار القرار`,
        deeplink: '/team',
      });
    }

    // 4) Pending expense approvals
    const pendingExp = await this.ds.query(`
      SELECT COUNT(*) AS n FROM expenses
      WHERE COALESCE(is_approved, FALSE) = FALSE
        AND COALESCE(rejected_reason, '') = ''
    `).catch(() => [{ n: 0 }]);
    if (Number(pendingExp[0]?.n ?? 0) > 0) {
      out.push({
        type: 'expense_approval',
        label_ar: 'مصروف بانتظار الاعتماد',
        severity: 'info',
        description: `${pendingExp[0].n} مصروف بانتظار اعتماد المحاسبة`,
        deeplink: null,
      });
    }

    // 5) Payment account misconfigurations (no GL code mapped)
    const badPay = await this.ds.query(`
      SELECT COUNT(*) AS n FROM payment_accounts
      WHERE active = TRUE AND (gl_account_code IS NULL OR gl_account_code = '')
    `).catch(() => [{ n: 0 }]);
    if (Number(badPay[0]?.n ?? 0) > 0) {
      out.push({
        type: 'payment_account',
        label_ar: 'وسيلة دفع بدون حساب مرتبط',
        severity: 'warning',
        description: `${badPay[0].n} وسيلة دفع نشطة بدون GL code`,
        deeplink: null,
      });
    }

    // 6) Unbalanced JEs (should be 0 — emergency-level if anything)
    const unbal = await this.ds.query(`
      SELECT COUNT(*) AS n FROM (
        SELECT je.id
        FROM journal_entries je
        JOIN journal_lines  jl ON jl.entry_id = je.id
        WHERE je.is_posted = TRUE AND je.is_void = FALSE
        GROUP BY je.id
        HAVING ROUND(SUM(jl.debit), 2) <> ROUND(SUM(jl.credit), 2)
      ) s
    `);
    if (Number(unbal[0]?.n ?? 0) > 0) {
      out.push({
        type: 'journal_entries',
        label_ar: 'قيود غير متوازنة',
        severity: 'critical',
        description: `${unbal[0].n} قيد منشور غير متوازن — تواصل مع الفريق`,
        deeplink: null,
      });
    }

    return out;
  }

  // ─── Quick reports availability map ──────────────────────────────
  private quickReports(): FinanceDashboardResponse['quick_reports'] {
    // Each report's `available` flag mirrors what's actually wired on
    // the frontend today. Anything `false` should render as a disabled
    // placeholder. The labels are exactly as shown in the dashboard
    // image — do not change.
    return [
      // Row A
      { key: 'customer-statement', label_ar: 'كشف عميل',         available: false, href: null },
      { key: 'wallet-statement',   label_ar: 'كشف محفظة',       available: false, href: null },
      { key: 'bank-statement',     label_ar: 'كشف بنك',         available: false, href: null },
      { key: 'cashbox-statement',  label_ar: 'كشف خزنة',        available: false, href: null },
      // Row B
      { key: 'employee-statement', label_ar: 'كشف موظف',        available: false, href: null },
      { key: 'supplier-statement', label_ar: 'كشف مورد',        available: false, href: null },
      { key: 'expenses-report',    label_ar: 'تقرير المصروفات', available: true,  href: '/daily-expenses' },
      { key: 'revenues-report',    label_ar: 'تقرير الإيرادات', available: false, href: null },
      // Row C
      { key: 'balance-sheet',      label_ar: 'تقرير المركز المالي', available: true, href: '/accounts?tab=balance' },
      { key: 'cashflow',           label_ar: 'التدفقات النقدية',    available: false, href: null },
      { key: 'zakat-report',       label_ar: 'تقرير الزكاة',        available: false, href: null },
      { key: 'inventory-report',   label_ar: 'تقرير الجرد',         available: false, href: null },
      // Row D
      { key: 'returns-report',     label_ar: 'تقرير المرتجعات',     available: true, href: '/returns-analytics' },
      { key: 'discounts-report',   label_ar: 'تقرير الخصومات',      available: false, href: null },
      { key: 'profits-report',     label_ar: 'تقرير الأرباح',       available: false, href: null },
      { key: 'audit-trail',        label_ar: 'Audit Trail',         available: false, href: null },
    ];
  }
}

// ─── Helpers (module-private) ─────────────────────────────────────
function round2(n: any): number {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function pct(now: number, prev: number): number {
  if (prev === 0) return now === 0 ? 0 : 100;
  return round2(((now - prev) / Math.abs(prev)) * 100);
}

/**
 * Derives the supplier-balance source label from per-source booleans.
 * 'mixed' = at least two different sources contributed across the
 * supplier set. 'none' = all sources agreed on zero. Otherwise
 * returns the single source that produced data.
 */
function deriveSupplierSource(flags: {
  has_table: boolean;
  has_gl: boolean;
  has_purchase: boolean;
}): 'suppliers_table' | 'gl_211' | 'purchases' | 'mixed' | 'none' {
  const sources = [
    flags.has_table ? 'suppliers_table' : null,
    flags.has_gl ? 'gl_211' : null,
    flags.has_purchase ? 'purchases' : null,
  ].filter(Boolean) as Array<'suppliers_table' | 'gl_211' | 'purchases'>;
  if (sources.length === 0) return 'none';
  if (sources.length === 1) return sources[0];
  return 'mixed';
}

/**
 * Reduces an aggregate row 0 to the `{name, profit}` shape the
 * dashboard cards consume. Returns null when the row is missing or
 * when its profit isn't strictly positive (a "best" with zero or
 * negative profit would mislead the operator).
 */
function pickBest(
  row: { name_ar: string; gross_profit: number } | undefined,
): { name: string; profit: number } | null {
  if (!row) return null;
  const profit = round2(row.gross_profit);
  if (profit <= 0) return null;
  return { name: row.name_ar, profit };
}

const METHOD_LABEL_AR: Record<string, string> = {
  cash: 'نقدي',
  card: 'بطاقات بنكية',
  card_visa: 'بطاقات بنكية',
  card_mastercard: 'بطاقات بنكية',
  card_meeza: 'بطاقات بنكية',
  bank_transfer: 'تحويل بنكي',
  instapay: 'Instapay',
  vodafone_cash: 'Vodafone Cash',
  orange_cash: 'Orange Cash',
  wallet: 'محفظة',
  credit: 'آجل',
  other: 'أخرى',
};

const REF_TYPE_LABEL_AR: Record<string, string> = {
  invoice: 'فاتورة',
  return: 'مرتجع',
  expense: 'مصروف',
  employee_settlement: 'تسوية موظف',
  employee_wage_accrual: 'استحقاق راتب',
  employee_bonus: 'مكافأة',
  employee_deduction: 'خصم',
  shift_variance: 'فرق وردية',
  cashbox_transfer: 'تحويل بين الصناديق',
  opening_balance: 'رصيد افتتاحي',
  manual_adjustment: 'تسوية يدوية',
};
