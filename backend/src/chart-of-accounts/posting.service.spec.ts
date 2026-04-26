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
