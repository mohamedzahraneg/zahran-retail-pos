import { AccountingPostingService } from './posting.service';
// PR-FIX-POS-INVOICE-EDIT-WALLET-CASHBOX-ID — direct import of the
// engine's pure cash/GL alignment validator so we can pipe a real
// spec through it in unit tests without booting the full engine.
import { checkCashGlAlignment } from './financial-engine.service';

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

/* ============================================================================
 * PR-FIN-PAYACCT-4D-DRIFT-ROOT-FIX-1 — forward-fix specs
 * ----------------------------------------------------------------------------
 * Two source-of-drift fixes pinned at the service layer (no DB, no engine
 * end-to-end). Builds a stub `engine` whose `recordTransaction` records
 * its argument, so we can assert the exact `cash_movements` and `gl_lines`
 * the engine would receive.
 *
 * Bug families being fixed:
 *
 *   A) `postInvoiceEdit` → `postInvoice` re-emitted `cash_movements`
 *      after `editInvoice` (in pos.service) had already written
 *      `edit_reversal` + `edit_replay` CT rows. Result: inflated CT
 *      (+700 on INV-2026-000147, +200 on INV-2026-000116).
 *
 *   B) `postReturn` SELECT aliased `s.cashbox_id AS cashbox_id` and
 *      ignored `returns.cashbox_id`. Standalone returns with no
 *      `original_invoice_id` got a refund cash leg with
 *      `journal_lines.cashbox_id = NULL`. Result: 3 returns
 *      (RET-2026-000002/3/4, total 1,150 EGP) marked CT_only by
 *      `v_cashbox_drift_per_ref` even though the JE is correct.
 * ========================================================================== */
describe('AccountingPostingService — PR-FIN-PAYACCT-4D-DRIFT-ROOT-FIX-1', () => {
  /**
   * Build a service with:
   *   • A stub DataSource whose `query` shifts the next answer off
   *     `dsResults` (FIFO).
   *   • A stub engine that records every `recordTransaction` call.
   * Returns helpers + the captured engine calls for assertions.
   */
  function makeServiceWithEngineSpy(opts: {
    dsResults: any[][];
    /** Map of `code` → fake account id used by `accountIdByCode`. */
    coaIds?: Record<string, string>;
  }) {
    const dsCalls: Array<{ sql: string; params: any[] }> = [];
    let i = 0;
    const dsManager = {
      query: async (sql: string, params: any[] = []) => {
        dsCalls.push({ sql, params });
        return opts.dsResults[i++] ?? [];
      },
    };
    const ds: any = {
      manager: dsManager,
      query: dsManager.query,
    };
    const engineCalls: any[] = [];
    const engine: any = {
      recordTransaction: jest.fn().mockImplementation(async (spec: any) => {
        engineCalls.push(spec);
        return { ok: true, entry_id: 'je-mock' };
      }),
    };
    const svc = new AccountingPostingService(ds, engine);
    if (opts.coaIds) {
      (svc as any).accountIdByCode = async (_q: any, code: string) =>
        opts.coaIds![code] ?? null;
    }
    (svc as any).cashboxAccountId = async (_q: any, cashboxId: string) =>
      `acc-cashbox-${cashboxId}`;
    return { svc, engine, engineCalls, dsCalls };
  }

  /* ── Fix #1: invoice edit CT duplication ───────────────────────── */

  describe('Fix #1 — postInvoice / postInvoiceEdit', () => {
    /**
     * Default postInvoice still ships cash_movements for cash payments.
     * Initial sale postings must not regress when the new flag is
     * absent.
     */
    it('postInvoice (default) still emits cash_movements for cash payments', async () => {
      const { svc, engineCalls } = makeServiceWithEngineSpy({
        dsResults: [
          // 1: SELECT invoice header (with cashbox_id)
          [{ id: 'inv-1', invoice_no: 'INV-1', grand_total: 100,
             paid_amount: 100, tax_amount: 0, status: 'paid',
             customer_id: 'c-1', cashbox_id: 'cb-1', completed_at: '2026-04-30' }],
          // 2: SELECT cogs
          [{ cogs: 0 }],
          // 3: SELECT payments — single cash payment
          [{ payment_method: 'cash', amount: '100',
             payment_account_id: null, payment_account_snapshot: null }],
        ],
      });

      await svc.postInvoice('inv-1', 'user-1');

      expect(engineCalls).toHaveLength(1);
      const spec = engineCalls[0];
      expect(spec.cash_movements).toBeDefined();
      expect(spec.cash_movements).toHaveLength(1);
      expect(spec.cash_movements[0]).toMatchObject({
        cashbox_id: 'cb-1',
        direction: 'in',
        amount: 100,
        category: 'sale',
      });
    });

    /**
     * The new `skipCashMovements` opt forces cash_movements: [] even
     * when the invoice has cash payments and a cashbox_id. This is
     * the contract postInvoiceEdit uses to avoid double-writing.
     */
    it('postInvoice with { skipCashMovements: true } emits cash_movements: []', async () => {
      const { svc, engineCalls } = makeServiceWithEngineSpy({
        dsResults: [
          [{ id: 'inv-1', invoice_no: 'INV-1', grand_total: 100,
             paid_amount: 100, tax_amount: 0, status: 'paid',
             customer_id: 'c-1', cashbox_id: 'cb-1', completed_at: '2026-04-30' }],
          [{ cogs: 0 }],
          [{ payment_method: 'cash', amount: '100',
             payment_account_id: null, payment_account_snapshot: null }],
        ],
      });

      await svc.postInvoice('inv-1', 'user-1', undefined, {
        skipCashMovements: true,
      });

      expect(engineCalls).toHaveLength(1);
      expect(engineCalls[0].cash_movements).toEqual([]);
    });

    /**
     * postInvoiceEdit must reach postInvoice with the skip flag — and
     * void any active JE first. We spy on the service's own
     * postInvoice method so the assertion is pinned to the contract,
     * not the inner SQL.
     */
    it('postInvoiceEdit voids the active JE then calls postInvoice with skipCashMovements: true', async () => {
      const { svc } = makeServiceWithEngineSpy({ dsResults: [] });
      const dsManagerCalls: Array<{ sql: string; params: any[] }> = [];
      // Replace the SQL recorder so we see the void-update.
      (svc as any).ds = {
        manager: {
          query: async (sql: string, params: any[]) => {
            dsManagerCalls.push({ sql, params });
            return [];
          },
        },
      };
      const postInvoiceSpy = jest
        .spyOn(svc, 'postInvoice')
        .mockResolvedValue({ entry_id: 'je-edit' } as any);

      await (svc as any).postInvoiceEdit('inv-1', 'user-1');

      // The void update fired before postInvoice.
      const voidCall = dsManagerCalls.find((c) =>
        /UPDATE journal_entries[\s\S]+SET is_void = TRUE/.test(c.sql),
      );
      expect(voidCall).toBeDefined();
      expect(voidCall!.params).toEqual(['inv-1', 'user-1']);
      // postInvoice was invoked with the skip flag.
      expect(postInvoiceSpy).toHaveBeenCalledTimes(1);
      const args = postInvoiceSpy.mock.calls[0];
      expect(args[0]).toBe('inv-1');                 // invoiceId
      expect(args[1]).toBe('user-1');                // userId
      expect(args[3]).toEqual({ skipCashMovements: true });
    });
  });

  /* ── Fix #2: refund cash JE line cashbox_id wiring ─────────────── */

  describe('Fix #2 — postReturn cashbox_id wiring', () => {
    /**
     * Standalone return (`original_invoice_id IS NULL`) but the
     * return row carries its own `cashbox_id`. After the COALESCE
     * fix the SELECT returns that cashbox_id; the cash refund leg
     * must thread it through to `journal_lines.cashbox_id` so
     * `v_cashbox_drift_per_ref` can pair the JE with the cashbox.
     *
     * Pinned via the engine's `gl_lines` arg — the cash leg has
     * `account_id = acc-cashbox-cb-1` and `cashbox_id = 'cb-1'`.
     */
    it('standalone return with returns.cashbox_id populates JE cash line cashbox_id', async () => {
      const { svc, engineCalls, dsCalls } = makeServiceWithEngineSpy({
        coaIds: { '49': 'acc-49' },
        dsResults: [
          // safe() probes — return-header SELECT shape is validated by
          // service code; we provide the COALESCE'd cashbox_id directly.
          [{
            id: 'ret-1', return_no: 'RET-1', total_refund: '350',
            restocking_fee: 0, net_refund: '350', status: 'refunded',
            refunded_at: '2026-05-01', approved_at: null, requested_at: null,
            refund_method: 'cash', original_invoice_id: null,
            cashbox_id: 'cb-1',  // ← from COALESCE(r.cashbox_id, s.cashbox_id)
          }],
          // costRow
          [{ cost: 0 }],
        ],
      });

      // Stub safe() to invoke the body with our `q` (the dsManager.query).
      (svc as any).safe = async (
        _refType: string,
        _refId: string,
        _em: any,
        body: (q: any) => Promise<any>,
      ) => body((svc as any).ds.manager.query.bind((svc as any).ds.manager));

      await svc.postReturn('ret-1', 'user-1');

      // The COALESCE alias must appear in the SELECT — this is the
      // forward-fix wiring pinned at the SQL level.
      const headerSql = dsCalls.find((c) => /FROM returns r/.test(c.sql));
      expect(headerSql).toBeDefined();
      expect(headerSql!.sql).toMatch(
        /COALESCE\(r\.cashbox_id,\s*s\.cashbox_id\)\s+AS cashbox_id/,
      );

      // The engine receives a gl_lines array with the cash refund leg
      // carrying cashbox_id = 'cb-1' (so v_cashbox_drift_per_ref can pair).
      expect(engineCalls).toHaveLength(1);
      const cashLine = engineCalls[0].gl_lines.find(
        (l: any) => l.account_id === 'acc-cashbox-cb-1',
      );
      expect(cashLine).toBeDefined();
      expect(cashLine.cashbox_id).toBe('cb-1');
      expect(cashLine.credit).toBe(350); // refund leaves the cashbox
      expect(cashLine.debit).toBe(0);
    });

    /**
     * Regression guard: when the return DOES carry an original
     * invoice (the original happy path), the SELECT still resolves
     * cashbox_id via either source — same shape as before, just
     * with the COALESCE alias.
     */
    it('return with original_invoice_id still resolves cashbox_id (regression)', async () => {
      const { svc, engineCalls } = makeServiceWithEngineSpy({
        coaIds: { '49': 'acc-49' },
        dsResults: [
          [{
            id: 'ret-2', return_no: 'RET-2', total_refund: '120',
            restocking_fee: 0, net_refund: '120', status: 'refunded',
            refunded_at: '2026-05-01', approved_at: null, requested_at: null,
            refund_method: 'cash',
            original_invoice_id: 'inv-99',
            cashbox_id: 'cb-2',  // COALESCE picks r.cashbox_id (or s.cashbox_id when r is null)
          }],
          [{ cost: 0 }],
        ],
      });
      (svc as any).safe = async (
        _refType: string,
        _refId: string,
        _em: any,
        body: (q: any) => Promise<any>,
      ) => body((svc as any).ds.manager.query.bind((svc as any).ds.manager));

      await svc.postReturn('ret-2', 'user-1');

      const cashLine = engineCalls[0].gl_lines.find(
        (l: any) => l.account_id === 'acc-cashbox-cb-2',
      );
      expect(cashLine).toBeDefined();
      expect(cashLine.cashbox_id).toBe('cb-2');
      expect(cashLine.credit).toBe(120);
    });
  });

  /* ── Read-only invariant for the whole forward-fix set ──────────── */

  it('forward-fix code paths emit zero DELETE/DROP/TRUNCATE/auto-settle SQL', async () => {
    const { svc, dsCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-1', invoice_no: 'INV-1', grand_total: 50,
           paid_amount: 50, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{ payment_method: 'cash', amount: '50',
           payment_account_id: null, payment_account_snapshot: null }],
      ],
    });

    await svc.postInvoice('inv-1', 'user-1', undefined, {
      skipCashMovements: true,
    });

    for (const c of dsCalls) {
      expect(c.sql).not.toMatch(/\bDELETE\b/i);
      expect(c.sql).not.toMatch(/\bDROP\b/i);
      expect(c.sql).not.toMatch(/\bTRUNCATE\b/i);
      // No "settlement" or "auto correct" markers in this code path.
      expect(c.sql).not.toMatch(/auto[_ ]?settle/i);
      expect(c.sql).not.toMatch(/drift[_ ]?correction/i);
    }
  });
});

/**
 * PR-FIX-POS-INVOICE-EDIT-WALLET-CASHBOX-ID
 *
 * Bug repro + fix verification.
 *
 * BEFORE the fix, `postInvoice` built non-cash payment GL lines without
 * a `cashbox_id`. When the resolved `gl_account_code` is a LIQUID code
 * (1111 cash / 1113 bank / 1114 wallet / 1115 check) the engine's
 * Guard A rejects the line:
 *
 *     "GL line on 1114 requires cashbox_id ... Use resolve_from_cashbox_id
 *      or set cashbox_id explicitly."
 *
 * Repro path: edit an invoice changing the payment method from cash to
 * wallet/InstaPay/bank/check. `postInvoiceEdit` voids the old JE and
 * reposts via `postInvoice`. The new JE has the wallet leg with no
 * cashbox tag → Guard A fires → the entire edit transaction rolls back
 * with "فشل ترحيل القيد بعد تعديل الفاتورة".
 *
 * The fix threads `payment_account.cashbox_id` (frozen on the snapshot
 * at edit-time, or live-resolved as a back-compat fallback) onto:
 *   1. the non-cash GL line (`cashbox_id` + `resolve_from_cashbox_id`),
 *      satisfying Guard A.
 *   2. a paired entry in `cash_movements`, satisfying Guard B.
 *
 * The `skipCashMovements` opt is unchanged in semantics for CASH legs
 * (which `pos.service.editInvoice` writes manually via
 * `recordCashOnlyMovement`). Non-cash legs always go through the engine
 * because nothing in `pos.service` writes their CTs out-of-band.
 *
 * Symmetric coverage:
 *   · cash → wallet  (the reported bug, GL 1114)
 *   · cash → bank    (GL 1113)
 *   · cash → check   (GL 1115)
 *   · wallet → cash  (regression check — existing inv.cashbox_id path)
 *   · mixed cash + wallet
 *   · sub-account GL like 1114-001 (NOT in LIQUID_GL_CODES) — should
 *     pass through without cashbox tagging.
 */
describe('AccountingPostingService — PR-FIX-POS-INVOICE-EDIT-WALLET-CASHBOX-ID', () => {
  function makeServiceWithEngineSpy(opts: {
    dsResults: any[][];
    coaIds?: Record<string, string>;
    /**
     * Optional mock for the live PaymentsService.resolveForPosting()
     * lookup. The fix consults this only when the snapshot is missing
     * `cashbox_id` (back-compat for rows written before this PR).
     */
    liveLookup?: (
      paymentAccountId: string,
    ) => Promise<{
      id: string;
      method: string;
      gl_account_code: string;
      display_name: string | null;
      cashbox_id: string | null;
    } | null>;
  }) {
    const dsCalls: Array<{ sql: string; params: any[] }> = [];
    let i = 0;
    const dsManager = {
      query: async (sql: string, params: any[] = []) => {
        dsCalls.push({ sql, params });
        return opts.dsResults[i++] ?? [];
      },
    };
    const ds: any = {
      manager: dsManager,
      query: dsManager.query,
    };
    const engineCalls: any[] = [];
    const engine: any = {
      recordTransaction: jest.fn().mockImplementation(async (spec: any) => {
        engineCalls.push(spec);
        return { ok: true, entry_id: 'je-mock' };
      }),
    };
    const payments: any = opts.liveLookup
      ? { resolveForPosting: jest.fn().mockImplementation(opts.liveLookup) }
      : undefined;
    const svc = new AccountingPostingService(ds, engine, payments);
    if (opts.coaIds) {
      (svc as any).accountIdByCode = async (_q: any, code: string) =>
        opts.coaIds![code] ?? null;
    }
    (svc as any).cashboxAccountId = async (_q: any, cashboxId: string) =>
      `acc-cashbox-${cashboxId}`;
    return { svc, engine, engineCalls, dsCalls };
  }

  /**
   * Tiny helper: build the resolvedLines + code map shape that
   * checkCashGlAlignment expects, given the engine spec we observed.
   * This lets us pipe a real engine spec through the pure validator
   * to assert Guards A/B/C all pass — covering the user's
   * requirement #6 ("liquid GL lines still satisfy the engine guard").
   */
  function passesEngineCashGlAlignment(spec: any): true | string {
    // For unit testing we use the account_code directly as the
    // "account_id" + "code" so the validator can match codes without
    // a real chart_of_accounts lookup.
    const codeById = new Map<string, string>();
    const resolvedLines = (spec.gl_lines as any[]).map((l) => {
      const accountId = String(
        l.account_code ?? `cashbox:${l.resolve_from_cashbox_id}`,
      );
      const code =
        l.account_code ??
        (l.resolve_from_cashbox_id ? '1111' : '');
      codeById.set(accountId, code);
      return {
        account_id: accountId,
        debit: Number(l.debit ?? 0),
        credit: Number(l.credit ?? 0),
        cashbox_id:
          l.cashbox_id ?? l.resolve_from_cashbox_id ?? null,
      };
    });
    const result = checkCashGlAlignment({
      reference_type: spec.reference_type,
      reference_id: spec.reference_id,
      accounting_only: spec.accounting_only ?? false,
      resolved_lines: resolvedLines,
      cash_movements: spec.cash_movements ?? [],
      code_by_account_id: codeById,
    });
    if (result === null || result === 'accounting_only_bypass_logged') {
      return true;
    }
    return result;
  }

  // ─── 1. Bug repro (pre-fix behavior captured before the fix lands) ─
  it('cash → wallet WITHOUT payment_account.cashbox_id: snapshot has no cashbox → engine guard would fail (degraded config)', async () => {
    // This pins the EXISTING configuration-degraded case: the operator
    // hasn't pinned a cashbox to their wallet payment_account. After the
    // fix, the engine call still emits a wallet line on 1114 with NO
    // cashbox_id, so the engine's Guard A still rejects it. The fix is
    // explicitly NOT to invent a cashbox out of thin air; operators must
    // configure payment_account.cashbox_id on their wallet/InstaPay
    // accounts. We pin this so the failure mode is visible: the FIX is
    // CONDITIONAL on payment_account.cashbox_id being present.
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-1', invoice_no: 'INV-1', grand_total: 500,
           paid_amount: 500, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'wallet',
          amount: '500',
          payment_account_id: 'pa-wallet-1',
          // Snapshot frozen pre-fix — no cashbox_id field.
          payment_account_snapshot: {
            id: 'pa-wallet-1',
            method: 'wallet',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            // cashbox_id intentionally absent
          },
        }],
      ],
      // Live lookup also returns null cashbox_id (configuration-degraded).
      liveLookup: async () => ({
        id: 'pa-wallet-1',
        method: 'wallet',
        gl_account_code: '1114',
        display_name: 'InstaPay',
        cashbox_id: null,
      }),
    });

    await svc.postInvoice('inv-1', 'user-1', undefined, {
      skipCashMovements: true,
    });

    expect(engineCalls).toHaveLength(1);
    const spec = engineCalls[0];
    const walletLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1114',
    );
    expect(walletLine).toBeDefined();
    expect(walletLine.cashbox_id).toBeUndefined();
    expect(walletLine.resolve_from_cashbox_id).toBeUndefined();

    // Pipe through real engine validator to confirm Guard A would fire.
    const align = passesEngineCashGlAlignment(spec);
    expect(typeof align).toBe('string');
    expect(align as string).toMatch(
      /cash GL line on 1114 requires cashbox_id/i,
    );
  });

  // ─── 2. Happy path: cash → wallet WITH snapshot.cashbox_id ───────
  it('cash → wallet WITH payment_account_snapshot.cashbox_id: wallet GL line carries cashbox_id + paired cash_movement; engine guards all pass', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-2', invoice_no: 'INV-2', grand_total: 500,
           paid_amount: 500, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'wallet',
          amount: '500',
          payment_account_id: 'pa-wallet-1',
          payment_account_snapshot: {
            id: 'pa-wallet-1',
            method: 'wallet',
            display_name: 'InstaPay الأهلي',
            gl_account_code: '1114',
            cashbox_id: 'cb-wallet-instapay', // ← present after the fix wires it through
          },
        }],
      ],
    });

    await svc.postInvoice('inv-2', 'user-1', undefined, {
      skipCashMovements: true,
    });

    expect(engineCalls).toHaveLength(1);
    const spec = engineCalls[0];
    const walletLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1114',
    );
    expect(walletLine).toBeDefined();
    expect(walletLine.cashbox_id).toBe('cb-wallet-instapay');
    expect(walletLine.resolve_from_cashbox_id).toBe('cb-wallet-instapay');

    // The paired cash_movement MUST be emitted (regardless of
    // skipCashMovements) so engine Guard B passes. skipCashMovements
    // suppresses ONLY cash payments tied to inv.cashbox_id; non-cash
    // payments tied to payment_account.cashbox_id always go through
    // the engine because pos.service.editInvoice does NOT write their
    // CTs out-of-band.
    const walletMv = (spec.cash_movements as any[]).find(
      (m) => m.cashbox_id === 'cb-wallet-instapay',
    );
    expect(walletMv).toBeDefined();
    expect(walletMv).toMatchObject({
      cashbox_id: 'cb-wallet-instapay',
      direction: 'in',
      amount: 500,
      category: 'sale',
    });

    // No CASH movement (skipCashMovements suppresses inv.cashbox_id).
    const cashMv = (spec.cash_movements as any[]).find(
      (m) => m.cashbox_id === 'cb-pos-1',
    );
    expect(cashMv).toBeUndefined();

    // Real engine validator: Guards A + B + C all pass.
    expect(passesEngineCashGlAlignment(spec)).toBe(true);
  });

  // ─── 3. Symmetric: cash → bank (GL 1113) ─────────────────────────
  it('cash → bank with snapshot.cashbox_id: bank GL line carries cashbox_id, engine guards pass', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-3', invoice_no: 'INV-3', grand_total: 1200,
           paid_amount: 1200, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'bank_transfer',
          amount: '1200',
          payment_account_id: 'pa-bank-1',
          payment_account_snapshot: {
            id: 'pa-bank-1',
            method: 'bank_transfer',
            display_name: 'NBE — حساب جاري',
            gl_account_code: '1113',
            cashbox_id: 'cb-bank-nbe',
          },
        }],
      ],
    });

    await svc.postInvoice('inv-3', 'user-1', undefined, {
      skipCashMovements: true,
    });

    const spec = engineCalls[0];
    const bankLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1113',
    );
    expect(bankLine.cashbox_id).toBe('cb-bank-nbe');
    expect(bankLine.resolve_from_cashbox_id).toBe('cb-bank-nbe');

    const bankMv = (spec.cash_movements as any[]).find(
      (m) => m.cashbox_id === 'cb-bank-nbe',
    );
    expect(bankMv).toMatchObject({
      cashbox_id: 'cb-bank-nbe',
      direction: 'in',
      amount: 1200,
      category: 'sale',
    });

    expect(passesEngineCashGlAlignment(spec)).toBe(true);
  });

  // ─── 4. Symmetric: cash → check (GL 1115) ────────────────────────
  it('cash → check with snapshot.cashbox_id: check GL line carries cashbox_id, engine guards pass', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-4', invoice_no: 'INV-4', grand_total: 800,
           paid_amount: 800, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'check',
          amount: '800',
          payment_account_id: 'pa-check-1',
          payment_account_snapshot: {
            id: 'pa-check-1',
            method: 'check',
            display_name: 'شيك مؤجل',
            gl_account_code: '1115',
            cashbox_id: 'cb-checks',
          },
        }],
      ],
    });

    await svc.postInvoice('inv-4', 'user-1', undefined, {
      skipCashMovements: true,
    });

    const spec = engineCalls[0];
    const checkLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1115',
    );
    expect(checkLine.cashbox_id).toBe('cb-checks');

    const checkMv = (spec.cash_movements as any[]).find(
      (m) => m.cashbox_id === 'cb-checks',
    );
    expect(checkMv).toMatchObject({ cashbox_id: 'cb-checks', amount: 800 });

    expect(passesEngineCashGlAlignment(spec)).toBe(true);
  });

  // ─── 5. Reverse direction: wallet → cash (regression guard) ──────
  it('wallet → cash: cash leg uses inv.cashbox_id (existing behavior unchanged)', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-5', invoice_no: 'INV-5', grand_total: 300,
           paid_amount: 300, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        // Post-edit: only cash payment.
        [{ payment_method: 'cash', amount: '300',
           payment_account_id: null, payment_account_snapshot: null }],
      ],
    });

    await svc.postInvoice('inv-5', 'user-1', undefined, {
      skipCashMovements: true,
    });

    const spec = engineCalls[0];
    const cashLine = (spec.gl_lines as any[]).find(
      (l) => l.resolve_from_cashbox_id === 'cb-pos-1',
    );
    expect(cashLine).toBeDefined();
    expect(cashLine.cashbox_id).toBe('cb-pos-1');

    // skipCashMovements suppresses cash entries.
    expect(spec.cash_movements).toEqual([]);

    // No wallet GL line (post-edit state has no wallet payment).
    const walletLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1114',
    );
    expect(walletLine).toBeUndefined();
  });

  // ─── 6. Mixed cash + wallet ──────────────────────────────────────
  it('mixed cash + wallet edit: both legs have cashbox_id; only wallet movement emitted under skipCashMovements', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-6', invoice_no: 'INV-6', grand_total: 800,
           paid_amount: 800, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [
          { payment_method: 'cash', amount: '300',
            payment_account_id: null, payment_account_snapshot: null },
          {
            payment_method: 'wallet',
            amount: '500',
            payment_account_id: 'pa-wallet-1',
            payment_account_snapshot: {
              id: 'pa-wallet-1',
              method: 'wallet',
              display_name: 'InstaPay',
              gl_account_code: '1114',
              cashbox_id: 'cb-wallet-instapay',
            },
          },
        ],
      ],
    });

    await svc.postInvoice('inv-6', 'user-1', undefined, {
      skipCashMovements: true,
    });

    const spec = engineCalls[0];
    const cashLine = (spec.gl_lines as any[]).find(
      (l) => l.cashbox_id === 'cb-pos-1',
    );
    const walletLine = (spec.gl_lines as any[]).find(
      (l) => l.cashbox_id === 'cb-wallet-instapay',
    );
    expect(cashLine).toBeDefined();
    expect(cashLine.debit).toBe(300);
    expect(walletLine).toBeDefined();
    expect(walletLine.debit).toBe(500);

    // skipCashMovements suppresses cash entries on inv.cashbox_id; the
    // wallet movement on the payment-account cashbox is still emitted.
    expect(spec.cash_movements).toHaveLength(1);
    expect(spec.cash_movements[0]).toMatchObject({
      cashbox_id: 'cb-wallet-instapay',
      direction: 'in',
      amount: 500,
      category: 'sale',
    });

    // Engine validator: cash leg has no paired CT (skipCashMovements is
    // the existing semantics — pos.service.editInvoice writes the cash
    // CT manually). The validator would catch this in isolation; the
    // production path is OK because the manually-written CTs cover it.
    // We only assert the wallet leg is correctly tagged here.
    expect(walletLine.cashbox_id).toBe('cb-wallet-instapay');
  });

  // ─── 7. Sub-account GL (1114-001) — NOT in LIQUID_GL_CODES ───────
  it('non-liquid sub-account (e.g. 1114-001): GL line still gets cashbox_id when payment_account has it; engine guard does NOT require it', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-7', invoice_no: 'INV-7', grand_total: 200,
           paid_amount: 200, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'wallet',
          amount: '200',
          payment_account_id: 'pa-wallet-2',
          payment_account_snapshot: {
            id: 'pa-wallet-2',
            method: 'wallet',
            display_name: 'فودافون كاش',
            gl_account_code: '1114-001', // sub-account, NOT in LIQUID_GL_CODES
            cashbox_id: 'cb-wallet-vodacash',
          },
        }],
      ],
    });

    await svc.postInvoice('inv-7', 'user-1', undefined, {
      skipCashMovements: true,
    });

    const spec = engineCalls[0];
    const walletLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1114-001',
    );
    expect(walletLine).toBeDefined();
    // Fix still tags the cashbox even for sub-accounts (consistent
    // tagging makes the later CT-vs-GL reconciliation easier).
    expect(walletLine.cashbox_id).toBe('cb-wallet-vodacash');

    // Engine validator: '1114-001' is NOT a liquid code, so Guards A
    // and B don't fire. Pass through.
    expect(passesEngineCashGlAlignment(spec)).toBe(true);
  });

  // ─── 8. Snapshot missing cashbox_id → live fallback ──────────────
  it('snapshot WITHOUT cashbox_id (legacy row): falls back to live payment_account.cashbox_id', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-8', invoice_no: 'INV-8', grand_total: 400,
           paid_amount: 400, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'wallet',
          amount: '400',
          payment_account_id: 'pa-wallet-1',
          payment_account_snapshot: {
            id: 'pa-wallet-1',
            method: 'wallet',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            // cashbox_id missing — pre-fix snapshot
          },
        }],
      ],
      liveLookup: async (paId) => ({
        id: paId,
        method: 'wallet',
        gl_account_code: '1114',
        display_name: 'InstaPay',
        cashbox_id: 'cb-wallet-live', // live fallback
      }),
    });

    await svc.postInvoice('inv-8', 'user-1', undefined, {
      skipCashMovements: true,
    });

    const spec = engineCalls[0];
    const walletLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1114',
    );
    expect(walletLine.cashbox_id).toBe('cb-wallet-live');

    expect(passesEngineCashGlAlignment(spec)).toBe(true);
  });

  // ─── 9. No duplicate gl_lines / cash_movements ───────────────────
  it('no duplicate JE/CT lines on a single-payment edit', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-9', invoice_no: 'INV-9', grand_total: 300,
           paid_amount: 300, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'wallet',
          amount: '300',
          payment_account_id: 'pa-wallet-1',
          payment_account_snapshot: {
            id: 'pa-wallet-1',
            method: 'wallet',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            cashbox_id: 'cb-wallet-instapay',
          },
        }],
      ],
    });

    await svc.postInvoice('inv-9', 'user-1', undefined, {
      skipCashMovements: true,
    });

    const spec = engineCalls[0];
    // Exactly one wallet GL line.
    const walletLines = (spec.gl_lines as any[]).filter(
      (l) => l.account_code === '1114',
    );
    expect(walletLines).toHaveLength(1);
    // Exactly one wallet cash_movement.
    const walletMvs = (spec.cash_movements as any[]).filter(
      (m) => m.cashbox_id === 'cb-wallet-instapay',
    );
    expect(walletMvs).toHaveLength(1);
  });

  // ─── 10. Default postInvoice (no skipCashMovements) — initial sale
  // wallet payment — full happy path through engine validator ───────
  it('initial-sale wallet payment (no skipCashMovements): wallet leg + matching cash_movement, engine guards pass', async () => {
    const { svc, engineCalls } = makeServiceWithEngineSpy({
      dsResults: [
        [{ id: 'inv-10', invoice_no: 'INV-10', grand_total: 700,
           paid_amount: 700, tax_amount: 0, status: 'paid',
           customer_id: 'c-1', cashbox_id: 'cb-pos-1', completed_at: '2026-04-30' }],
        [{ cogs: 0 }],
        [{
          payment_method: 'wallet',
          amount: '700',
          payment_account_id: 'pa-wallet-1',
          payment_account_snapshot: {
            id: 'pa-wallet-1',
            method: 'wallet',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            cashbox_id: 'cb-wallet-instapay',
          },
        }],
      ],
    });

    // No skipCashMovements → initial sale path.
    await svc.postInvoice('inv-10', 'user-1');

    const spec = engineCalls[0];
    const walletLine = (spec.gl_lines as any[]).find(
      (l) => l.account_code === '1114',
    );
    expect(walletLine.cashbox_id).toBe('cb-wallet-instapay');

    const walletMv = (spec.cash_movements as any[]).find(
      (m) => m.cashbox_id === 'cb-wallet-instapay',
    );
    expect(walletMv).toMatchObject({ direction: 'in', amount: 700 });

    expect(passesEngineCashGlAlignment(spec)).toBe(true);
  });
});

