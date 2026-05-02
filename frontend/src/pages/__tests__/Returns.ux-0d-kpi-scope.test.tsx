/**
 * Returns.ux-0d-kpi-scope.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-RETURNS-UX-0D — pins the new KPI scope semantics:
 *
 *   • KPI tiles compute from the SAME arrays the list renders from.
 *     The BE has already applied the active filters (tab / date_from /
 *     date_to / refund_method / accounting_status / search-q) by the
 *     time the FE receives them, so summing/counting the response
 *     directly produces filter-aware totals.
 *   • Labels renamed: "مرتجعات اليوم" → "إجمالي المرتجعات",
 *     "استبدالات اليوم" → "إجمالي الاستبدالات". Sub-text "حسب الفلاتر
 *     الحالية" surfaces the scope so the user is never confused.
 *   • Testids renamed: kpi-today-* → kpi-total-* to reflect the new
 *     semantics. Other testids (kpi-pending / kpi-refunded /
 *     kpi-stock-impact / kpi-needs-review) are unchanged.
 *
 * Default expectation with the 4 production-shape refunded rows
 * (RET-2026-000001..000004 totalling 1,400 ج.م):
 *
 *   كل (الكل) → returns 4 / 1,400 · refunded 1,400 / 4 · stock 4 ·
 *               exchanges 0 / 0 · pending 0 · needs review 0
 *
 * Selecting a date preset / typing in search / picking a status tab
 * lets the BE narrow the response, and the KPIs follow without any
 * extra client-side re-filter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { ReturnListItem } from '@/api/returns.api';

const listMock = vi.fn();
const getMock = vi.fn();
const listExchangesMock = vi.fn();

vi.mock('@/api/returns.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    returnsApi: {
      ...((actual as any).returnsApi ?? {}),
      list: (p: any) => listMock(p),
      get: (id: string) => getMock(id),
      lookupInvoice: vi.fn(),
      createReturn: vi.fn(),
      approve: vi.fn(),
      refund: vi.fn(),
      reject: vi.fn(),
      exchange: vi.fn(),
      listExchanges: (p: any) => listExchangesMock(p),
      getExchange: vi.fn(),
    },
  };
});

vi.mock('@/api/products.api', () => ({
  productsApi: { searchVariants: vi.fn(async () => []) },
}));

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import Returns from '../Returns';

// ─── fixtures ───────────────────────────────────────────────────────

function row(over: Partial<ReturnListItem> = {}): ReturnListItem {
  return {
    id: 'r-' + (over.id ?? 'a'),
    return_no: 'RET-2026-000000',
    status: 'refunded',
    reason: 'wrong_size',
    total_refund: '0',
    restocking_fee: '0',
    net_refund: '0',
    refund_method: 'cash',
    requested_at: '2026-04-25T17:00:14Z',
    approved_at: '2026-04-25T17:00:39Z',
    refunded_at: '2026-04-25T17:00:54Z',
    rejected_at: null,
    created_at: '2026-04-25T17:00:14Z',
    updated_at: '2026-04-25T17:00:54Z',
    original_invoice_id: 'inv-1',
    invoice_no: 'INV-2026-000123',
    customer_id: null,
    customer_name: 'عميل نقدي',
    customer_phone: null,
    items_count: 1,
    units_count: 1,
    cashbox_id: '524646d5-7bd6-4d8d-a484-b1f562b039a4',
    cashbox_name: 'الخزينة الرئيسية',
    requested_by: 'u1',
    requested_by_name: 'محمود زهران',
    approved_by: 'u1',
    approved_by_name: 'محمود زهران',
    refunded_by: 'u1',
    refunded_by_name: 'محمود زهران',
    journal_entry_id: 'je-1',
    journal_entry_no: 'JE-2026-000358',
    journal_entry_posted_at: '2026-04-25T17:00:54Z',
    refund_cashbox_transaction_id: 245,
    has_unlinked_cash_leg: false,
    accounting_status: 'matched',
    inventory_status: 'restored',
    match_status: 'matched',
    restock_eligible_items: 1,
    ...over,
  };
}

/** The 4 production-shape refunded returns: 150 + 350 + 650 + 250 = 1,400 ج.م. */
function fourProductionReturns(): ReturnListItem[] {
  return [
    row({ id: '1', return_no: 'RET-2026-000004', net_refund: '150', units_count: 1 }),
    row({ id: '2', return_no: 'RET-2026-000003', net_refund: '350', units_count: 1 }),
    row({ id: '3', return_no: 'RET-2026-000002', net_refund: '650', units_count: 1 }),
    row({ id: '4', return_no: 'RET-2026-000001', net_refund: '250', units_count: 1 }),
  ];
}

function exchange(over: any = {}) {
  return {
    id: 'ex-' + (over.id ?? 'a'),
    exchange_no: 'EXC-2026-000001',
    status: 'completed',
    returned_value: 100,
    new_items_value: 150,
    price_difference: 50,
    created_at: '2026-04-26T10:05:12Z',
    completed_at: '2026-04-26T10:08:12Z',
    original_invoice_no: 'INV-2026-000099',
    new_invoice_no: 'INV-2026-000100',
    customer_name: 'فاطمة',
    customer_phone: '0100000000',
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Returns />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([row()]);
  listExchangesMock.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────
//  1. Default الكل scope — KPIs reflect the full filtered slice
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0d: default الكل scope', () => {
  // findByTestId resolves on the FIRST render where the element
  // exists — but our KPI tiles exist from render 0 (with zero values)
  // and only update once the query resolves. So all assertions on
  // value/sub content go inside `waitFor` so they retry until the
  // resolved data lands.

  it('shows إجمالي المرتجعات = 4 / 1,400 ج.م with 4 production rows', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    listExchangesMock.mockResolvedValue([]);
    renderPage();

    await waitFor(() => {
      const totalReturns = screen.getByTestId('kpi-total-returns');
      expect(totalReturns.textContent).toContain('1400 ج.م');
    });
    const totalReturns = screen.getByTestId('kpi-total-returns');
    // Count value "4" sits in the .text-xl child of the tile.
    const valueDiv = totalReturns.querySelector('.text-xl');
    expect(valueDiv?.textContent).toBe('4');
    expect(totalReturns.textContent).toContain('إجمالي المرتجعات');
    expect(totalReturns.textContent).not.toContain('مرتجعات اليوم');
  });

  it('shows تم الصرف = 1,400 ج.م / 4 عملية for the 4 refunded rows', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    await waitFor(() => {
      const refunded = screen.getByTestId('kpi-refunded');
      expect(refunded.textContent).toContain('1400 ج.م');
    });
    const refunded = screen.getByTestId('kpi-refunded');
    expect(refunded.textContent).toContain('4 عملية');
    expect(refunded.textContent).toContain('تم الصرف');
  });

  it('shows أثر المخزون = 4 (one unit per row, all back_to_stock)', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    await waitFor(() => {
      const stock = screen.getByTestId('kpi-stock-impact');
      expect(stock.textContent).toMatch(/^\D*4\D/);
    });
    expect(
      screen.getByTestId('kpi-stock-impact').textContent,
    ).toContain('قطعة عادت للمخزن');
  });

  it('shows إجمالي الاستبدالات = 0 / 0 ج.م when none returned', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    // Wait for the returns side to resolve so we know the page has
    // settled, then assert the exchanges tile.
    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('1400 ج.م');
    });
    const totalEx = screen.getByTestId('kpi-total-exchanges');
    expect(totalEx.textContent).toContain('إجمالي الاستبدالات');
    expect(totalEx.textContent).toContain('0 ج.م');
  });

  it('shows بانتظار الموافقة = 0 when no pending rows', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('1400 ج.م');
    });
    const pending = screen.getByTestId('kpi-pending');
    expect(pending.textContent).toContain('بانتظار الموافقة');
    expect(pending.textContent).toMatch(/^\D*0\D/);
  });

  it('shows يحتاج مراجعة محاسبية = 0 when all rows are matched', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('1400 ج.م');
    });
    const needs = screen.getByTestId('kpi-needs-review');
    expect(needs.textContent).toMatch(/^\D*0\D/);
  });

  it('renders the "حسب الفلاتر الحالية" scope hint', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    const hint = await screen.findByTestId('returns-kpis-scope-hint');
    expect(hint.textContent).toContain('حسب الفلاتر الحالية');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  2. Filters narrow the BE response → KPIs follow
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0d: KPIs follow filtered BE response', () => {
  it('selecting "اليوم" reduces إجمالي المرتجعات to whatever BE returns for today', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('1400 ج.م');
    });

    // BE narrows when "اليوم" is selected (simulated via the next list call).
    listMock.mockResolvedValue([
      row({ id: 'today', return_no: 'RET-2026-000005', net_refund: '100' }),
    ]);
    fireEvent.click(screen.getByTestId('returns-filter-date-today'));

    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('100 ج.م');
    });
  });

  it('typing in the search box re-fetches and KPIs update', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('1400 ج.م');
    });

    listMock.mockResolvedValue([
      row({ id: 'q', return_no: 'RET-2026-Q-MATCH', net_refund: '999' }),
    ]);
    fireEvent.change(screen.getByTestId('returns-filter-search'), {
      target: { value: 'Q-MATCH' },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('999 ج.م');
    });
  });

  it('switching to the "بانتظار الموافقة" tab → KPIs reflect only pending rows', async () => {
    listMock.mockResolvedValue([
      row({ id: 'p1', status: 'pending', net_refund: '50' }),
      row({ id: 'p2', status: 'pending', net_refund: '75' }),
    ]);
    renderPage();
    fireEvent.click(screen.getByTestId('returns-tab-pending'));

    await waitFor(() => {
      // 50 + 75 = 125 ج.م — total returns sub
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('125 ج.م');
    });
    // pending count = 2
    expect(
      screen.getByTestId('kpi-pending').textContent,
    ).toMatch(/^\D*2\D/);
    // refunded total = 0 ج.م (none refunded in this slice)
    expect(
      screen.getByTestId('kpi-refunded').textContent,
    ).toContain('0 ج.م');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  3. Exchanges scope
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0d: exchanges scope', () => {
  it('shows إجمالي الاستبدالات count + delta from the exchanges array', async () => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockResolvedValue([
      exchange({ id: '1', price_difference: 50 }),
      exchange({ id: '2', price_difference: -20 }),
      exchange({ id: '3', price_difference: 100 }),
    ]);
    renderPage();
    await waitFor(() => {
      // 50 + (−20) + 100 = 130 ج.م
      expect(
        screen.getByTestId('kpi-total-exchanges').textContent,
      ).toContain('130 ج.م');
    });
  });

  it('exchanges-only tab does NOT inflate إجمالي المرتجعات', async () => {
    listMock.mockResolvedValue([]); // tab='exchanges' disables fetchReturns; safe
    listExchangesMock.mockResolvedValue([
      exchange({ id: '1', price_difference: 50 }),
    ]);
    renderPage();
    fireEvent.click(screen.getByTestId('returns-tab-exchanges'));
    await waitFor(() => {
      // exchanges tile shows 50 ج.م
      expect(
        screen.getByTestId('kpi-total-exchanges').textContent,
      ).toContain('50 ج.م');
    });
    // returns tile stays at 0 / 0 ج.م
    expect(
      screen.getByTestId('kpi-total-returns').textContent,
    ).toContain('0 ج.م');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4. Defensive — no raw ISO/GMT, no cancel button, robust to nulls
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0d: defensive', () => {
  it('does NOT leak a raw ISO/GMT timestamp into any KPI tile', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    const grid = await screen.findByTestId('returns-kpis');
    expect(grid.textContent).not.toMatch(/\dT\d{2}:\d{2}/);
    expect(grid.textContent).not.toContain('GMT');
    expect(grid.textContent).not.toContain('Z'); // no trailing UTC marker
  });

  it('does NOT add any cancel button to the page chrome', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    renderPage();
    await screen.findByTestId('kpi-total-returns');
    expect(screen.queryByRole('button', { name: /إلغاء المرتجع/ })).toBeNull();
    expect(screen.queryByTestId(/returns-action-cancel/)).toBeNull();
  });

  it('row with null/NaN net_refund does NOT poison the total', async () => {
    listMock.mockResolvedValue([
      row({ id: '1', net_refund: '100' }),
      row({ id: '2', net_refund: null as any }),
      row({ id: '3', net_refund: 'NaN' as any }),
      row({ id: '4', net_refund: '50' }),
    ]);
    renderPage();
    await waitFor(() => {
      // 100 + 0 + 0 + 50 = 150 ج.م
      expect(
        screen.getByTestId('kpi-total-returns').textContent,
      ).toContain('150 ج.م');
    });
    // count is in the .text-xl child of the tile — directly checking
    // it avoids ambiguity with the adjacent sub-text digits.
    const valueDiv = screen
      .getByTestId('kpi-total-returns')
      .querySelector('.text-xl');
    expect(valueDiv?.textContent).toBe('4');
  });
});
