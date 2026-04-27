import { ReportsService } from './reports.service';

/**
 * PR-REPORTS-2 — Pin the SQL composition for the new
 * `/reports/payment-channels` endpoint. We don't want to spin a real
 * Postgres in this unit test; we just want to lock:
 *
 *   • date-only call hits the same SQL shape as the dashboard widget
 *     (no shift JOIN), so the dashboard widget's bytes-on-the-wire
 *     stay unchanged
 *   • adding cashbox_id introduces `JOIN shifts s ON s.id = i.shift_id`
 *     and `s.cashbox_id = $N` with the right param index
 *   • user_id filter targets `i.cashier_id` directly (no shift join
 *     forced), since every paid invoice has a cashier
 *   • status='all' is treated as "no filter" — never emits a
 *     `s.status = …` predicate
 *   • status='closed' adds the predicate AND forces the shift join
 *   • bucket aggregation rolls per-method totals correctly and
 *     computes share_pct against grand_total
 *
 * The test stubs `DataSource.query` to capture the SQL + params and
 * to return whatever rows we feed in.
 */

class FakeDataSource {
  public lastSql = '';
  public lastParams: any[] = [];
  public rows: any[] = [];
  query(sql: string, params: any[]) {
    this.lastSql = sql;
    this.lastParams = params;
    return Promise.resolve(this.rows);
  }
}

const buildSvc = (rows: any[] = []) => {
  const ds = new FakeDataSource();
  ds.rows = rows;
  const svc = new ReportsService(ds as any);
  return { svc, ds };
};

describe('ReportsService.paymentChannels — SQL composition', () => {
  it('date-only call omits the shift JOIN and emits 2 params', async () => {
    const { svc, ds } = buildSvc();
    await svc.paymentChannels({ from: '2026-04-01', to: '2026-04-27' });
    expect(ds.lastSql).not.toMatch(/JOIN shifts s/);
    expect(ds.lastParams).toEqual(['2026-04-01', '2026-04-27']);
  });

  it('cashbox_id forces shift JOIN and adds s.cashbox_id predicate', async () => {
    const { svc, ds } = buildSvc();
    await svc.paymentChannels({
      from: '2026-04-01',
      to: '2026-04-27',
      cashbox_id: 'cb-1',
    });
    expect(ds.lastSql).toMatch(/JOIN shifts s ON s\.id = i\.shift_id/);
    expect(ds.lastSql).toMatch(/s\.cashbox_id = \$3/);
    expect(ds.lastParams).toEqual([
      '2026-04-01',
      '2026-04-27',
      'cb-1',
    ]);
  });

  it('user_id targets i.cashier_id without forcing the shift join', async () => {
    const { svc, ds } = buildSvc();
    await svc.paymentChannels({
      from: '2026-04-01',
      to: '2026-04-27',
      user_id: 'u-1',
    });
    expect(ds.lastSql).not.toMatch(/JOIN shifts s/);
    expect(ds.lastSql).toMatch(/i\.cashier_id = \$3/);
    expect(ds.lastParams).toEqual(['2026-04-01', '2026-04-27', 'u-1']);
  });

  it('status="all" is treated as no filter', async () => {
    const { svc, ds } = buildSvc();
    await svc.paymentChannels({
      from: '2026-04-01',
      to: '2026-04-27',
      status: 'all',
    });
    expect(ds.lastSql).not.toMatch(/s\.status =/);
    expect(ds.lastSql).not.toMatch(/JOIN shifts s/);
  });

  it('status="closed" adds the predicate and forces shift join', async () => {
    const { svc, ds } = buildSvc();
    await svc.paymentChannels({
      from: '2026-04-01',
      to: '2026-04-27',
      status: 'closed',
    });
    expect(ds.lastSql).toMatch(/JOIN shifts s/);
    expect(ds.lastSql).toMatch(/s\.status = \$3/);
    expect(ds.lastParams).toEqual([
      '2026-04-01',
      '2026-04-27',
      'closed',
    ]);
  });

  it('combined cashbox_id + user_id + status orders params and predicates correctly', async () => {
    const { svc, ds } = buildSvc();
    await svc.paymentChannels({
      from: '2026-04-01',
      to: '2026-04-27',
      cashbox_id: 'cb-1',
      user_id: 'u-1',
      status: 'closed',
    });
    expect(ds.lastSql).toMatch(/JOIN shifts s/);
    expect(ds.lastSql).toMatch(/s\.cashbox_id = \$3/);
    expect(ds.lastSql).toMatch(/i\.cashier_id = \$4/);
    expect(ds.lastSql).toMatch(/s\.status = \$5/);
    expect(ds.lastParams).toEqual([
      '2026-04-01',
      '2026-04-27',
      'cb-1',
      'u-1',
      'closed',
    ]);
  });
});

describe('ReportsService.paymentChannels — bucket aggregation', () => {
  const fakeRows = [
    {
      method: 'cash',
      payment_account_id: null,
      live_display_name: null,
      live_identifier: null,
      live_provider_key: null,
      snap: null,
      amount: '100.00',
      payment_count: 5,
      invoice_count: 5,
    },
    {
      method: 'instapay',
      payment_account_id: 'pa-1',
      live_display_name: 'InstaPay تجريبي',
      live_identifier: '01000000000',
      live_provider_key: 'instapay',
      snap: null,
      amount: '200.00',
      payment_count: 4,
      invoice_count: 4,
    },
  ];

  it('rolls each method into a single bucket, sorts by amount desc', async () => {
    const { svc } = buildSvc(fakeRows);
    const out = await svc.paymentChannels({
      from: '2026-04-27',
      to: '2026-04-27',
    });
    expect(out.channels).toHaveLength(2);
    // instapay is bigger (200) → first.
    expect(out.channels[0].method).toBe('instapay');
    expect(out.channels[1].method).toBe('cash');
  });

  it('cash_total + non_cash_total = grand_total', async () => {
    const { svc } = buildSvc(fakeRows);
    const out = await svc.paymentChannels({
      from: '2026-04-27',
      to: '2026-04-27',
    });
    expect(out.cash_total).toBe(100);
    expect(out.non_cash_total).toBe(200);
    expect(out.grand_total).toBe(300);
    expect(out.cash_total + out.non_cash_total).toBe(out.grand_total);
  });

  it('share_pct sums to 100 across methods (rounded)', async () => {
    const { svc } = buildSvc(fakeRows);
    const out = await svc.paymentChannels({
      from: '2026-04-27',
      to: '2026-04-27',
    });
    const sum = out.channels.reduce((s, m) => s + m.share_pct, 0);
    expect(Math.round(sum)).toBe(100);
  });

  it('echoes the active filter set on the response', async () => {
    const { svc } = buildSvc(fakeRows);
    const out = await svc.paymentChannels({
      from: '2026-04-27',
      to: '2026-04-27',
      cashbox_id: 'cb-1',
      user_id: 'u-1',
      status: 'closed',
    });
    expect(out.filters).toEqual({
      cashbox_id: 'cb-1',
      user_id: 'u-1',
      status: 'closed',
    });
  });

  it('returns empty channels + zero totals when there are no matching rows', async () => {
    const { svc } = buildSvc([]);
    const out = await svc.paymentChannels({
      from: '2026-04-27',
      to: '2026-04-27',
    });
    expect(out.channels).toEqual([]);
    expect(out.grand_total).toBe(0);
    expect(out.cash_total).toBe(0);
    expect(out.non_cash_total).toBe(0);
  });
});
