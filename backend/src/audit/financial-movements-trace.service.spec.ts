/**
 * FinancialMovementsTraceService — unit tests
 *
 * Strict guarantees pinned by these tests:
 *   · Service is read-only — every code path under test issues only
 *     SELECT statements through `DataSource.query`. No INSERT/UPDATE/
 *     DELETE/TRUNCATE is ever executed.
 *   · Empty / not-found inputs return a structured empty result with
 *     a `SOURCE_NOT_FOUND` flag.
 *   · Successful traces return the full shape: source, journalEntries,
 *     journalLines, cashboxTransactions, stockMovements, idempotency,
 *     flags, summary.
 *   · Diagnostic flags (`JE_MISSING`, `JE_UNBALANCED`,
 *     `GL_CASH_NO_PAIRED_CT`) fire correctly on synthetic data.
 *   · The service NEVER returns a "fix" / "repair" / mutation hint;
 *     flag messages are purely descriptive.
 */
import { FinancialMovementsTraceService } from './financial-movements-trace.service';

/** Tiny DataSource stub that returns FIFO answers for `query()` calls
 *  and records every call so we can assert SQL safety. */
function makeDsStub(results: any[][]) {
  let i = 0;
  const calls: Array<{ sql: string; params: any[] }> = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const next = results[i++];
      return next ?? [];
    }),
  };
  return { ds, calls };
}

describe('FinancialMovementsTraceService — read-only', () => {
  it('returns SOURCE_NOT_FOUND when no source resolves', async () => {
    const { ds } = makeDsStub([
      // Path 3: free-form q lookup tries every type — all return [].
      [], [], [], [], [], [], [], [],
    ]);
    const svc = new FinancialMovementsTraceService(ds);

    const res = await svc.trace({ q: 'NOT-A-REAL-NUMBER' });

    expect(res.source).toBeNull();
    expect(res.journalEntries).toEqual([]);
    expect(res.journalLines).toEqual([]);
    expect(res.cashboxTransactions).toEqual([]);
    expect(res.stockMovements).toEqual([]);
    expect(res.flags.find((f) => f.code === 'SOURCE_NOT_FOUND')).toBeDefined();
    expect(res.summary).toMatchObject({
      hasJournal: false,
      hasCashboxTransaction: false,
      hasStockMovement: false,
    });
  });

  it('every executed SQL statement is a SELECT (no mutation)', async () => {
    const { ds, calls } = makeDsStub([
      // 1: source lookup (invoice)
      [
        {
          id: 'inv-1',
          number: 'INV-2026-000001',
          date: '2026-04-30',
          user_id: null,
          user_name: null,
          customer_id: null,
          customer_name: null,
          supplier_id: null,
          supplier_name: null,
          total: '100.00',
          paid: '100.00',
          status: 'paid',
          warehouse_id: null,
          cashbox_id: null,
          notes: null,
        },
      ],
      // 2: journal_entries
      [],
      // 3: cashbox_transactions
      [],
      // 4: stock_movements
      [],
      // (no journal_lines fetch because no JE)
    ]);
    const svc = new FinancialMovementsTraceService(ds);

    await svc.trace({ reference_type: 'invoice', reference_id: 'inv-1' });

    for (const c of calls) {
      const trimmed = c.sql.trim().toUpperCase();
      // Must start with SELECT or WITH (CTEs); never DML.
      expect(/^SELECT|^WITH/.test(trimmed)).toBe(true);
      expect(/\bINSERT\s+INTO\b/.test(trimmed)).toBe(false);
      expect(/\bUPDATE\s+\w+\s+SET\b/.test(trimmed)).toBe(false);
      expect(/\bDELETE\s+FROM\b/.test(trimmed)).toBe(false);
      expect(/\bTRUNCATE\b/.test(trimmed)).toBe(false);
      expect(/\bDROP\b/.test(trimmed)).toBe(false);
      expect(/\bALTER\b/.test(trimmed)).toBe(false);
    }
  });

  it('returns the full shape on a successful invoice trace', async () => {
    const sourceRow = {
      id: 'inv-1',
      number: 'INV-2026-000001',
      date: '2026-04-30',
      user_id: 'u-1',
      user_name: 'كاشير',
      customer_id: 'c-1',
      customer_name: 'عميل تجريبي',
      supplier_id: null,
      supplier_name: null,
      total: '100.00',
      paid: '100.00',
      status: 'paid',
      warehouse_id: 'w-1',
      cashbox_id: null,
      notes: null,
    };
    const jeRow = {
      id: 'je-1',
      entry_no: 'JV-2026-000001',
      entry_date: '2026-04-30',
      description: 'فاتورة مبيعات',
      reference_type: 'invoice',
      reference_id: 'inv-1',
      is_posted: true,
      is_void: false,
      void_reason: null,
      reversal_of: null,
      posted_by_name: 'كاشير',
      voided_by_name: null,
      total_debit: '100.00',
      total_credit: '100.00',
      is_balanced: true,
    };
    const jlRows = [
      {
        id: 'jl-1',
        entry_id: 'je-1',
        line_no: 1,
        account_id: 'acc-1111',
        account_code: '1111',
        account_name: 'الخزينة الرئيسية',
        debit: '100.00',
        credit: '0.00',
        description: 'كاش',
        cashbox_id: 'cb-1',
        cashbox_name_ar: 'الخزينة الرئيسية',
        warehouse_id: null,
      },
      {
        id: 'jl-2',
        entry_id: 'je-1',
        line_no: 2,
        account_id: 'acc-411',
        account_code: '411',
        account_name: 'إيرادات المبيعات',
        debit: '0.00',
        credit: '100.00',
        description: 'إيراد',
        cashbox_id: null,
        cashbox_name_ar: null,
        warehouse_id: null,
      },
    ];
    const ctRows = [
      {
        id: 12345,
        cashbox_id: 'cb-1',
        cashbox_name_ar: 'الخزينة الرئيسية',
        direction: 'in' as const,
        amount: '100.00',
        category: 'sale',
        reference_type: 'invoice',
        reference_id: 'inv-1',
        balance_after: '500.00',
        notes: 'بيع',
        user_id: 'u-1',
        user_name: 'كاشير',
        created_at: '2026-04-30T10:00:00Z',
      },
    ];
    const smRows = [
      {
        id: 22222,
        variant_id: 'v-1',
        variant_sku: 'SKU-1',
        product_name_ar: 'منتج تجريبي',
        warehouse_id: 'w-1',
        warehouse_name_ar: 'المخزن الرئيسي',
        movement_type: 'sale',
        direction: 'out' as const,
        quantity: 1,
        unit_cost: '60.00',
        reference_type: 'invoice',
        reference_id: 'inv-1',
        notes: null,
        user_id: 'u-1',
        user_name: 'كاشير',
        created_at: '2026-04-30T10:00:00Z',
      },
    ];
    const { ds } = makeDsStub([
      [sourceRow], // 1) source
      [jeRow],     // 2) journal_entries
      ctRows,      // 3) cashbox_transactions
      smRows,      // 4) stock_movements
      jlRows,      // 5) journal_lines
    ]);
    const svc = new FinancialMovementsTraceService(ds);

    const res = await svc.trace({
      reference_type: 'invoice',
      reference_id: 'inv-1',
    });

    expect(res.source?.type).toBe('invoice');
    expect(res.source?.id).toBe('inv-1');
    expect(res.journalEntries).toHaveLength(1);
    expect(res.journalLines).toHaveLength(2);
    expect(res.cashboxTransactions).toHaveLength(1);
    expect(res.stockMovements).toHaveLength(1);
    expect(res.summary).toMatchObject({
      hasJournal: true,
      hasCashboxTransaction: true,
      hasStockMovement: true,
      journalBalanced: true,
      cashMatched: true,
      stockMatched: true,
    });
    // Healthy invoice has zero error-severity flags.
    expect(res.flags.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('flags JE_MISSING when source exists but no journal entry', async () => {
    const sourceRow = {
      id: 'inv-2',
      number: 'INV-2026-000002',
      date: '2026-04-30',
      user_id: null,
      user_name: null,
      customer_id: null,
      customer_name: null,
      supplier_id: null,
      supplier_name: null,
      total: '50.00',
      paid: '50.00',
      status: 'paid',
      warehouse_id: 'w-1',
      cashbox_id: null,
      notes: null,
    };
    const { ds } = makeDsStub([
      [sourceRow],
      [], // journal_entries
      [], // cashbox_transactions
      [], // stock_movements
    ]);
    const svc = new FinancialMovementsTraceService(ds);

    const res = await svc.trace({
      reference_type: 'invoice',
      reference_id: 'inv-2',
    });

    expect(res.flags.find((f) => f.code === 'JE_MISSING')).toMatchObject({
      severity: 'error',
    });
  });

  it('flags GL_CASH_NO_PAIRED_CT when cash GL line has no matching CT', async () => {
    const sourceRow = {
      id: 'inv-3',
      number: 'INV-X',
      date: '2026-04-30',
      user_id: null,
      user_name: null,
      customer_id: null,
      customer_name: null,
      supplier_id: null,
      supplier_name: null,
      total: '150.00',
      paid: '150.00',
      status: 'paid',
      warehouse_id: 'w-1',
      cashbox_id: null,
      notes: null,
    };
    const jeRow = {
      id: 'je-3',
      entry_no: 'JV-X',
      entry_date: '2026-04-30',
      description: null,
      reference_type: 'invoice',
      reference_id: 'inv-3',
      is_posted: true,
      is_void: false,
      void_reason: null,
      reversal_of: null,
      posted_by_name: null,
      voided_by_name: null,
      total_debit: '150.00',
      total_credit: '150.00',
      is_balanced: true,
    };
    // Cash leg DR 1111 = 150, cashbox 'cb-1', BUT no CT pairs it.
    const jlRows = [
      {
        id: 'jl-1', entry_id: 'je-3', line_no: 1,
        account_id: 'acc-1111', account_code: '1111',
        account_name: 'الخزينة', debit: '150.00', credit: '0.00',
        description: 'كاش', cashbox_id: 'cb-1', cashbox_name_ar: 'الخزينة',
        warehouse_id: null,
      },
      {
        id: 'jl-2', entry_id: 'je-3', line_no: 2,
        account_id: 'acc-411', account_code: '411',
        account_name: 'إيرادات', debit: '0.00', credit: '150.00',
        description: null, cashbox_id: null, cashbox_name_ar: null,
        warehouse_id: null,
      },
    ];
    const { ds } = makeDsStub([
      [sourceRow],
      [jeRow],
      [], // cashbox_transactions — EMPTY → triggers GL_CASH_NO_PAIRED_CT
      [], // stock_movements
      jlRows,
    ]);
    const svc = new FinancialMovementsTraceService(ds);

    const res = await svc.trace({
      reference_type: 'invoice',
      reference_id: 'inv-3',
    });

    expect(
      res.flags.find((f) => f.code === 'GL_CASH_NO_PAIRED_CT'),
    ).toMatchObject({ severity: 'error' });
    expect(res.summary.cashMatched).toBe(false);
  });

  it('flags JE_UNBALANCED when sum debit != sum credit', async () => {
    const sourceRow = {
      id: 'inv-4',
      number: 'INV-Y',
      date: '2026-04-30',
      user_id: null,
      user_name: null,
      customer_id: null,
      customer_name: null,
      supplier_id: null,
      supplier_name: null,
      total: '100.00',
      paid: '100.00',
      status: 'paid',
      warehouse_id: 'w-1',
      cashbox_id: null,
      notes: null,
    };
    const jeRow = {
      id: 'je-4',
      entry_no: 'JV-Y',
      entry_date: '2026-04-30',
      description: null,
      reference_type: 'invoice',
      reference_id: 'inv-4',
      is_posted: true,
      is_void: false,
      void_reason: null,
      reversal_of: null,
      posted_by_name: null,
      voided_by_name: null,
      total_debit: '100.00',
      total_credit: '90.00',
      is_balanced: false, // intentionally unbalanced
    };
    const { ds } = makeDsStub([[sourceRow], [jeRow], [], [], []]);
    const svc = new FinancialMovementsTraceService(ds);

    const res = await svc.trace({
      reference_type: 'invoice',
      reference_id: 'inv-4',
    });

    expect(res.flags.find((f) => f.code === 'JE_UNBALANCED')).toMatchObject({
      severity: 'error',
    });
    expect(res.summary.journalBalanced).toBe(false);
  });

  it('flag messages are descriptive only — never include repair verbs', async () => {
    const sourceRow = {
      id: 'inv-5', number: 'INV-Z', date: '2026-04-30',
      user_id: null, user_name: null, customer_id: null,
      customer_name: null, supplier_id: null, supplier_name: null,
      total: '50.00', paid: '50.00', status: 'paid',
      warehouse_id: null, cashbox_id: null, notes: null,
    };
    const { ds } = makeDsStub([[sourceRow], [], [], []]);
    const svc = new FinancialMovementsTraceService(ds);

    const res = await svc.trace({
      reference_type: 'invoice',
      reference_id: 'inv-5',
    });

    // None of the flag messages should contain repair / mutation verbs.
    const FORBIDDEN = [
      /\bإصلاح\b/, /\bأصلح\b/, /\bتصحيح\b/, /\bأعد\b/, /\bأعِد\b/,
      /\bأنشئ\b/, /\bأنشِئ\b/, /\bاحذف\b/, /\bاعتمد\b/, /\bرحّل\b/, /\bرحل\b/,
    ];
    for (const flag of res.flags) {
      for (const re of FORBIDDEN) {
        expect(flag.message_ar).not.toMatch(re);
      }
    }
  });

  it('idempotency_key is echoed back read-only when provided', async () => {
    const { ds } = makeDsStub([
      // SOURCE_NOT_FOUND path — 8 type-by-type lookups all empty.
      [], [], [], [], [], [], [], [],
    ]);
    const svc = new FinancialMovementsTraceService(ds);

    const res = await svc.trace({
      q: 'NOT-FOUND',
      idempotency_key: 'idem-abc-123',
    });

    expect(res.idempotency).toEqual([
      expect.objectContaining({
        key: 'idem-abc-123',
        note_ar: expect.stringContaining('الذاكرة المؤقتة'),
      }),
    ]);
  });
});
