import { AccountingPostingService } from './posting.service';

/**
 * PR-DRIFT-3F — focused unit tests for the cashbox-resolution helper.
 * The helper is the single new entry-point added by this PR; the
 * 4 patched call sites all consume the same precedence chain so
 * validating the helper covers every caller.
 *
 * We mock just the data-source shape the helper touches (one query
 * function returning a list). No DB, no NestJS module bootstrap.
 */
class StubAccountingPostingService extends AccountingPostingService {
  /** Captured query arguments per invocation, for assertions. */
  public queries: Array<{ sql: string; params: any[] }> = [];

  /** Each test sets `nextRows` to whatever the next query() should return. */
  public nextRows: any[] = [];

  constructor() {
    // AccountingPostingService takes (ds, engine, logger). Stub the DataSource
    // with a `manager` that records queries and returns the queue.
    const ds: any = {
      manager: {
        query: async (sql: string, params: any[]) => {
          this.queries.push({ sql, params });
          return this.nextRows;
        },
      },
    };
    super(ds, null as any);
  }
}

describe('AccountingPostingService.resolveCashboxIdForPosting', () => {
  it('returns direct cashbox_id when present (priority 1)', async () => {
    const svc = new StubAccountingPostingService();
    const result = await svc.resolveCashboxIdForPosting(undefined, {
      cashbox_id: 'cb-direct',
      shift_id: 'shift-A',
    });
    expect(result).toBe('cb-direct');
    // Direct hit short-circuits — no DB query.
    expect(svc.queries.length).toBe(0);
  });

  it('looks up shifts.cashbox_id when shift_id is set (priority 2)', async () => {
    const svc = new StubAccountingPostingService();
    svc.nextRows = [{ cashbox_id: 'cb-from-shift' }];
    const result = await svc.resolveCashboxIdForPosting(undefined, {
      shift_id: 'shift-A',
    });
    expect(result).toBe('cb-from-shift');
    expect(svc.queries.length).toBe(1);
    expect(svc.queries[0].sql).toContain('FROM shifts');
    expect(svc.queries[0].params).toEqual(['shift-A']);
  });

  it('returns NULL when both cashbox_id and shift_id are absent and no reference', async () => {
    const svc = new StubAccountingPostingService();
    const result = await svc.resolveCashboxIdForPosting(undefined, {});
    expect(result).toBeNull();
    expect(svc.queries.length).toBe(0);
  });

  it('returns NULL when shift exists but has no cashbox', async () => {
    const svc = new StubAccountingPostingService();
    svc.nextRows = [{ cashbox_id: null }];
    const result = await svc.resolveCashboxIdForPosting(undefined, {
      shift_id: 'shift-no-cb',
    });
    expect(result).toBeNull();
  });

  it('falls back to cashbox_transactions when reference_type/id are set (priority 3)', async () => {
    const svc = new StubAccountingPostingService();
    // Stub: (1) shift query returns no rows; (2) CT query returns one cashbox.
    let call = 0;
    (svc as any).ds = {
      manager: {
        query: async (sql: string, params: any[]) => {
          svc.queries.push({ sql, params });
          call += 1;
          if (call === 1) return []; // shift lookup empty
          return [{ cashbox_id: 'cb-from-ct' }]; // single distinct cashbox
        },
      },
    };
    const result = await svc.resolveCashboxIdForPosting(undefined, {
      shift_id: 'shift-empty',
      reference_type: 'invoice',
      reference_id: 'inv-001',
    });
    expect(result).toBe('cb-from-ct');
    expect(svc.queries.length).toBe(2);
    expect(svc.queries[1].sql).toContain('FROM cashbox_transactions');
  });

  it('refuses to guess when reference has multiple distinct cashboxes', async () => {
    const svc = new StubAccountingPostingService();
    let call = 0;
    (svc as any).ds = {
      manager: {
        query: async (sql: string, params: any[]) => {
          svc.queries.push({ sql, params });
          call += 1;
          if (call === 1) return [];
          return [{ cashbox_id: 'cb-A' }, { cashbox_id: 'cb-B' }]; // ambiguous
        },
      },
    };
    const result = await svc.resolveCashboxIdForPosting(undefined, {
      shift_id: 'shift-empty',
      reference_type: 'invoice',
      reference_id: 'inv-002',
    });
    expect(result).toBeNull();
  });

  it('treats empty-string and undefined cashbox_id as no-attribution', async () => {
    const svc = new StubAccountingPostingService();
    const result = await svc.resolveCashboxIdForPosting(undefined, {
      cashbox_id: '',
    });
    expect(result).toBeNull();
  });

  it('uses passed em.query when provided instead of ds.manager', async () => {
    const svc = new StubAccountingPostingService();
    const emQueries: any[] = [];
    const em: any = {
      query: async (sql: string, params: any[]) => {
        emQueries.push({ sql, params });
        return [{ cashbox_id: 'cb-from-em' }];
      },
    };
    const result = await svc.resolveCashboxIdForPosting(em, {
      shift_id: 'shift-X',
    });
    expect(result).toBe('cb-from-em');
    expect(emQueries.length).toBe(1);
    expect(svc.queries.length).toBe(0); // ds.manager NOT used
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4C — postInvoicePayment / postSupplierPayment now honor
 * `payment_account_snapshot.gl_account_code` for non-cash methods.
 *
 * Strategy: build a fake `q` (the QueryFn that `safe()` passes into the
 * inner closure) that returns canned rows for each SELECT the function
 * issues. The `createEntry` call is what writes JEs in production —
 * here we capture its `lines` argument by stubbing the method on the
 * service instance and asserting the recipe.
 * ========================================================================== */
describe('AccountingPostingService — PR-FIN-PAYACCT-4C snapshot routing', () => {
  /**
   * Build a service instance + a recorder that captures `createEntry`
   * args. Returns helpers for canned SELECT queue setup.
   */
  function makeServiceWithCapturedCreateEntry(opts: {
    paymentRow: any;
    /** Map of `code` → `id` returned by `accountIdByCode()`. */
    coaIds: Record<string, string>;
    /** Override what payments.resolveForPosting returns (when called). */
    paymentsResolve?: any;
  }) {
    const dsManager = {
      query: async () => [],
    };
    const ds: any = {
      manager: dsManager,
      query: async () => [],
    };
    const svc = new AccountingPostingService(ds, null as any);

    // Capture createEntry calls.
    const createEntryCalls: any[] = [];
    (svc as any).createEntry = async (_q: any, args: any) => {
      createEntryCalls.push(args);
      return { entry_id: 'je-mock', entry_no: 'JE-MOCK' };
    };

    // Stub the GL-id lookups so we don't need a real DB.
    (svc as any).accountIdByCode = async (_q: any, code: string) =>
      opts.coaIds[code] ?? null;
    (svc as any).cashboxAccountId = async (_q: any, cashboxId: string) =>
      `acc-cashbox-${cashboxId}`;
    // Stub PaymentsService injection so the snapshot-fallback branch
    // can be exercised.
    (svc as any).payments = {
      resolveForPosting: jest.fn().mockResolvedValue(opts.paymentsResolve ?? null),
    };

    // The `safe()` wrapper hides em behind a closure — call the inner
    // function directly via a public test helper. Easier: invoke the
    // public method but stub `safe()` to call the body with our
    // canned `q`.
    (svc as any).safe = async (
      _refType: string,
      _refId: string,
      _em: any,
      fn: (q: any) => Promise<any>,
    ) => {
      const q = async (_sql: string, _params?: any[]) => [opts.paymentRow];
      return fn(q);
    };

    return { svc, createEntryCalls };
  }

  describe('postInvoicePayment', () => {
    it('cash → DR cashbox-GL (resolved via cashboxAccountId)', async () => {
      const { svc, createEntryCalls } = makeServiceWithCapturedCreateEntry({
        paymentRow: {
          id: 'cp-cash',
          payment_no: 'CR-000010',
          amount: 50,
          cashbox_id: 'cb-1',
          customer_id: 'cust-1',
          created_at: '2026-04-29',
          is_void: false,
          kind: 'invoice_settlement',
          payment_method: 'cash',
          payment_account_id: null,
          payment_account_snapshot: null,
        },
        coaIds: { '1121': 'acc-1121' },
      });

      await svc.postInvoicePayment('cp-cash', 'user-1');
      expect(createEntryCalls).toHaveLength(1);
      const lines = createEntryCalls[0].lines;
      // DR cashbox-GL
      expect(lines[0].account_id).toBe('acc-cashbox-cb-1');
      expect(lines[0].cashbox_id).toBe('cb-1');
      expect(Number(lines[0].debit)).toBe(50);
      // CR receivables 1121
      expect(lines[1].account_id).toBe('acc-1121');
      expect(Number(lines[1].credit)).toBe(50);
      expect(lines[1].customer_id).toBe('cust-1');
    });

    it('non-cash with snapshot.gl_account_code → DR resolves to that code (NOT cashbox-GL)', async () => {
      const { svc, createEntryCalls } = makeServiceWithCapturedCreateEntry({
        paymentRow: {
          id: 'cp-instapay',
          payment_no: 'CR-000011',
          amount: 75,
          cashbox_id: 'cb-1',         // present but should NOT be used
          customer_id: 'cust-1',
          created_at: '2026-04-29',
          is_void: false,
          kind: 'invoice_settlement',
          payment_method: 'instapay',
          payment_account_id: 'pa-instapay-handle-1',
          payment_account_snapshot: {
            display_name: 'InstaPay',
            provider_key: 'instapay',
            identifier: '0100…',
            gl_account_code: '1114',
            cashbox_id: null,
          },
        },
        coaIds: { '1114': 'acc-1114', '1121': 'acc-1121' },
      });

      await svc.postInvoicePayment('cp-instapay', 'user-1');
      const lines = createEntryCalls[0].lines;
      // DR: 1114 (the snapshot-resolved code), NOT cashbox-GL
      expect(lines[0].account_id).toBe('acc-1114');
      expect(lines[0].cashbox_id).toBeUndefined(); // non-cash never tags cashbox_id
      expect(Number(lines[0].debit)).toBe(75);
      // CR: 1121 receivables
      expect(lines[1].account_id).toBe('acc-1121');
    });

    it('non-cash with kind=deposit → CR uses 212 (customer deposits liability)', async () => {
      const { svc, createEntryCalls } = makeServiceWithCapturedCreateEntry({
        paymentRow: {
          id: 'cp-dep',
          payment_no: 'CR-000012',
          amount: 100,
          cashbox_id: 'cb-1',
          customer_id: 'cust-1',
          created_at: '2026-04-29',
          is_void: false,
          kind: 'deposit',
          payment_method: 'wallet',
          payment_account_id: 'pa-w',
          payment_account_snapshot: {
            display_name: 'WE Pay',
            provider_key: 'we_pay',
            identifier: null,
            gl_account_code: '1114',
            cashbox_id: null,
          },
        },
        coaIds: { '1114': 'acc-1114', '212': 'acc-212', '1121': 'acc-1121' },
      });

      await svc.postInvoicePayment('cp-dep', 'user-1');
      const lines = createEntryCalls[0].lines;
      expect(lines[0].account_id).toBe('acc-1114');         // DR wallet
      expect(lines[1].account_id).toBe('acc-212');          // CR deposits (NOT 1121)
    });

    it('non-cash WITHOUT snapshot but with payment_account_id → falls back to live resolve', async () => {
      const { svc, createEntryCalls } = makeServiceWithCapturedCreateEntry({
        paymentRow: {
          id: 'cp-legacy',
          payment_no: 'CR-000013',
          amount: 25,
          cashbox_id: 'cb-1',
          customer_id: 'cust-1',
          created_at: '2026-04-29',
          is_void: false,
          kind: 'invoice_settlement',
          payment_method: 'instapay',
          payment_account_id: 'pa-1',
          payment_account_snapshot: null, // legacy row, no snapshot yet
        },
        coaIds: { '1114': 'acc-1114', '1121': 'acc-1121' },
        paymentsResolve: {
          id: 'pa-1',
          method: 'instapay',
          display_name: 'InstaPay',
          provider_key: 'instapay',
          identifier: '0100',
          gl_account_code: '1114',
          cashbox_id: null,
          metadata: {},
        },
      });
      await svc.postInvoicePayment('cp-legacy', 'user-1');
      const lines = createEntryCalls[0].lines;
      expect(lines[0].account_id).toBe('acc-1114');
    });
  });

  describe('postSupplierPayment', () => {
    it('cash → CR cashbox-GL', async () => {
      const { svc, createEntryCalls } = makeServiceWithCapturedCreateEntry({
        paymentRow: {
          id: 'sp-cash',
          payment_no: 'CP-000010',
          amount: 30,
          cashbox_id: 'cb-1',
          supplier_id: 'sup-1',
          created_at: '2026-04-29',
          is_void: false,
          payment_method: 'cash',
          payment_account_id: null,
          payment_account_snapshot: null,
        },
        coaIds: { '211': 'acc-211' },
      });

      await svc.postSupplierPayment('sp-cash', 'user-1');
      const lines = createEntryCalls[0].lines;
      // DR 211
      expect(lines[0].account_id).toBe('acc-211');
      expect(lines[0].supplier_id).toBe('sup-1');
      // CR cashbox-GL
      expect(lines[1].account_id).toBe('acc-cashbox-cb-1');
      expect(lines[1].cashbox_id).toBe('cb-1');
    });

    it('non-cash with snapshot → CR resolves to snapshot.gl_account_code', async () => {
      const { svc, createEntryCalls } = makeServiceWithCapturedCreateEntry({
        paymentRow: {
          id: 'sp-bank',
          payment_no: 'CP-000011',
          amount: 200,
          cashbox_id: 'cb-1',
          supplier_id: 'sup-1',
          created_at: '2026-04-29',
          is_void: false,
          payment_method: 'bank_transfer',
          payment_account_id: 'pa-bank',
          payment_account_snapshot: {
            display_name: 'NBE Account',
            provider_key: 'nbe',
            identifier: 'EG…IBAN',
            gl_account_code: '1113',
            cashbox_id: null,
          },
        },
        coaIds: { '211': 'acc-211', '1113': 'acc-1113' },
      });

      await svc.postSupplierPayment('sp-bank', 'user-1');
      const lines = createEntryCalls[0].lines;
      // DR 211 (unchanged for non-cash supplier path)
      expect(lines[0].account_id).toBe('acc-211');
      // CR: 1113 (snapshot), NOT cashbox-GL
      expect(lines[1].account_id).toBe('acc-1113');
      expect(lines[1].cashbox_id).toBeUndefined();
    });
  });
});

