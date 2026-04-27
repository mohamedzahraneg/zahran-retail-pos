/**
 * employees.service.requests-history.spec.ts — PR-ESS-2C-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Tests the shared `listRequestsForUser` SQL builder behind
 * `myRequests` and `listEmployeeRequests`. We don't hit a real
 * database — a stub `ds.query` records the SQL + params and we
 * assert on:
 *
 *   1. the WHERE clauses appended for each filter
 *   2. the LIMIT/OFFSET bounds (defaults + clamping)
 *   3. the SELECT projection includes the linked-expense enrichment
 *      and `decided_by_name`
 *   4. `myRequests` and `listEmployeeRequests` route through the same
 *      private helper (i.e. they produce identical SQL given identical
 *      filters)
 */

import { EmployeesService } from './employees.service';

describe('EmployeesService — request-history filters & enrichment (PR-ESS-2C-2)', () => {
  let svc: EmployeesService;
  let ds: { query: jest.Mock };

  beforeEach(() => {
    ds = { query: jest.fn().mockResolvedValue([]) };
    svc = new EmployeesService(ds as any);
  });

  function lastCall(): { sql: string; params: any[] } {
    expect(ds.query).toHaveBeenCalled();
    const [sql, params] = ds.query.mock.calls[ds.query.mock.calls.length - 1];
    return { sql, params };
  }

  it('myRequests with no filters → only user_id + default limit/offset', async () => {
    await svc.myRequests('user-aaa');
    const { sql, params } = lastCall();

    expect(sql).toContain('WHERE r.user_id = $1');
    expect(sql).toContain('LIMIT $2 OFFSET $3');
    expect(sql).not.toMatch(/r\.kind = \$/);
    expect(sql).not.toMatch(/r\.status = \$/);
    expect(sql).not.toMatch(/r\.created_at >=/);
    expect(params).toEqual(['user-aaa', 50, 0]);
  });

  it('appends kind filter and binds value', async () => {
    await svc.myRequests('user-aaa', { kind: 'advance_request' });
    const { sql, params } = lastCall();

    expect(sql).toMatch(/r\.kind = \$2/);
    expect(params).toEqual(['user-aaa', 'advance_request', 50, 0]);
  });

  it('appends status filter', async () => {
    await svc.myRequests('user-aaa', { status: 'disbursed' });
    const { sql, params } = lastCall();

    expect(sql).toMatch(/r\.status = \$2/);
    expect(params[1]).toBe('disbursed');
  });

  it('combines kind + status + date range with stable param order', async () => {
    await svc.myRequests('user-aaa', {
      kind: 'leave',
      status: 'approved',
      from: '2026-04-01',
      to: '2026-04-30',
    });
    const { sql, params } = lastCall();

    // Each filter appended in the documented order.
    expect(sql).toMatch(/r\.kind = \$2/);
    expect(sql).toMatch(/r\.status = \$3/);
    expect(sql).toMatch(/r\.created_at >= \$4::date/);
    // Inclusive of the `to` date — use < (to + 1 day) so timezone
    // offsets on created_at cannot push a same-day row out of range.
    expect(sql).toMatch(
      /r\.created_at < \(\$5::date \+ INTERVAL '1 day'\)/,
    );
    expect(sql).toMatch(/LIMIT \$6 OFFSET \$7/);
    expect(params).toEqual([
      'user-aaa',
      'leave',
      'approved',
      '2026-04-01',
      '2026-04-30',
      50,
      0,
    ]);
  });

  it('clamps limit to [1, 500] and offset to >=0', async () => {
    await svc.myRequests('user-aaa', { limit: 9999, offset: -5 });
    const { params } = lastCall();
    // limit clamped to 500, offset clamped to 0.
    expect(params).toEqual(['user-aaa', 500, 0]);

    ds.query.mockClear();
    await svc.myRequests('user-aaa', { limit: 0 });
    const { params: p2 } = lastCall();
    // limit floor=1.
    expect(p2[1]).toBe(1);
  });

  it('SELECT projection exposes decided_by_name + linked_expense_* enrichment', async () => {
    await svc.myRequests('user-aaa');
    const { sql } = lastCall();

    // Decider name (LEFT JOIN users decider).
    expect(sql).toMatch(/decider\.full_name AS decided_by_name/);
    // Linked expense fields driven by PR-ESS-2B `source_employee_request_id`.
    expect(sql).toMatch(/e\.id::text\s+AS linked_expense_id/);
    expect(sql).toMatch(/e\.expense_no\s+AS linked_expense_no/);
    expect(sql).toMatch(/e\.amount\s+AS linked_expense_amount/);
    expect(sql).toMatch(/poster\.full_name AS linked_expense_posted_by_name/);

    // Joins are LEFT (so a request without a linked expense still surfaces).
    expect(sql).toMatch(
      /LEFT JOIN expenses e\s+ON e\.source_employee_request_id = r\.id/,
    );
    expect(sql).toMatch(/LEFT JOIN users decider/);

    // Newest-first ordering.
    expect(sql).toMatch(/ORDER BY r\.created_at DESC/);
  });

  it('listEmployeeRequests uses the same SQL builder as myRequests', async () => {
    await svc.myRequests('user-aaa', {
      kind: 'advance_request',
      status: 'approved',
    });
    const mineSql = lastCall().sql;
    ds.query.mockClear();

    await svc.listEmployeeRequests('user-bbb', {
      kind: 'advance_request',
      status: 'approved',
    });
    const adminCall = lastCall();

    // SQL string identical (same projection, same WHERE shape).
    expect(adminCall.sql).toBe(mineSql);
    // Only the bound user_id differs.
    expect(adminCall.params[0]).toBe('user-bbb');
    expect(adminCall.params.slice(1)).toEqual([
      'advance_request',
      'approved',
      50,
      0,
    ]);
  });
});
