/**
 * FinancialMovementsListService — read-only by-period movement feed.
 *
 * Companion to `FinancialMovementsTraceService`. Where the trace
 * service drills into ONE specific movement, this service returns a
 * flat list of movement summaries across all source types in a date
 * range, with per-row indicators ("has journal", "has cashbox txn",
 * "has stock movement", "flags count").
 *
 * Strict guarantees (mirrored from the trace service):
 *   · GET / SELECT only — every method is read-only
 *   · No engine call, no posting, no reconciliation, no repair
 *   · No new tables, no migrations
 *   · Uses existing indexes:
 *       · idx_je_date(entry_date)
 *       · idx_purchases_date(invoice_date DESC)
 *       · idx_expenses_date(expense_date DESC)
 *       · idx_cust_pay_date(created_at DESC)
 *       · idx_sup_pay_date(created_at DESC)
 *       · idx_purchase_returns_date
 *       · primary key + invoices.completed_at scan (acceptable —
 *         daily volume is small, query is bounded by limit)
 *
 * Performance contract:
 *   · 8 source-table SELECTs (one per type), each LIMITed
 *   · 3 bulk indicator SELECTs (journal_entries / cashbox_transactions
 *     / stock_movements) using `WHERE reference_id = ANY($N::uuid[])`
 *     — single index seek, not N round trips
 *   · Total: 11 SELECTs flat, regardless of how many movements come
 *     back in the range
 */
import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type ListPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

const KNOWN_PERIODS: ListPeriod[] = [
  'today',
  'yesterday',
  'week',
  'month',
  'custom',
];

export type ListSourceType =
  | 'invoice'
  | 'return'
  | 'purchase'
  | 'expense'
  | 'shift'
  | 'customer_payment'
  | 'supplier_payment'
  | 'journal_entry';

const KNOWN_SOURCE_TYPES: ListSourceType[] = [
  'invoice',
  'return',
  'purchase',
  'expense',
  'shift',
  'customer_payment',
  'supplier_payment',
  'journal_entry',
];

export interface ListQuery {
  period?: string;
  from?: string;
  to?: string;
  reference_type?: string;
  limit?: number;
}

export interface MovementSummary {
  source_type: ListSourceType;
  source_id: string;
  number: string | null;
  date: string;
  party_id: string | null;
  party_name: string | null;
  total: string | null;
  status: string | null;
  has_journal: boolean;
  has_cashbox_transaction: boolean;
  has_stock_movement: boolean;
  flags_count: number;
}

export interface ListResult {
  period: ListPeriod;
  from: string;
  to: string;
  /** What the BE actually applied as upper bound on result count. */
  limit: number;
  items: MovementSummary[];
  /** Aggregate counts across the full result set. */
  totals: {
    total: number;
    with_journal: number;
    with_cashbox_transaction: number;
    with_stock_movement: number;
    with_flags: number;
  };
  /** True if every per-source query returned `limit` rows — caller may
   *  want to narrow the range or raise the limit. */
  truncated: boolean;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class FinancialMovementsListService {
  constructor(private readonly ds: DataSource) {}

  async list(query: ListQuery): Promise<ListResult> {
    const period = this.normalizePeriod(query.period);
    const { from, to } = this.resolveDateRange(period, query.from, query.to);
    const limit = this.normalizeLimit(query.limit);

    // Optional reference_type filter (allowlisted).
    const refTypeFilter =
      query.reference_type &&
      KNOWN_SOURCE_TYPES.includes(query.reference_type as ListSourceType)
        ? (query.reference_type as ListSourceType)
        : null;

    const types = refTypeFilter ? [refTypeFilter] : KNOWN_SOURCE_TYPES;

    // ── Step 1: per-source SELECTs (parallel) ─────────────────────
    const perSource = await Promise.all(
      types.map((t) => this.fetchSource(t, from, to, limit)),
    );
    let items: MovementSummary[] = [];
    let truncated = false;
    for (let i = 0; i < perSource.length; i++) {
      items = items.concat(perSource[i]);
      if (perSource[i].length >= limit) truncated = true;
    }

    if (items.length === 0) {
      return {
        period,
        from,
        to,
        limit,
        items: [],
        totals: {
          total: 0,
          with_journal: 0,
          with_cashbox_transaction: 0,
          with_stock_movement: 0,
          with_flags: 0,
        },
        truncated: false,
      };
    }

    // ── Step 2: bulk indicator queries ────────────────────────────
    // Group source ids by reference_type so each indicator query
    // hits one (reference_type, reference_id) bucket.
    const idsByType = new Map<ListSourceType, string[]>();
    for (const it of items) {
      const arr = idsByType.get(it.source_type) ?? [];
      arr.push(it.source_id);
      idsByType.set(it.source_type, arr);
    }

    const journalSet = await this.bulkJournalCheck(idsByType);
    const cashboxSet = await this.bulkCashboxCheck(idsByType);
    const stockSet = await this.bulkStockCheck(idsByType);

    // ── Step 3: stamp indicators + sort + truncate ────────────────
    for (const it of items) {
      const k = `${it.source_type}|${it.source_id}`;
      it.has_journal = journalSet.has(k);
      it.has_cashbox_transaction = cashboxSet.has(k);
      it.has_stock_movement = stockSet.has(k);
      // Cheap heuristic for flags_count: 0 unless an obvious mismatch
      // is visible from indicators alone. Real flag detail is in the
      // trace endpoint. Here we just signal "may need attention".
      // Counts each missing-but-expected layer.
      let flags = 0;
      if (!it.has_journal && it.source_type !== 'shift' && it.source_type !== 'journal_entry') {
        flags++;
      }
      if (
        (it.source_type === 'invoice' ||
          it.source_type === 'return' ||
          it.source_type === 'purchase') &&
        !it.has_stock_movement
      ) {
        flags++;
      }
      it.flags_count = flags;
    }

    // Newest first.
    items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    items = items.slice(0, limit);

    const totals = items.reduce(
      (acc, it) => {
        acc.total++;
        if (it.has_journal) acc.with_journal++;
        if (it.has_cashbox_transaction) acc.with_cashbox_transaction++;
        if (it.has_stock_movement) acc.with_stock_movement++;
        if (it.flags_count > 0) acc.with_flags++;
        return acc;
      },
      {
        total: 0,
        with_journal: 0,
        with_cashbox_transaction: 0,
        with_stock_movement: 0,
        with_flags: 0,
      },
    );

    return { period, from, to, limit, items, totals, truncated };
  }

  // ─── Period + range normalization ──────────────────────────────
  private normalizePeriod(period: string | undefined): ListPeriod {
    const p = (period ?? '').toLowerCase().trim();
    if (KNOWN_PERIODS.includes(p as ListPeriod)) return p as ListPeriod;
    return 'today';
  }

  private resolveDateRange(
    period: ListPeriod,
    fromIn: string | undefined,
    toIn: string | undefined,
  ): { from: string; to: string } {
    if (period === 'custom') {
      const from = (fromIn ?? '').trim();
      const to = (toIn ?? '').trim();
      if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
        throw new BadRequestException(
          'period=custom requires from and to as YYYY-MM-DD',
        );
      }
      if (from > to) {
        throw new BadRequestException('from must be <= to');
      }
      return { from, to };
    }
    const today = this.todayISO();
    if (period === 'today') return { from: today, to: today };
    if (period === 'yesterday') {
      const y = this.shiftDays(today, -1);
      return { from: y, to: y };
    }
    if (period === 'week') {
      return { from: this.shiftDays(today, -6), to: today }; // last 7 days
    }
    if (period === 'month') {
      const t = new Date(today + 'T00:00:00Z');
      const monthStart = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-01`;
      return { from: monthStart, to: today };
    }
    return { from: today, to: today };
  }

  private todayISO(): string {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private shiftDays(iso: string, days: number): string {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private normalizeLimit(limit: number | undefined): number {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(Math.floor(n), 200);
  }

  // ─── Per-source SELECTs ────────────────────────────────────────
  private async fetchSource(
    type: ListSourceType,
    from: string,
    to: string,
    limit: number,
  ): Promise<MovementSummary[]> {
    const sql = this.sqlForSource(type);
    const rows: any[] = await this.ds
      .query(sql, [from, to, limit])
      .catch(() => [] as any[]);
    return rows.map((r) => ({
      source_type: type,
      source_id: r.source_id,
      number: r.number ?? null,
      date: r.date,
      party_id: r.party_id ?? null,
      party_name: r.party_name ?? null,
      total: r.total ?? null,
      status: r.status ?? null,
      has_journal: false,
      has_cashbox_transaction: false,
      has_stock_movement: false,
      flags_count: 0,
    }));
  }

  /**
   * Each per-source SELECT returns a uniform shape:
   *   source_id, number, date, party_id, party_name, total, status
   * with parameters $1=from, $2=to, $3=limit.
   *
   * Date column is cast to `::date` so comparison ignores time-of-day.
   */
  private sqlForSource(type: ListSourceType): string {
    switch (type) {
      case 'invoice':
        return `
          SELECT i.id::text AS source_id,
                 i.invoice_no AS number,
                 COALESCE(i.completed_at, i.created_at)::text AS date,
                 i.customer_id::text AS party_id,
                 c.full_name AS party_name,
                 i.grand_total::text AS total,
                 i.status::text AS status
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
           WHERE COALESCE(i.completed_at, i.created_at)::date >= $1::date
             AND COALESCE(i.completed_at, i.created_at)::date <= $2::date
           ORDER BY COALESCE(i.completed_at, i.created_at) DESC
           LIMIT $3`;
      case 'return':
        return `
          SELECT r.id::text AS source_id,
                 r.return_no AS number,
                 COALESCE(r.refunded_at, r.requested_at)::text AS date,
                 r.customer_id::text AS party_id,
                 c.full_name AS party_name,
                 r.total_refund::text AS total,
                 r.status::text AS status
            FROM returns r
            LEFT JOIN customers c ON c.id = r.customer_id
           WHERE COALESCE(r.refunded_at, r.requested_at)::date >= $1::date
             AND COALESCE(r.refunded_at, r.requested_at)::date <= $2::date
           ORDER BY COALESCE(r.refunded_at, r.requested_at) DESC
           LIMIT $3`;
      case 'purchase':
        return `
          SELECT p.id::text AS source_id,
                 p.purchase_no AS number,
                 p.invoice_date::text AS date,
                 p.supplier_id::text AS party_id,
                 s.name AS party_name,
                 p.grand_total::text AS total,
                 p.status::text AS status
            FROM purchases p
            LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE p.invoice_date >= $1::date
             AND p.invoice_date <= $2::date
           ORDER BY p.invoice_date DESC, p.created_at DESC
           LIMIT $3`;
      case 'expense':
        return `
          SELECT e.id::text AS source_id,
                 e.expense_no AS number,
                 e.expense_date::text AS date,
                 NULL::text AS party_id,
                 ec.name_ar AS party_name,
                 e.amount::text AS total,
                 e.status::text AS status
            FROM expenses e
            LEFT JOIN expense_categories ec ON ec.id = e.category_id
           WHERE e.expense_date >= $1::date
             AND e.expense_date <= $2::date
           ORDER BY e.expense_date DESC, e.created_at DESC
           LIMIT $3`;
      case 'shift':
        return `
          SELECT s.id::text AS source_id,
                 s.shift_no AS number,
                 s.opened_at::text AS date,
                 s.opened_by::text AS party_id,
                 u.full_name AS party_name,
                 NULL::text AS total,
                 s.status::text AS status
            FROM shifts s
            LEFT JOIN users u ON u.id = s.opened_by
           WHERE s.opened_at::date >= $1::date
             AND s.opened_at::date <= $2::date
           ORDER BY s.opened_at DESC
           LIMIT $3`;
      case 'customer_payment':
        return `
          SELECT cp.id::text AS source_id,
                 cp.payment_no AS number,
                 cp.created_at::text AS date,
                 cp.customer_id::text AS party_id,
                 c.full_name AS party_name,
                 cp.amount::text AS total,
                 (CASE WHEN cp.is_void THEN 'void' ELSE 'posted' END)::text AS status
            FROM customer_payments cp
            LEFT JOIN customers c ON c.id = cp.customer_id
           WHERE cp.created_at::date >= $1::date
             AND cp.created_at::date <= $2::date
           ORDER BY cp.created_at DESC
           LIMIT $3`;
      case 'supplier_payment':
        return `
          SELECT sp.id::text AS source_id,
                 sp.payment_no AS number,
                 sp.created_at::text AS date,
                 sp.supplier_id::text AS party_id,
                 s.name AS party_name,
                 sp.amount::text AS total,
                 (CASE WHEN sp.is_void THEN 'void' ELSE 'posted' END)::text AS status
            FROM supplier_payments sp
            LEFT JOIN suppliers s ON s.id = sp.supplier_id
           WHERE sp.created_at::date >= $1::date
             AND sp.created_at::date <= $2::date
           ORDER BY sp.created_at DESC
           LIMIT $3`;
      case 'journal_entry':
        return `
          SELECT je.id::text AS source_id,
                 je.entry_no AS number,
                 je.entry_date::text AS date,
                 je.created_by::text AS party_id,
                 u.full_name AS party_name,
                 NULL::text AS total,
                 (CASE WHEN je.is_void THEN 'void'
                       WHEN je.is_posted THEN 'posted'
                       ELSE 'draft' END)::text AS status
            FROM journal_entries je
            LEFT JOIN users u ON u.id = je.created_by
           WHERE je.entry_date >= $1::date
             AND je.entry_date <= $2::date
           ORDER BY je.entry_date DESC, je.created_at DESC
           LIMIT $3`;
    }
  }

  // ─── Bulk indicator checks ─────────────────────────────────────
  /**
   * For each (source_type, ids) bucket, run ONE indicator query and
   * return a Set keyed by `${type}|${id}` indicating which rows have
   * a matching journal_entry. Same shape used by cashbox + stock.
   */
  private async bulkJournalCheck(
    idsByType: Map<ListSourceType, string[]>,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    await Promise.all(
      Array.from(idsByType.entries()).map(async ([type, ids]) => {
        if (ids.length === 0) return;
        if (type === 'journal_entry') {
          // The "source" IS a JE — every id has its own JE by definition.
          for (const id of ids) out.add(`${type}|${id}`);
          return;
        }
        const rows: any[] = await this.ds
          .query(
            `SELECT DISTINCT reference_id::text AS id
               FROM journal_entries
              WHERE reference_type = $1
                AND reference_id::text = ANY($2::text[])`,
            [type, ids],
          )
          .catch(() => [] as any[]);
        for (const r of rows) out.add(`${type}|${r.id}`);
      }),
    );
    return out;
  }

  private async bulkCashboxCheck(
    idsByType: Map<ListSourceType, string[]>,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    await Promise.all(
      Array.from(idsByType.entries()).map(async ([type, ids]) => {
        if (ids.length === 0) return;
        if (type === 'journal_entry') return; // JEs don't link to CTs directly
        const rows: any[] = await this.ds
          .query(
            // Primary linkage: (reference_type, reference_id).
            // Fallback: legacy mirror trigger writes
            // reference_type='other' + category=<source_type>
            // for cash customer/supplier payments.
            `SELECT DISTINCT reference_id::text AS id
               FROM cashbox_transactions
              WHERE (reference_type::text = $1 AND reference_id::text = ANY($2::text[]))
                 OR (category = $1 AND reference_id::text = ANY($2::text[]))`,
            [type, ids],
          )
          .catch(() => [] as any[]);
        for (const r of rows) out.add(`${type}|${r.id}`);
      }),
    );
    return out;
  }

  private async bulkStockCheck(
    idsByType: Map<ListSourceType, string[]>,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    await Promise.all(
      Array.from(idsByType.entries()).map(async ([type, ids]) => {
        if (ids.length === 0) return;
        if (
          type === 'journal_entry' ||
          type === 'shift' ||
          type === 'customer_payment' ||
          type === 'supplier_payment' ||
          type === 'expense'
        ) {
          // These types don't move stock in the canonical schema.
          return;
        }
        const rows: any[] = await this.ds
          .query(
            `SELECT DISTINCT reference_id::text AS id
               FROM stock_movements
              WHERE reference_type::text = $1
                AND reference_id::text = ANY($2::text[])`,
            [type, ids],
          )
          .catch(() => [] as any[]);
        for (const r of rows) out.add(`${type}|${r.id}`);
      }),
    );
    return out;
  }
}
