/**
 * FinancialMovementsTraceService — read-only cross-table trace of a
 * single financial movement (invoice / return / purchase / expense /
 * shift / customer_payment / supplier_payment / journal_entry) across
 * the four authoritative tables:
 *
 *   · the source table itself (invoices, returns, purchases, …)
 *   · journal_entries + journal_lines  (general ledger)
 *   · cashbox_transactions              (cashbox / treasury)
 *   · stock_movements                   (inventory)
 *
 * Strict guarantees:
 *   · GET / SELECT only — every method is read-only
 *   · No transaction is started; no engine call; no write of any kind
 *   · No side-effect logging; no posting; no reconciliation; no repair
 *
 * Diagnostic flags are descriptive only — they describe what the
 * traced data looks like, never what to "fix".
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

const LIQUID_GL_CODES = new Set(['1111', '1113', '1114', '1115']);

/** Source-table reference types we know how to resolve. */
export type TraceReferenceType =
  | 'invoice'
  | 'return'
  | 'purchase'
  | 'expense'
  | 'shift'
  | 'customer_payment'
  | 'supplier_payment'
  | 'journal_entry';

const KNOWN_TYPES: TraceReferenceType[] = [
  'invoice',
  'return',
  'purchase',
  'expense',
  'shift',
  'customer_payment',
  'supplier_payment',
  'journal_entry',
];

export interface TraceQuery {
  reference_type?: string;
  reference_id?: string;
  /** Free-form lookup by document number (invoice_no / return_no / …). */
  q?: string;
  /** Optional Idempotency-Key. NOT used to mutate; only echoed back so the
   *  FE can highlight the trace was initiated for this key. */
  idempotency_key?: string;
}

interface SourceRow {
  type: TraceReferenceType;
  id: string;
  number: string | null;
  date: string | null;
  user_id: string | null;
  user_name: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  total: string | null;
  paid: string | null;
  status: string | null;
  warehouse_id?: string | null;
  cashbox_id?: string | null;
  notes?: string | null;
}

interface JournalEntryRow {
  id: string;
  entry_no: string;
  entry_date: string;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  is_posted: boolean;
  is_void: boolean;
  void_reason: string | null;
  reversal_of: string | null;
  posted_by_name: string | null;
  voided_by_name: string | null;
  total_debit: string;
  total_credit: string;
  is_balanced: boolean;
}

interface JournalLineRow {
  id: string;
  entry_id: string;
  line_no: number;
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  debit: string;
  credit: string;
  description: string | null;
  cashbox_id: string | null;
  cashbox_name_ar: string | null;
  warehouse_id: string | null;
}

interface CashboxTxnRow {
  id: number;
  cashbox_id: string;
  cashbox_name_ar: string | null;
  direction: 'in' | 'out';
  amount: string;
  category: string;
  reference_type: string | null;
  reference_id: string | null;
  balance_after: string;
  notes: string | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

interface StockMovementRow {
  id: number;
  variant_id: string;
  variant_sku: string | null;
  product_name_ar: string | null;
  warehouse_id: string;
  warehouse_name_ar: string | null;
  movement_type: string;
  direction: 'in' | 'out';
  quantity: number;
  unit_cost: string;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

export type FlagSeverity = 'info' | 'warning' | 'error';
export interface TraceFlag {
  code: string;
  severity: FlagSeverity;
  message_ar: string;
}

export interface TraceSummary {
  hasJournal: boolean;
  hasCashboxTransaction: boolean;
  hasStockMovement: boolean;
  journalBalanced: boolean | null;
  cashMatched: boolean | null;
  stockMatched: boolean | null;
  source_total: string | null;
  journal_cash_total: string | null;
  cashbox_signed_total: string | null;
}

export interface TraceResult {
  source: SourceRow | null;
  journalEntries: JournalEntryRow[];
  journalLines: JournalLineRow[];
  cashboxTransactions: CashboxTxnRow[];
  stockMovements: StockMovementRow[];
  idempotency: Array<{
    key: string;
    note_ar: string;
  }>;
  flags: TraceFlag[];
  summary: TraceSummary;
}

@Injectable()
export class FinancialMovementsTraceService {
  private readonly logger = new Logger(FinancialMovementsTraceService.name);
  constructor(private readonly ds: DataSource) {}

  /** Public entry point. Resolves the source, then fans out to read-only
   *  queries against the four authoritative tables. */
  async trace(query: TraceQuery): Promise<TraceResult> {
    const empty = (): TraceResult => ({
      source: null,
      journalEntries: [],
      journalLines: [],
      cashboxTransactions: [],
      stockMovements: [],
      idempotency: query.idempotency_key
        ? [
            {
              key: query.idempotency_key,
              note_ar:
                'مفاتيح منع التكرار محفوظة في الذاكرة المؤقتة فقط ولا تظهر في قاعدة البيانات.',
            },
          ]
        : [],
      flags: [
        {
          code: 'SOURCE_NOT_FOUND',
          severity: 'warning',
          message_ar: 'لم يتم العثور على حركة مرتبطة بهذا المرجع.',
        },
      ],
      summary: {
        hasJournal: false,
        hasCashboxTransaction: false,
        hasStockMovement: false,
        journalBalanced: null,
        cashMatched: null,
        stockMatched: null,
        source_total: null,
        journal_cash_total: null,
        cashbox_signed_total: null,
      },
    });

    const source = await this.resolveSource(query);
    if (!source) return empty();

    const [
      journalEntries,
      cashboxTransactions,
      stockMovements,
    ] = await Promise.all([
      this.fetchJournalEntries(source),
      this.fetchCashboxTransactions(source),
      this.fetchStockMovements(source),
    ]);

    const journalLines =
      journalEntries.length > 0
        ? await this.fetchJournalLines(journalEntries.map((e) => e.id))
        : [];

    const flags = this.computeFlags(
      source,
      journalEntries,
      journalLines,
      cashboxTransactions,
      stockMovements,
    );

    const summary = this.computeSummary(
      source,
      journalEntries,
      journalLines,
      cashboxTransactions,
      stockMovements,
    );

    const idempotency = query.idempotency_key
      ? [
          {
            key: query.idempotency_key,
            note_ar:
              'مفاتيح منع التكرار محفوظة في الذاكرة المؤقتة فقط ولا تظهر في قاعدة البيانات.',
          },
        ]
      : [];

    return {
      source,
      journalEntries,
      journalLines,
      cashboxTransactions,
      stockMovements,
      idempotency,
      flags,
      summary,
    };
  }

  // ─── Source resolution ──────────────────────────────────────────
  private async resolveSource(query: TraceQuery): Promise<SourceRow | null> {
    const t = (query.reference_type || '').toLowerCase().trim();
    const id = (query.reference_id || '').trim();
    const q = (query.q || '').trim();

    // Path 1: explicit reference_type + reference_id (UUID).
    if (t && id && KNOWN_TYPES.includes(t as TraceReferenceType)) {
      return this.lookupSource(t as TraceReferenceType, id, false);
    }

    // Path 2: explicit reference_type + free-form number (q).
    if (t && q && KNOWN_TYPES.includes(t as TraceReferenceType)) {
      return this.lookupSource(t as TraceReferenceType, q, true);
    }

    // Path 3: free-form q only — try to guess the type from the prefix.
    if (q) {
      const guess = this.guessTypeFromNumber(q);
      if (guess) return this.lookupSource(guess, q, true);
      // Last resort: try every type by number until one matches. Cheap
      // because each query is a single indexed lookup.
      for (const candidate of KNOWN_TYPES) {
        const row = await this.lookupSource(candidate, q, true);
        if (row) return row;
      }
    }

    return null;
  }

  private guessTypeFromNumber(q: string): TraceReferenceType | null {
    const upper = q.toUpperCase();
    if (upper.startsWith('INV-')) return 'invoice';
    if (upper.startsWith('RET-')) return 'return';
    if (upper.startsWith('PO-') || upper.startsWith('PUR-')) return 'purchase';
    if (upper.startsWith('EXP-')) return 'expense';
    if (upper.startsWith('SHF-')) return 'shift';
    if (upper.startsWith('JE-') || upper.startsWith('JV-')) return 'journal_entry';
    return null;
  }

  private async lookupSource(
    type: TraceReferenceType,
    needle: string,
    isNumber: boolean,
  ): Promise<SourceRow | null> {
    const sqlByType: Record<TraceReferenceType, string> = {
      invoice: `
        SELECT i.id, i.invoice_no AS number, i.completed_at AS date,
               i.cashier_id AS user_id, u.full_name AS user_name,
               i.customer_id, c.full_name AS customer_name,
               NULL::uuid AS supplier_id, NULL::text AS supplier_name,
               i.grand_total AS total, i.paid_amount AS paid,
               i.status::text AS status,
               i.warehouse_id, NULL::uuid AS cashbox_id, NULL::text AS notes
          FROM invoices i
          LEFT JOIN users u ON u.id = i.cashier_id
          LEFT JOIN customers c ON c.id = i.customer_id
         WHERE ${isNumber ? 'i.invoice_no = $1' : 'i.id::text = $1'}
         LIMIT 1`,
      return: `
        SELECT r.id, r.return_no AS number, r.refunded_at AS date,
               r.refunded_by AS user_id, u.full_name AS user_name,
               r.customer_id, c.full_name AS customer_name,
               NULL::uuid AS supplier_id, NULL::text AS supplier_name,
               r.total_refund AS total, r.total_refund AS paid,
               r.status::text AS status,
               r.warehouse_id, r.cashbox_id, r.notes
          FROM returns r
          LEFT JOIN users u ON u.id = r.refunded_by
          LEFT JOIN customers c ON c.id = r.customer_id
         WHERE ${isNumber ? 'r.return_no = $1' : 'r.id::text = $1'}
         LIMIT 1`,
      purchase: `
        SELECT p.id, p.purchase_no AS number, p.invoice_date::text AS date,
               p.created_by AS user_id, u.full_name AS user_name,
               NULL::uuid AS customer_id, NULL::text AS customer_name,
               p.supplier_id, s.name AS supplier_name,
               p.grand_total AS total, p.paid_amount AS paid,
               p.status::text AS status,
               p.warehouse_id, NULL::uuid AS cashbox_id, NULL::text AS notes
          FROM purchases p
          LEFT JOIN users u ON u.id = p.created_by
          LEFT JOIN suppliers s ON s.id = p.supplier_id
         WHERE ${isNumber ? 'p.purchase_no = $1' : 'p.id::text = $1'}
         LIMIT 1`,
      expense: `
        SELECT e.id, e.expense_no AS number, e.expense_date::text AS date,
               e.created_by AS user_id, u.full_name AS user_name,
               NULL::uuid AS customer_id, NULL::text AS customer_name,
               NULL::uuid AS supplier_id, NULL::text AS supplier_name,
               e.amount AS total, e.amount AS paid,
               e.status::text AS status,
               e.warehouse_id, e.cashbox_id, e.notes
          FROM expenses e
          LEFT JOIN users u ON u.id = e.created_by
         WHERE ${isNumber ? 'e.expense_no = $1' : 'e.id::text = $1'}
         LIMIT 1`,
      shift: `
        SELECT s.id, s.shift_no AS number, s.opened_at::text AS date,
               s.opened_by AS user_id, u.full_name AS user_name,
               NULL::uuid AS customer_id, NULL::text AS customer_name,
               NULL::uuid AS supplier_id, NULL::text AS supplier_name,
               NULL::numeric AS total, NULL::numeric AS paid,
               s.status::text AS status,
               s.warehouse_id, s.cashbox_id, NULL::text AS notes
          FROM shifts s
          LEFT JOIN users u ON u.id = s.opened_by
         WHERE ${isNumber ? 's.shift_no = $1' : 's.id::text = $1'}
         LIMIT 1`,
      customer_payment: `
        SELECT cp.id, cp.payment_no AS number, cp.created_at::text AS date,
               cp.received_by AS user_id, u.full_name AS user_name,
               cp.customer_id, c.full_name AS customer_name,
               NULL::uuid AS supplier_id, NULL::text AS supplier_name,
               cp.amount AS total, cp.amount AS paid,
               (CASE WHEN cp.is_void THEN 'void' ELSE 'posted' END)::text AS status,
               NULL::uuid AS warehouse_id, cp.cashbox_id, cp.notes
          FROM customer_payments cp
          LEFT JOIN users u ON u.id = cp.received_by
          LEFT JOIN customers c ON c.id = cp.customer_id
         WHERE ${isNumber ? 'cp.payment_no = $1' : 'cp.id::text = $1'}
         LIMIT 1`,
      supplier_payment: `
        SELECT sp.id, sp.payment_no AS number, sp.created_at::text AS date,
               sp.paid_by AS user_id, u.full_name AS user_name,
               NULL::uuid AS customer_id, NULL::text AS customer_name,
               sp.supplier_id, s.name AS supplier_name,
               sp.amount AS total, sp.amount AS paid,
               (CASE WHEN sp.is_void THEN 'void' ELSE 'posted' END)::text AS status,
               NULL::uuid AS warehouse_id, sp.cashbox_id, sp.notes
          FROM supplier_payments sp
          LEFT JOIN users u ON u.id = sp.paid_by
          LEFT JOIN suppliers s ON s.id = sp.supplier_id
         WHERE ${isNumber ? 'sp.payment_no = $1' : 'sp.id::text = $1'}
         LIMIT 1`,
      journal_entry: `
        SELECT je.id, je.entry_no AS number, je.entry_date::text AS date,
               je.created_by AS user_id, u.full_name AS user_name,
               NULL::uuid AS customer_id, NULL::text AS customer_name,
               NULL::uuid AS supplier_id, NULL::text AS supplier_name,
               NULL::numeric AS total, NULL::numeric AS paid,
               (CASE WHEN je.is_void THEN 'void'
                     WHEN je.is_posted THEN 'posted'
                     ELSE 'draft' END)::text AS status,
               NULL::uuid AS warehouse_id, NULL::uuid AS cashbox_id,
               je.description AS notes
          FROM journal_entries je
          LEFT JOIN users u ON u.id = je.created_by
         WHERE ${isNumber ? 'je.entry_no = $1' : 'je.id::text = $1'}
         LIMIT 1`,
    };
    const rows: any[] = await this.ds
      .query(sqlByType[type], [needle])
      .catch((err) => {
        // A wrong-shape needle (e.g. an invoice_no passed where UUID was
        // expected) raises a parse error in PG. Treat as no-match instead
        // of bubbling the 500 to the client.
        this.logger.debug(
          `lookupSource(${type}, isNumber=${isNumber}) suppressed PG error: ${err?.message ?? err}`,
        );
        return [];
      });
    if (!rows.length) return null;
    return { type, ...rows[0] } as SourceRow;
  }

  // ─── Linkage queries ────────────────────────────────────────────
  private async fetchJournalEntries(
    source: SourceRow,
  ): Promise<JournalEntryRow[]> {
    if (source.type === 'journal_entry') {
      // The source IS the JE. Surface it as the entry directly.
      return this.ds.query(
        `SELECT je.id, je.entry_no, je.entry_date::text, je.description,
                je.reference_type, je.reference_id::text,
                je.is_posted, je.is_void, je.void_reason, je.reversal_of::text,
                pu.full_name AS posted_by_name,
                vu.full_name AS voided_by_name,
                COALESCE((SELECT SUM(jl.debit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)::text AS total_debit,
                COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)::text AS total_credit,
                (
                  COALESCE((SELECT SUM(jl.debit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)
                  =
                  COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)
                ) AS is_balanced
           FROM journal_entries je
           LEFT JOIN users pu ON pu.id = je.posted_by
           LEFT JOIN users vu ON vu.id = je.voided_by
          WHERE je.id = $1`,
        [source.id],
      );
    }
    return this.ds.query(
      `SELECT je.id, je.entry_no, je.entry_date::text, je.description,
              je.reference_type, je.reference_id::text,
              je.is_posted, je.is_void, je.void_reason, je.reversal_of::text,
              pu.full_name AS posted_by_name,
              vu.full_name AS voided_by_name,
              COALESCE((SELECT SUM(jl.debit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)::text AS total_debit,
              COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)::text AS total_credit,
              (
                COALESCE((SELECT SUM(jl.debit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)
                =
                COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)
              ) AS is_balanced
         FROM journal_entries je
         LEFT JOIN users pu ON pu.id = je.posted_by
         LEFT JOIN users vu ON vu.id = je.voided_by
        WHERE je.reference_type = $1
          AND je.reference_id::text = $2
        ORDER BY je.entry_date ASC, je.created_at ASC`,
      [source.type, source.id],
    );
  }

  private async fetchJournalLines(entryIds: string[]): Promise<JournalLineRow[]> {
    if (entryIds.length === 0) return [];
    return this.ds.query(
      `SELECT jl.id, jl.entry_id, jl.line_no,
              jl.account_id::text, coa.code AS account_code, coa.name_ar AS account_name,
              jl.debit::text, jl.credit::text, jl.description,
              jl.cashbox_id::text, cb.name_ar AS cashbox_name_ar,
              jl.warehouse_id::text
         FROM journal_lines jl
         LEFT JOIN chart_of_accounts coa ON coa.id = jl.account_id
         LEFT JOIN cashboxes cb ON cb.id = jl.cashbox_id
        WHERE jl.entry_id = ANY($1::uuid[])
        ORDER BY jl.entry_id, jl.line_no`,
      [entryIds],
    );
  }

  private async fetchCashboxTransactions(
    source: SourceRow,
  ): Promise<CashboxTxnRow[]> {
    // Primary linkage: (reference_type, reference_id). For the legacy
    // mirror trigger that stamps `reference_type='other'` +
    // `category='customer_payment'` (or 'supplier_payment'), we also
    // accept rows linked solely by reference_id + matching category.
    const rows: CashboxTxnRow[] = await this.ds.query(
      `SELECT t.id, t.cashbox_id::text, cb.name_ar AS cashbox_name_ar,
              t.direction::text, t.amount::text, t.category,
              t.reference_type::text, t.reference_id::text,
              t.balance_after::text, t.notes,
              t.user_id::text, u.full_name AS user_name,
              t.created_at::text
         FROM cashbox_transactions t
         LEFT JOIN cashboxes cb ON cb.id = t.cashbox_id
         LEFT JOIN users u ON u.id = t.user_id
        WHERE (t.reference_type::text = $1 AND t.reference_id::text = $2)
           OR (t.reference_id::text = $2 AND t.category = $1)
        ORDER BY t.created_at ASC, t.id ASC`,
      [source.type, source.id],
    );
    return rows;
  }

  private async fetchStockMovements(
    source: SourceRow,
  ): Promise<StockMovementRow[]> {
    if (source.type === 'journal_entry') return [];
    return this.ds.query(
      `SELECT sm.id, sm.variant_id::text, pv.sku AS variant_sku,
              p.name_ar AS product_name_ar,
              sm.warehouse_id::text, w.name_ar AS warehouse_name_ar,
              sm.movement_type::text, sm.direction::text,
              sm.quantity, sm.unit_cost::text,
              sm.reference_type::text, sm.reference_id::text,
              sm.notes, sm.user_id::text, u.full_name AS user_name,
              sm.created_at::text
         FROM stock_movements sm
         LEFT JOIN product_variants pv ON pv.id = sm.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
         LEFT JOIN warehouses w ON w.id = sm.warehouse_id
         LEFT JOIN users u ON u.id = sm.user_id
        WHERE sm.reference_type::text = $1
          AND sm.reference_id::text = $2
        ORDER BY sm.created_at ASC, sm.id ASC`,
      [source.type, source.id],
    );
  }

  // ─── Flags + summary ────────────────────────────────────────────
  private computeFlags(
    source: SourceRow,
    je: JournalEntryRow[],
    jl: JournalLineRow[],
    ct: CashboxTxnRow[],
    sm: StockMovementRow[],
  ): TraceFlag[] {
    const flags: TraceFlag[] = [];

    const expectsJournal =
      source.type !== 'shift' && source.type !== 'journal_entry';
    const expectsStock =
      source.type === 'invoice' ||
      source.type === 'return' ||
      source.type === 'purchase';
    const sourceHasCashboxLink =
      !!source.cashbox_id || source.type === 'invoice';

    // 1. Missing JE (when one should exist).
    if (expectsJournal && je.length === 0) {
      flags.push({
        code: 'JE_MISSING',
        severity: 'error',
        message_ar: 'لا يوجد قيد محاسبي مرتبط بهذه الحركة.',
      });
    }

    // 2. Per-entry checks.
    for (const e of je) {
      const lines = jl.filter((l) => l.entry_id === e.id);
      if (lines.length === 0) {
        flags.push({
          code: 'JE_LINES_MISSING',
          severity: 'error',
          message_ar: `القيد ${e.entry_no} موجود بدون سطور.`,
        });
      }
      if (!e.is_balanced) {
        flags.push({
          code: 'JE_UNBALANCED',
          severity: 'error',
          message_ar: `القيد ${e.entry_no} غير متوازن (مدين ≠ دائن).`,
        });
      }
      if (e.is_void && !e.reversal_of) {
        flags.push({
          code: 'JE_VOID_NO_REVERSAL',
          severity: 'warning',
          message_ar: `القيد ${e.entry_no} ملغى بدون قيد عكسي مرتبط.`,
        });
      }
    }

    // 3. Missing CT for cash GL lines.
    const cashLines = jl.filter(
      (l) =>
        l.account_code &&
        LIQUID_GL_CODES.has(l.account_code) &&
        l.cashbox_id,
    );
    for (const cl of cashLines) {
      const signed = Number(cl.debit) - Number(cl.credit);
      const matches = ct.find((t) => {
        if (t.cashbox_id !== cl.cashbox_id) return false;
        const tSigned = (t.direction === 'in' ? 1 : -1) * Number(t.amount);
        return Math.abs(tSigned - signed) < 0.01;
      });
      if (!matches) {
        flags.push({
          code: 'GL_CASH_NO_PAIRED_CT',
          severity: 'error',
          message_ar: `سطر القيد على حساب نقدي ${cl.account_code} بدون حركة خزينة مقابلة.`,
        });
      }
    }

    // 4. Cashbox transaction without matching JE leg.
    for (const t of ct) {
      const tSigned = (t.direction === 'in' ? 1 : -1) * Number(t.amount);
      const found = jl.find(
        (l) =>
          l.cashbox_id === t.cashbox_id &&
          Math.abs(Number(l.debit) - Number(l.credit) - tSigned) < 0.01,
      );
      if (!found && je.length > 0) {
        flags.push({
          code: 'CT_NO_PAIRED_GL',
          severity: 'warning',
          message_ar: `حركة خزينة بقيمة ${t.amount} (${t.direction}) بدون سطر قيد مقابل.`,
        });
      }
    }

    // 5. Source-side cashbox-but-no-CT.
    if (sourceHasCashboxLink && ct.length === 0 && expectsJournal) {
      flags.push({
        code: 'CT_MISSING',
        severity: 'warning',
        message_ar: 'الحركة الأصلية مرتبطة بخزينة لكن لا توجد حركة خزينة مسجلة.',
      });
    }

    // 6. Missing stock movement (when one should exist).
    if (expectsStock && sm.length === 0) {
      flags.push({
        code: 'STOCK_MOVEMENT_MISSING',
        severity: 'warning',
        message_ar: 'لا توجد حركة مخزون مسجلة لهذه العملية.',
      });
    }

    // 7. Source total vs JE cash total mismatch (best-effort).
    if (source.total && cashLines.length > 0) {
      const cashTotal = cashLines.reduce(
        (s, l) => s + Math.abs(Number(l.debit) - Number(l.credit)),
        0,
      );
      const sourceTotal = Math.abs(Number(source.total));
      if (sourceTotal > 0 && Math.abs(cashTotal - sourceTotal) > 0.01) {
        flags.push({
          code: 'SOURCE_VS_JE_CASH_MISMATCH',
          severity: 'info',
          message_ar:
            'إجمالي الحركة الأصلية مختلف عن إجمالي الجزء النقدي في القيد. قد يكون السبب طرق دفع مختلطة.',
        });
      }
    }

    // 8. Reference type mismatch on linked JE.
    for (const e of je) {
      if (
        e.reference_type &&
        e.reference_type.toLowerCase() !== source.type
      ) {
        flags.push({
          code: 'JE_REFERENCE_TYPE_MISMATCH',
          severity: 'info',
          message_ar: `القيد ${e.entry_no} يربط بنوع مرجع مختلف (${e.reference_type}).`,
        });
      }
    }

    // 9. Stock movement without source (orphan check — stock_movements
    // referring to a missing source row).
    if (sm.length > 0 && !source) {
      flags.push({
        code: 'STOCK_NO_SOURCE',
        severity: 'warning',
        message_ar: 'حركة مخزون موجودة بدون حركة أصل مطابقة.',
      });
    }

    return flags;
  }

  private computeSummary(
    source: SourceRow,
    je: JournalEntryRow[],
    jl: JournalLineRow[],
    ct: CashboxTxnRow[],
    sm: StockMovementRow[],
  ): TraceSummary {
    const hasJournal = je.length > 0;
    const hasCashboxTransaction = ct.length > 0;
    const hasStockMovement = sm.length > 0;
    const journalBalanced = hasJournal ? je.every((e) => e.is_balanced) : null;

    // Cash matched: every cash GL leg has a paired CT row, AND every CT
    // has a paired GL leg.
    let cashMatched: boolean | null = null;
    if (jl.length > 0 || ct.length > 0) {
      const cashLines = jl.filter(
        (l) =>
          l.account_code &&
          LIQUID_GL_CODES.has(l.account_code) &&
          l.cashbox_id,
      );
      if (cashLines.length === 0 && ct.length === 0) {
        cashMatched = null;
      } else {
        const allLinesPaired = cashLines.every((cl) => {
          const signed = Number(cl.debit) - Number(cl.credit);
          return ct.some((t) => {
            if (t.cashbox_id !== cl.cashbox_id) return false;
            const tSigned = (t.direction === 'in' ? 1 : -1) * Number(t.amount);
            return Math.abs(tSigned - signed) < 0.01;
          });
        });
        cashMatched = allLinesPaired;
      }
    }

    const stockMatched =
      source.type === 'invoice' ||
      source.type === 'return' ||
      source.type === 'purchase'
        ? sm.length > 0
        : null;

    const cashboxSigned = ct.reduce(
      (s, t) => s + (t.direction === 'in' ? 1 : -1) * Number(t.amount),
      0,
    );
    const journalCashTotal = jl
      .filter(
        (l) =>
          l.account_code && LIQUID_GL_CODES.has(l.account_code) && l.cashbox_id,
      )
      .reduce((s, l) => s + (Number(l.debit) - Number(l.credit)), 0);

    return {
      hasJournal,
      hasCashboxTransaction,
      hasStockMovement,
      journalBalanced,
      cashMatched,
      stockMatched,
      source_total: source.total ?? null,
      journal_cash_total:
        jl.length > 0 ? journalCashTotal.toFixed(2) : null,
      cashbox_signed_total:
        ct.length > 0 ? cashboxSigned.toFixed(2) : null,
    };
  }
}
