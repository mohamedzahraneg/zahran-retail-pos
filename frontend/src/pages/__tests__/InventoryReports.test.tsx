/**
 * InventoryReports.test.tsx — PR-INVENTORY-REPORTS
 *
 * Smoke + behavior tests for the new /inventory/reports page:
 *   · 4 tabs render (valuation / low-stock / dead-stock / profitability).
 *   · Branch dropdown forwards branch_id to every report API.
 *   · Group dropdown forwards group_id.
 *   · Valuation totals + items render from the response.
 *   · Source-level guard: page does NOT import any stock-mutating client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  valuation: vi.fn(),
  lowStock: vi.fn(),
  deadStock: vi.fn(),
  profitability: vi.fn(),
  listBranches: vi.fn(),
  listWarehouses: vi.fn(),
  listGroups: vi.fn(),
  listCategories: vi.fn(),
}));

vi.mock('@/api/inventory.api', async () => {
  const actual = await vi.importActual<any>('@/api/inventory.api');
  return {
    ...actual,
    inventoryApi: {
      reportValuation: (...a: any[]) => mocks.valuation(...a),
      reportLowStock: (...a: any[]) => mocks.lowStock(...a),
      reportDeadStock: (...a: any[]) => mocks.deadStock(...a),
      reportProfitability: (...a: any[]) => mocks.profitability(...a),
    },
  };
});

vi.mock('@/api/settings.api', () => ({
  settingsApi: {
    listWarehouses: (...a: any[]) => mocks.listWarehouses(...a),
  },
}));

vi.mock('@/api/branches.api', async () => {
  const actual = await vi.importActual<any>('@/api/branches.api');
  return {
    ...actual,
    branchesApi: { list: (...a: any[]) => mocks.listBranches(...a) },
  };
});

vi.mock('@/api/productGroups.api', () => ({
  productGroupsApi: { list: (...a: any[]) => mocks.listGroups(...a) },
}));

vi.mock('@/api/categories.api', () => ({
  categoriesApi: { list: (...a: any[]) => mocks.listCategories(...a) },
}));

import InventoryReports from '../InventoryReports';

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as any).mockReset?.();
  mocks.valuation.mockResolvedValue({
    totals: {
      total_qty: 100,
      total_available: 95,
      total_cost_value: 5000,
      total_sale_value: 8000,
      potential_margin: 3000,
    },
    items: [
      {
        product_id: 'p1',
        product_name: 'حقيبة A',
        sku_prefix: 'BAG',
        variant_id: 'v1',
        sku: 'BAG-RED-M',
        color: 'أحمر',
        size: 'M',
        warehouse_id: 'wh-a',
        warehouse_name: 'الرئيسي',
        quantity_on_hand: 10,
        quantity_reserved: 0,
        available_quantity: 10,
        cost_price: '50',
        selling_price: '80',
        avg_cost: '50',
        stock_cost_value: '500',
        stock_sale_value: '800',
        potential_margin: '300',
        group_ids: [],
        group_names_ar: [],
        group_colors: [],
      },
    ],
  });
  mocks.lowStock.mockResolvedValue({
    totals: { low_count: 1, out_count: 0, total_units_short: 3 },
    items: [
      {
        product_id: 'p1',
        product_name: 'حقيبة A',
        sku_prefix: 'BAG',
        variant_id: 'v1',
        sku: 'BAG-RED-M',
        color: 'أحمر',
        size: 'M',
        warehouse_id: 'wh-a',
        warehouse_name: 'الرئيسي',
        quantity_on_hand: 2,
        reorder_point: 5,
        available_quantity: 2,
        shortage_kind: 'low',
        units_short: 3,
      },
    ],
  });
  mocks.deadStock.mockResolvedValue({
    totals: {
      items_count: 0,
      total_units: 0,
      total_cost_value: 0,
      days_window: 90,
    },
    items: [],
  });
  mocks.profitability.mockResolvedValue({
    totals: {
      sold_qty: 0,
      returned_qty: 0,
      net_qty: 0,
      sales_total: 0,
      cogs_total: 0,
      gross_profit: 0,
      margin_pct: 0,
    },
    items: [],
  });
  mocks.listBranches.mockResolvedValue([
    { id: 'br-1', code: 'CAI-01', name_ar: 'فرع القاهرة' },
  ] as any);
  mocks.listWarehouses.mockResolvedValue([
    { id: 'wh-a', code: 'WH-A', name_ar: 'الرئيسي', is_active: true },
  ] as any);
  mocks.listGroups.mockResolvedValue([
    { id: 'g-1', name_ar: 'حقائب' },
  ] as any);
  mocks.listCategories.mockResolvedValue([
    { id: 'cat-1', name_ar: 'حقائب يد' },
  ] as any);
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory/reports']}>
        <InventoryReports />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<InventoryReports />', () => {
  it('renders the four tabs and the valuation summary cards by default', async () => {
    renderPage();
    await screen.findByTestId('inventory-reports-page');
    const tabs = await screen.findByTestId('reports-tabs');
    expect(within(tabs).getByTestId('reports-tab-valuation')).toBeTruthy();
    expect(within(tabs).getByTestId('reports-tab-low-stock')).toBeTruthy();
    expect(within(tabs).getByTestId('reports-tab-dead-stock')).toBeTruthy();
    expect(within(tabs).getByTestId('reports-tab-profitability')).toBeTruthy();

    // Default tab = valuation; 5 summary cards visible.
    const summary = await screen.findByTestId('reports-valuation-summary');
    expect(within(summary).getAllByTestId('reports-summary-card')).toHaveLength(5);

    // Item row renders.
    expect(
      (await screen.findAllByTestId('reports-valuation-row')).length,
    ).toBeGreaterThan(0);
  });

  it('switches to the low-stock tab and renders its summary cards + row', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('reports-tab-low-stock'));
    await screen.findByTestId('reports-low-stock-section');
    expect(
      (await screen.findAllByTestId('reports-low-stock-row')).length,
    ).toBeGreaterThan(0);
  });

  it('branch dropdown forwards branch_id to every active report query', async () => {
    renderPage();
    await screen.findByTestId('inventory-reports-page');

    const select = (await screen.findByTestId(
      'reports-branch-filter',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'br-1' } });

    await waitFor(() => {
      expect(mocks.valuation).toHaveBeenCalled();
      const last = mocks.valuation.mock.calls.at(-1)?.[0];
      expect(last?.branch_id).toBe('br-1');
    });

    // Active chip surfaces.
    expect(await screen.findByTestId('reports-chip-branch')).toBeTruthy();
  });

  it('group dropdown forwards group_id to the valuation query', async () => {
    renderPage();
    await screen.findByTestId('inventory-reports-page');
    const select = (await screen.findByTestId(
      'reports-group-filter',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'g-1' } });
    await waitFor(() => {
      const last = mocks.valuation.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g-1');
    });
  });

  it('dead-stock tab forwards days param', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('reports-tab-dead-stock'));
    await screen.findByTestId('reports-dead-stock-section');
    const daysSelect = (await screen.findByTestId(
      'reports-days-filter',
    )) as HTMLSelectElement;
    fireEvent.change(daysSelect, { target: { value: '30' } });
    await waitFor(() => {
      const last = mocks.deadStock.mock.calls.at(-1)?.[0];
      expect(last?.days).toBe(30);
    });
  });
});

describe('<InventoryReports /> — read-only invariant (source-level)', () => {
  const RAW = readFileSync(
    `${process.cwd()}/src/pages/InventoryReports.tsx`,
    'utf8',
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import direct stock / inventory write clients', () => {
    expect(SRC).not.toMatch(/@\/api\/stock\.api/);
    expect(SRC).not.toMatch(/@\/api\/stock-transfers\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory-counts\.api/);
    expect(SRC).not.toMatch(/stockApi\b/);
    expect(SRC).not.toMatch(/stockTransfersApi\b/);
    expect(SRC).not.toMatch(/inventoryCountsApi\b/);
  });

  it('does NOT use mutating http verbs anywhere', () => {
    expect(SRC).not.toMatch(/api\.post\(/);
    expect(SRC).not.toMatch(/api\.patch\(/);
    expect(SRC).not.toMatch(/api\.delete\(/);
    expect(SRC).not.toMatch(/useMutation/);
  });
});
