/**
 * Inventory.shell.test.tsx — PR-FIX-INVENTORY-UI-SHELL
 *
 * Smoke-level rendering tests for the four new shell pages. These
 * are NOT exhaustive integration tests — they verify:
 *   · the page renders with mocked data without crashing
 *   · KPI labels surface on Dashboard
 *   · Balances renders a row PER (variant × warehouse) — a variant
 *     in two groups still produces a single row, with both group
 *     names visible as badges
 *   · Movements surfaces `balance_after_qty` + `source_module` +
 *     `source_action`
 *   · Product360 matrix tab renders the colors × sizes grid with
 *     per-cell group dots
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { readFileSync } from 'node:fs';

// ─── API mocks ──────────────────────────────────────────────────────
const apiMocks = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getBalances:  vi.fn(),
  getMovements: vi.fn(),
  getProduct360: vi.fn(),
  getProductMatrix: vi.fn(),
  listWarehouses: vi.fn(async () => []),
  listGroups: vi.fn(async () => []),
  listCategories: vi.fn(async () => []),
  listColors: vi.fn(async () => []),
  listSizes: vi.fn(async () => []),
  listBranches: vi.fn(async () => []),
}));

vi.mock('@/api/inventory.api', () => ({
  inventoryApi: {
    getDashboard:      (p: any) => apiMocks.getDashboard(p),
    getBalances:       (p: any) => apiMocks.getBalances(p),
    getMovements:      (p: any) => apiMocks.getMovements(p),
    getProduct360:     (id: string) => apiMocks.getProduct360(id),
    getProductMatrix:  (id: string) => apiMocks.getProductMatrix(id),
  },
}));

vi.mock('@/api/settings.api', () => ({
  settingsApi: {
    listWarehouses: (..._a: any[]) => apiMocks.listWarehouses(),
  },
}));

vi.mock('@/api/productGroups.api', () => ({
  productGroupsApi: {
    list: (..._a: any[]) => apiMocks.listGroups(),
  },
}));

vi.mock('@/api/categories.api', () => ({
  categoriesApi: {
    list: (..._a: any[]) => apiMocks.listCategories(),
  },
}));

vi.mock('@/api/products.api', () => ({
  productsApi: {
    colors: (..._a: any[]) => apiMocks.listColors(),
    sizes:  (..._a: any[]) => apiMocks.listSizes(),
  },
}));

// PR-BRANCHES-INVENTORY-FILTERS — the three inventory pages now load
// the branch list to populate their branch dropdown. Stub it here so
// the existing tests don't suddenly start hitting an unmocked client.
vi.mock('@/api/branches.api', () => ({
  branchesApi: {
    list: (..._a: any[]) => apiMocks.listBranches(),
  },
}));

// stockApi is still mocked for safety; the new Balances page no
// longer imports it but other consumers in the suite may.
vi.mock('@/api/stock.api', () => ({
  stockApi: {
    adjust: vi.fn(),
  },
}));

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) {
    (fn as any).mockReset?.();
  }
  apiMocks.listWarehouses.mockResolvedValue([]);
  apiMocks.listGroups.mockResolvedValue([]);
  apiMocks.listCategories.mockResolvedValue([]);
  apiMocks.listColors.mockResolvedValue([]);
  apiMocks.listSizes.mockResolvedValue([]);
  apiMocks.listBranches.mockResolvedValue([]);
});

// Helper to render under the providers the pages expect.
function renderWithProviders(ui: React.ReactNode, initialEntries: string[] = ['/']) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// ──────────────────────────────────────────────────────────────────
// InventoryDashboard
// ──────────────────────────────────────────────────────────────────
import InventoryDashboard from '../InventoryDashboard';

describe('<InventoryDashboard /> — KPI cards', () => {
  it('renders all 8 KPIs from the dashboard payload', async () => {
    apiMocks.getDashboard.mockResolvedValue({
      totals: {
        total_products: 12,
        total_variants: 45,
        total_stock_qty: 617,
        total_available_qty: 600,
        total_stock_cost_value: 12345.5,
        total_stock_sale_value: 23456.75,
        low_stock_count: 3,
        out_of_stock_count: 5,
        warehouses_count: 4,
        movements_today_count: 7,
        low_stock_groups_count: 2,
      },
      top_low_stock: [],
      recent_movements: [],
      top_groups_by_stock_value: [
        { group_id: 'g1', name_ar: 'حقائب', name_en: 'Bags', color: '#0af', stock_qty: 20, stock_value: 1500 },
      ],
      top_groups_by_sales_30d: [
        { group_id: 'g1', name_ar: 'حقائب', color: '#0af', revenue_30d: 750, qty_30d: 5 },
      ],
    });

    renderWithProviders(<InventoryDashboard />);

    await screen.findByTestId('inventory-dashboard');
    const grid = await screen.findByTestId('inventory-kpi-grid');
    // 8 KPI cards (labels are: products, variants, qty, warehouses,
    // cost value, sale value, low stock, today movements).
    expect(
      within(grid).getAllByText(/المنتجات النشطة|إجمالي|قيمة|حركات|مخزون|المخازن/),
    ).toHaveLength(8);

    // Top groups sections both rendered. `حقائب` appears in BOTH
    // (the group is at the top of stock-value AND of sales-30d), so
    // we scope to each section testid before asserting.
    const valueSection = screen.getByTestId('top-groups-value');
    expect(within(valueSection).getByText('حقائب')).toBeTruthy();

    const salesSection = screen.getByTestId('top-groups-sales');
    expect(within(salesSection).getByText('حقائب')).toBeTruthy();
  });

  it('renders error state when the request fails', async () => {
    apiMocks.getDashboard.mockRejectedValue(new Error('500 boom'));
    renderWithProviders(<InventoryDashboard />);
    await screen.findByTestId('inventory-dashboard-error');
  });
});

// ──────────────────────────────────────────────────────────────────
// InventoryBalances — group badges + no row duplication
// ──────────────────────────────────────────────────────────────────
import InventoryBalances from '../InventoryBalances';

describe('<InventoryBalances /> — group badges + row dedupe', () => {
  it('renders ONE row per (variant × warehouse) even when the variant belongs to 2 groups', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: [
        {
          product_id: 'p1',
          product_name: 'حقيبة A',
          sku_prefix: 'BAG',
          variant_id: 'v1',
          sku: 'BAG-RED-M',
          barcode: null,
          cost_price: 50,
          selling_price: 100,
          color_id: 'c1',
          color_name: 'أحمر',
          size_id: 's1',
          size_label: 'M',
          warehouse_id: 'w1',
          warehouse_name: 'الرئيسي',
          quantity_on_hand: 5,
          quantity_reserved: 0,
          available_quantity: 5,
          reorder_point: 0,
          avg_cost: 0,
          stock_cost_value: 250,
          stock_sale_value: 500,
          last_movement_at: null,
          group_ids: ['g1', 'g2'],
          group_names_ar: ['حقائب', 'صيف'],
          group_names_en: ['Bags', null],
          group_colors: ['#0af', null],
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    });

    renderWithProviders(<InventoryBalances />);
    await screen.findByTestId('inventory-balances');

    // Exactly ONE row even with two groups attached.
    await waitFor(() => {
      expect(screen.getAllByTestId('balances-row')).toHaveLength(1);
    });

    // Both group names visible as badges.
    const badges = screen.getByTestId('balance-group-badges');
    expect(within(badges).getByText('حقائب')).toBeTruthy();
    expect(within(badges).getByText('صيف')).toBeTruthy();
  });

  it('renders empty state when no balances match the filters', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    });
    renderWithProviders(<InventoryBalances />);
    await screen.findByText(/لا توجد أرصدة مطابقة/);
  });
});

// ──────────────────────────────────────────────────────────────────
// InventoryMovements — surfaces balance_after_qty + source columns
// ──────────────────────────────────────────────────────────────────
import InventoryMovements from '../InventoryMovements';

describe('<InventoryMovements /> — new audit columns', () => {
  it('renders balance_after_qty + source_module + source_action + reference_type', async () => {
    apiMocks.getMovements.mockResolvedValue({
      items: [
        {
          id: '999',
          created_at: '2026-05-19T10:00:00Z',
          movement_type: 'transfer_out',
          direction: 'out',
          quantity: 3,
          unit_cost: 0,
          reference_type: 'stock_transfer',
          reference_id: 'tr-abc',
          source_module: 'stock_transfers',
          source_action: 'ship',
          balance_after_qty: 17,
          notes: null,
          variant_id: 'v1',
          sku: 'BAG-RED-M',
          barcode: null,
          product_id: 'p1',
          product_name: 'حقيبة A',
          sku_prefix: 'BAG',
          warehouse_id: 'w1',
          warehouse_name: 'الرئيسي',
          user_id: null,
          user_name: null,
          user_username: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 100,
    });

    renderWithProviders(<InventoryMovements />);
    await screen.findByTestId('inventory-movements');

    const row = await screen.findByTestId('movements-row');
    expect(within(row).getByTestId('movement-balance-after').textContent).toContain('17');
    const source = within(row).getByTestId('movement-source');
    expect(source.textContent).toContain('stock_transfers');
    expect(source.textContent).toContain('ship');
    // The reference cell renders an Arabic label + ext-link icon + the
    // raw reference_id. For stock_transfer, the label is "تحويل مخزني".
    const refCell = within(row).getByTestId('movement-reference');
    expect(refCell.textContent).toContain('تحويل مخزني');
    expect(refCell.textContent).toContain('tr-abc');
    // The link target is the /stock-transfers route.
    const refLink = within(row).getByTestId(
      'movement-reference-link',
    ) as HTMLAnchorElement;
    expect(refLink.getAttribute('href')).toContain('/stock-transfers');
  });
});

// ──────────────────────────────────────────────────────────────────
// Product360 — matrix tab with group dots per cell
// ──────────────────────────────────────────────────────────────────
import Product360 from '../Product360';

// Shared fixtures for the matrix tests below.
const TWO_GROUP_CELL = {
  variant_id: 'v1',
  color_id: 'c1',
  size_id: 's1',
  sku: 'BAG-RED-M',
  barcode: null,
  cost_price: 50,
  selling_price: 100,
  is_active: true,
  total_qty: 5,
  available_qty: 5,
  per_warehouse: [
    {
      warehouse_id: 'w1',
      warehouse_name: 'الرئيسي',
      quantity_on_hand: 3,
      quantity_reserved: 0,
      available_quantity: 3,
    },
    {
      warehouse_id: 'w2',
      warehouse_name: 'الفرع',
      quantity_on_hand: 2,
      quantity_reserved: 0,
      available_quantity: 2,
    },
  ],
  group_ids: ['g1', 'g2'],
  group_names_ar: ['حقائب', 'صيف'],
  group_names_en: ['Bags', null],
  group_colors: ['#0af', null],
};

const BASE_MATRIX_RESPONSE = {
  product: { id: 'p1', sku_prefix: 'BAG', name_ar: 'حقيبة', name_en: 'Bag' },
  colors: [{ id: 'c1', name_ar: 'أحمر', name_en: 'Red', hex_code: '#f00' }],
  sizes: [{ id: 's1', size_label: 'M', size_system: 'EU', sort_order: 1 }],
  cells: [TWO_GROUP_CELL],
};

// The Overview tab loads /360 even when /matrix is the active route
// (it's used to derive the local filter dropdowns), so every matrix
// test needs a benign /360 mock. Empty arrays are fine — Matrix tab
// doesn't render any of the Overview surface.
function stubEmptyOverview(productId = 'p1') {
  apiMocks.getProduct360.mockResolvedValue({
    product: {
      id: productId,
      sku_prefix: 'BAG',
      name_ar: 'حقيبة',
      name_en: 'Bag',
      description_ar: null,
      description_en: null,
      product_type: 'bag',
      target_audience: 'women',
      category_id: null,
      category_name: null,
      brand_id: null,
      brand_name: null,
      base_cost: 0,
      base_price: 0,
      suggested_price: 0,
      min_margin_pct: 0,
      track_inventory: true,
      is_active: true,
      created_at: '',
      updated_at: '',
      deleted_at: null,
    },
    product_groups: [],
    variants: [],
    stock_by_warehouse: [],
    totals: {
      total_qty: 0,
      total_available: 0,
      total_cost_value: 0,
      total_sale_value: 0,
      sold_qty_30d: 0,
      sold_revenue_30d: 0,
      sold_cost_30d: 0,
      returned_qty_30d: 0,
      gross_profit_30d: 0,
    },
    recent_movements: [],
    recent_invoice_items: [],
    recent_purchase_items: [],
    price_history: [],
    cost_history: [],
  });
}

describe('<Product360 /> — matrix tab', () => {
  it('renders the colors × sizes grid with per-cell group dots', async () => {
    stubEmptyOverview('p1');
    apiMocks.getProductMatrix.mockResolvedValue(BASE_MATRIX_RESPONSE);

    renderWithProviders(
      <Routes>
        <Route path="/products/:id/matrix" element={<Product360 />} />
      </Routes>,
      ['/products/p1/matrix'],
    );

    await screen.findByTestId('product-matrix');
    // One matrix cell.
    const cells = screen.getAllByTestId('matrix-cell');
    expect(cells).toHaveLength(1);
    // Group dots present.
    const groupDots = within(cells[0]).getByTestId('matrix-cell-groups');
    // Two dots = two groups, ONE cell (no row multiplication).
    expect(groupDots.children).toHaveLength(2);
    // Stock status badge surfaces as "متاح" (ok).
    expect(
      within(cells[0]).getByTestId('stock-status-badge'),
    ).toBeTruthy();
  });

  it('shows an empty state when the product has no variants', async () => {
    stubEmptyOverview('p2');
    apiMocks.getProductMatrix.mockResolvedValue({
      product: { id: 'p2', sku_prefix: 'X', name_ar: 'منتج', name_en: null },
      colors: [],
      sizes: [],
      cells: [],
    });
    renderWithProviders(
      <Routes>
        <Route path="/products/:id/matrix" element={<Product360 />} />
      </Routes>,
      ['/products/p2/matrix'],
    );
    await screen.findByText(/لا توجد متغيرات لإنشاء شبكة/);
  });

  // ────────────────────────────────────────────────────────────────
  // PR-FIX-PRODUCT-360-ENHANCEMENT — local filters
  //
  // Filters operate purely on already-loaded data. None of them
  // triggers a new API call (the inventoryApi mocks would track
  // that — see the no-mutation guard at the bottom of this file).
  // ────────────────────────────────────────────────────────────────
  it('group filter hides matrix cells whose variant is not in the chosen group', async () => {
    stubEmptyOverview('p1');
    apiMocks.getProductMatrix.mockResolvedValue({
      ...BASE_MATRIX_RESPONSE,
      cells: [
        // Cell A — belongs to group g1 only.
        {
          ...TWO_GROUP_CELL,
          variant_id: 'vA',
          sku: 'BAG-RED-M',
          group_ids: ['g1'],
          group_names_ar: ['حقائب'],
          group_names_en: ['Bags'],
          group_colors: ['#0af'],
        },
        // Cell B — belongs to group g2 only, different size.
        {
          ...TWO_GROUP_CELL,
          variant_id: 'vB',
          color_id: 'c1',
          size_id: 's2',
          sku: 'BAG-RED-L',
          group_ids: ['g2'],
          group_names_ar: ['صيف'],
          group_names_en: [null],
          group_colors: [null],
        },
      ],
      sizes: [
        { id: 's1', size_label: 'M', size_system: 'EU', sort_order: 1 },
        { id: 's2', size_label: 'L', size_system: 'EU', sort_order: 2 },
      ],
    });

    renderWithProviders(
      <Routes>
        <Route path="/products/:id/matrix" element={<Product360 />} />
      </Routes>,
      ['/products/p1/matrix'],
    );

    await screen.findByTestId('product-matrix');
    // Before filter: both cells visible.
    expect(screen.getAllByTestId('matrix-cell-content')).toHaveLength(2);

    // Pick the "حقائب" group from the filter.
    const groupSelect = screen.getByTestId('filter-group') as HTMLSelectElement;
    fireEvent.change(groupSelect, { target: { value: 'g1' } });

    await waitFor(() => {
      expect(screen.getAllByTestId('matrix-cell-content')).toHaveLength(1);
    });
    // The single remaining cell is the vA SKU.
    expect(
      within(screen.getByTestId('matrix-cell-content')).getByText('BAG-RED-M'),
    ).toBeTruthy();
  });

  it('warehouse filter re-projects matrix cells against the selected warehouse', async () => {
    stubEmptyOverview('p1');
    apiMocks.getProductMatrix.mockResolvedValue(BASE_MATRIX_RESPONSE);

    renderWithProviders(
      <Routes>
        <Route path="/products/:id/matrix" element={<Product360 />} />
      </Routes>,
      ['/products/p1/matrix'],
    );

    await screen.findByTestId('product-matrix');
    // Default cell available_qty = 5 across both warehouses.
    const cellBefore = screen.getByTestId('matrix-cell-content');
    expect(cellBefore.textContent).toContain('5');

    // Pick w1 — that warehouse holds 3 of the 5 units.
    const whSelect = screen.getByTestId('filter-warehouse') as HTMLSelectElement;
    fireEvent.change(whSelect, { target: { value: 'w1' } });

    await waitFor(() => {
      const cellAfter = screen.getByTestId('matrix-cell-content');
      // The projected cell shows w1's 3 units, NOT the 5 total.
      expect(cellAfter.textContent).toContain('3');
    });
  });

  it('out-of-stock filter hides cells with non-zero total qty', async () => {
    stubEmptyOverview('p1');
    apiMocks.getProductMatrix.mockResolvedValue({
      ...BASE_MATRIX_RESPONSE,
      cells: [TWO_GROUP_CELL],
    });

    renderWithProviders(
      <Routes>
        <Route path="/products/:id/matrix" element={<Product360 />} />
      </Routes>,
      ['/products/p1/matrix'],
    );

    await screen.findByTestId('product-matrix');
    expect(screen.getAllByTestId('matrix-cell-content')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('filter-out-of-stock'));

    await waitFor(() => {
      expect(
        screen.getByTestId('product-matrix-empty-after-filter'),
      ).toBeTruthy();
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-FIX-PRODUCT-360-ENHANCEMENT — Overview enhancements
// ──────────────────────────────────────────────────────────────────
describe('<Product360 /> — overview enhancements', () => {
  const RICH_OVERVIEW = {
    product: {
      id: 'p1',
      sku_prefix: 'BAG-2026',
      name_ar: 'حقيبة فاخرة',
      name_en: 'Premium Bag',
      description_ar: null,
      description_en: null,
      product_type: 'bag',
      target_audience: 'women',
      category_id: 'cat-1',
      category_name: 'حقائب يد',
      brand_id: 'br-1',
      brand_name: 'Acme',
      base_cost: 50,
      base_price: 100,
      suggested_price: 120,
      min_margin_pct: 15,
      track_inventory: true,
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
      deleted_at: null,
    },
    product_groups: [
      { group_id: 'g1', name_ar: 'حقائب', name_en: 'Bags', color: '#0af' },
    ],
    variants: [
      {
        variant_id: 'v1',
        sku: 'BAG-RED-M',
        barcode: '123',
        color_id: 'c1',
        color_name: 'أحمر',
        hex_code: '#f00',
        size_id: 's1',
        size_label: 'M',
        size_sort: 1,
        cost_price: 50,
        selling_price: 100,
        weight_grams: 400,
        is_active: true,
        total_qty: 5,
        total_reserved: 0,
        total_available: 5,
        group_ids: ['g1'],
        group_names_ar: ['حقائب'],
        group_names_en: ['Bags'],
        group_colors: ['#0af'],
      },
    ],
    stock_by_warehouse: [
      {
        variant_id: 'v1',
        sku: 'BAG-RED-M',
        warehouse_id: 'w1',
        warehouse_name: 'الرئيسي',
        quantity_on_hand: 5,
        quantity_reserved: 0,
        available_quantity: 5,
        reorder_point: 0,
        avg_cost: null,
        updated_at: '2026-05-01T00:00:00Z',
      },
    ],
    totals: {
      total_qty: 5,
      total_available: 5,
      total_cost_value: 250,
      total_sale_value: 500,
      sold_qty_30d: 3,
      sold_revenue_30d: 300,
      sold_cost_30d: 150,
      returned_qty_30d: 1,
      gross_profit_30d: 150,
    },
    recent_movements: [],
    recent_invoice_items: [],
    recent_purchase_items: [],
    price_history: [],
    cost_history: [],
  };

  it('renders the rich product header with status badge + category/brand chips', async () => {
    apiMocks.getProduct360.mockResolvedValue(RICH_OVERVIEW);
    renderWithProviders(
      <Routes>
        <Route path="/products/:id" element={<Product360 />} />
      </Routes>,
      ['/products/p1'],
    );

    await screen.findByTestId('product-360-header');
    expect(screen.getByTestId('product-360-name').textContent).toContain(
      'حقيبة فاخرة',
    );
    expect(screen.getByTestId('product-360-status').textContent).toContain(
      'نشط',
    );
    // Category + brand chips visible inside the header strip.
    const header = screen.getByTestId('product-360-header');
    expect(within(header).getByText('حقائب يد')).toBeTruthy();
    expect(within(header).getByText('Acme')).toBeTruthy();
    // Image placeholder slot is present (real image lands later).
    expect(screen.getByTestId('product-360-image')).toBeTruthy();
  });

  it('renders 8 KPI cards including a derived margin% from gross_profit / revenue', async () => {
    apiMocks.getProduct360.mockResolvedValue(RICH_OVERVIEW);
    renderWithProviders(
      <Routes>
        <Route path="/products/:id" element={<Product360 />} />
      </Routes>,
      ['/products/p1'],
    );

    await screen.findByTestId('product-360-totals');
    const cards = screen.getAllByTestId('stat-card');
    expect(cards).toHaveLength(8);
    // Margin% derived: 150 / 300 = 50% → rendered with the "٪" suffix.
    const totals = screen.getByTestId('product-360-totals');
    expect(within(totals).getByText(/50.*٪/)).toBeTruthy();
  });

  it('renders empty-state copy for every section that has no data', async () => {
    // Strip everything except product + one variant. Both Overview
    // and the matrix-derived warehouse list are empty; every detail
    // section should fall back to its empty state.
    apiMocks.getProduct360.mockResolvedValue({
      ...RICH_OVERVIEW,
      stock_by_warehouse: [],
      recent_movements: [],
      recent_invoice_items: [],
      recent_purchase_items: [],
      price_history: [],
      cost_history: [],
    });

    renderWithProviders(
      <Routes>
        <Route path="/products/:id" element={<Product360 />} />
      </Routes>,
      ['/products/p1'],
    );

    await screen.findByTestId('product-360-overview');
    // 6 sections without data → 6 empty-section markers.
    // (Variants section has 1 row, so it doesn't go empty.)
    const empties = screen.getAllByTestId('empty-section');
    expect(empties.length).toBeGreaterThanOrEqual(6);
  });

  it('variants table renders the stock status badge + group chip per variant', async () => {
    apiMocks.getProduct360.mockResolvedValue(RICH_OVERVIEW);
    renderWithProviders(
      <Routes>
        <Route path="/products/:id" element={<Product360 />} />
      </Routes>,
      ['/products/p1'],
    );

    const row = await screen.findByTestId('product-360-variant-row');
    expect(within(row).getByTestId('stock-status-badge')).toBeTruthy();
    expect(within(row).getByTestId('group-badges')).toBeTruthy();
  });

  it('Overview group filter narrows the variants list locally', async () => {
    apiMocks.getProduct360.mockResolvedValue({
      ...RICH_OVERVIEW,
      variants: [
        { ...RICH_OVERVIEW.variants[0], variant_id: 'v1' },
        {
          ...RICH_OVERVIEW.variants[0],
          variant_id: 'v2',
          sku: 'BAG-BLUE-L',
          group_ids: ['g2'],
          group_names_ar: ['صيف'],
          group_names_en: [null],
          group_colors: [null],
        },
      ],
    });
    renderWithProviders(
      <Routes>
        <Route path="/products/:id" element={<Product360 />} />
      </Routes>,
      ['/products/p1'],
    );
    await screen.findByTestId('product-360-overview');
    expect(screen.getAllByTestId('product-360-variant-row')).toHaveLength(2);

    fireEvent.change(screen.getByTestId('filter-group'), {
      target: { value: 'g1' },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('product-360-variant-row')).toHaveLength(1);
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-FIX-PRODUCT-360-ENHANCEMENT — read-only invariant
// ──────────────────────────────────────────────────────────────────
describe('Product360 — read-only invariant (source-level)', () => {
  // Resolve relative to the FE root (vitest is launched from there)
  // — `import.meta.url` returns a vite-node:// scheme that
  // readFileSync rejects, so a plain cwd-relative path is the
  // portable choice across the existing source-level guard specs.
  const RAW_SRC = readFileSync(
    `${process.cwd()}/src/pages/Product360.tsx`,
    'utf8',
  );

  // Strip `//` line + block comments so doc strings that reference
  // forbidden APIs (e.g. "No useMutation from React Query.") don't
  // trip the guard.
  const SRC = RAW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import useMutation', () => {
    expect(SRC).not.toMatch(/useMutation/);
  });

  it('does NOT call inventoryApi mutating methods', () => {
    // Belt-and-braces: ensure none of the standard mutation verbs
    // appear against the api object.
    expect(SRC).not.toMatch(/inventoryApi\.create|inventoryApi\.update|inventoryApi\.delete/);
    expect(SRC).not.toMatch(/api\.post\(|api\.patch\(|api\.delete\(/);
  });

  it('any future "edit" affordance must be disabled (no enabled buttons writing data)', () => {
    // The page may surface coming-soon links / disabled tabs, but
    // not active edit buttons. We scan for the common write-related
    // labels and assert they're either absent or wrapped in
    // `disabled` / `aria-disabled`.
    const editish = /حفظ|تعديل سعر|تعديل تكلفة|تعديل الكمية|تطبيق/g;
    const matches = SRC.match(editish) ?? [];
    expect(matches).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-FIX-INVENTORY-UX-BALANCES-MOVEMENTS — Balances UX
// ──────────────────────────────────────────────────────────────────
const SAMPLE_BALANCE_ROWS = [
  {
    product_id: 'p1',
    product_name: 'حقيبة A',
    sku_prefix: 'BAG',
    variant_id: 'v1',
    sku: 'BAG-RED-M',
    barcode: '111',
    cost_price: 50,
    selling_price: 100,
    color_id: 'c1',
    color_name: 'أحمر',
    size_id: 's1',
    size_label: 'M',
    warehouse_id: 'w1',
    warehouse_name: 'الرئيسي',
    quantity_on_hand: 10,
    quantity_reserved: 1,
    available_quantity: 9,
    reorder_point: 5,
    avg_cost: 50,
    stock_cost_value: 500,
    stock_sale_value: 1000,
    last_movement_at: '2026-05-10T10:00:00Z',
    group_ids: ['g1'],
    group_names_ar: ['حقائب'],
    group_names_en: ['Bags'],
    group_colors: ['#0af'],
  },
  {
    product_id: 'p2',
    product_name: 'حقيبة B',
    sku_prefix: 'BAG',
    variant_id: 'v2',
    sku: 'BAG-BLUE-L',
    barcode: '222',
    cost_price: 60,
    selling_price: 120,
    color_id: 'c2',
    color_name: 'أزرق',
    size_id: 's2',
    size_label: 'L',
    warehouse_id: 'w1',
    warehouse_name: 'الرئيسي',
    quantity_on_hand: 2,
    quantity_reserved: 0,
    available_quantity: 2,
    reorder_point: 5,
    avg_cost: 60,
    stock_cost_value: 120,
    stock_sale_value: 240,
    last_movement_at: '2026-05-12T10:00:00Z',
    group_ids: [],
    group_names_ar: [],
    group_names_en: [],
    group_colors: [],
  },
  {
    product_id: 'p3',
    product_name: 'حقيبة C',
    sku_prefix: 'BAG',
    variant_id: 'v3',
    sku: 'BAG-BLACK-S',
    barcode: null,
    cost_price: 30,
    selling_price: 80,
    color_id: null,
    color_name: null,
    size_id: null,
    size_label: null,
    warehouse_id: 'w1',
    warehouse_name: 'الرئيسي',
    quantity_on_hand: 0,
    quantity_reserved: 0,
    available_quantity: 0,
    reorder_point: 3,
    avg_cost: 30,
    stock_cost_value: 0,
    stock_sale_value: 0,
    last_movement_at: null,
    group_ids: [],
    group_names_ar: [],
    group_names_en: [],
    group_colors: [],
  },
];

describe('<InventoryBalances /> — UX enhancements', () => {
  it('renders 8 summary cards with page totals (qty / available / cost / sale / low / out / filters)', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: SAMPLE_BALANCE_ROWS,
      total: 3,
      page: 1,
      limit: 50,
    });

    renderWithProviders(<InventoryBalances />);
    await screen.findByTestId('inventory-balances');

    const summary = await screen.findByTestId('balances-summary');
    const cards = within(summary).getAllByTestId('balances-summary-card');
    expect(cards).toHaveLength(8);

    // Totals derived from the 3 rows above:
    //  - rows = 3, variants = 3
    //  - qty = 10 + 2 + 0 = 12, available = 9 + 2 + 0 = 11
    //  - cost_value = 500 + 120 + 0 = 620
    //  - sale_value = 1000 + 240 + 0 = 1240
    //  - low: row 2 (2 <= 5, on-hand > 0) → 1
    //  - out: row 3 (on-hand <= 0) → 1
    expect(summary.textContent).toContain('12');     // qty
    expect(summary.textContent).toContain('11');     // available
    expect(summary.textContent).toContain('620');    // cost value
    expect(summary.textContent).toContain('1,240');  // sale value
  });

  it('exposes the new filter dropdowns (warehouse, category, group, color, size)', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    });
    apiMocks.listCategories.mockResolvedValue([
      { id: 'cat-1', name_ar: 'حقائب يد' },
    ] as any);
    apiMocks.listColors.mockResolvedValue([
      { id: 'c1', name_ar: 'أحمر' },
    ] as any);
    apiMocks.listSizes.mockResolvedValue([
      { id: 's1', size_label: 'M' },
    ] as any);

    renderWithProviders(<InventoryBalances />);
    await screen.findByTestId('inventory-balances');

    expect(screen.getByTestId('balances-warehouse-filter')).toBeTruthy();
    expect(screen.getByTestId('balances-category-filter')).toBeTruthy();
    expect(screen.getByTestId('balances-group-filter')).toBeTruthy();
    expect(screen.getByTestId('balances-color-filter')).toBeTruthy();
    expect(screen.getByTestId('balances-size-filter')).toBeTruthy();
  });

  it('shows active filter chips when a filter is set, and clearing one removes only that chip', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: SAMPLE_BALANCE_ROWS,
      total: 3,
      page: 1,
      limit: 50,
    });

    renderWithProviders(<InventoryBalances />);
    await screen.findByTestId('inventory-balances');

    // Initially no chips.
    expect(screen.queryByTestId('balances-active-chips')).toBeNull();

    fireEvent.click(screen.getByTestId('balances-low-stock'));
    const chips = await screen.findByTestId('balances-active-chips');
    expect(within(chips).getByTestId('balances-chip-low')).toBeTruthy();

    // Clear the chip → state resets.
    fireEvent.click(screen.getByTestId('balances-chip-low'));
    await waitFor(() => {
      expect(screen.queryByTestId('balances-active-chips')).toBeNull();
    });
    // Checkbox reflects the cleared state.
    expect(
      (screen.getByTestId('balances-low-stock') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('clear-all button wipes every active filter at once', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: SAMPLE_BALANCE_ROWS,
      total: 3,
      page: 1,
      limit: 50,
    });

    renderWithProviders(<InventoryBalances />);
    await screen.findByTestId('inventory-balances');

    fireEvent.click(screen.getByTestId('balances-low-stock'));
    await screen.findByTestId('balances-chip-low');

    fireEvent.click(screen.getByTestId('balances-clear-filters'));
    await waitFor(() => {
      expect(screen.queryByTestId('balances-active-chips')).toBeNull();
    });
  });

  it('renders status badges (out / low / ok) AND action links per row', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: SAMPLE_BALANCE_ROWS,
      total: 3,
      page: 1,
      limit: 50,
    });

    renderWithProviders(<InventoryBalances />);
    await screen.findByTestId('inventory-balances');

    const rows = await screen.findAllByTestId('balances-row');
    expect(rows).toHaveLength(3);

    const statuses = rows.map(
      (r) =>
        within(r)
          .getByTestId('balance-status-badge')
          .getAttribute('data-status'),
    );
    expect(statuses).toContain('ok');
    expect(statuses).toContain('low');
    expect(statuses).toContain('out');

    // Every row has the two action links.
    for (const r of rows) {
      const actions = within(r).getByTestId('balances-row-actions');
      expect(within(actions).getByTestId('balances-action-product')).toBeTruthy();
      expect(within(actions).getByTestId('balances-action-movements')).toBeTruthy();
    }

    // Movements link is variant-scoped.
    const firstAction = within(rows[0]).getByTestId(
      'balances-action-movements',
    ) as HTMLAnchorElement;
    expect(firstAction.getAttribute('href')).toContain('variant_id=v1');
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-FIX-INVENTORY-UX-BALANCES-MOVEMENTS — Movements UX
// ──────────────────────────────────────────────────────────────────
const SAMPLE_MOVEMENT_ROWS = [
  {
    id: 'm1',
    created_at: '2026-05-15T10:00:00Z',
    movement_type: 'purchase',
    direction: 'in' as const,
    quantity: 10,
    unit_cost: 5,
    reference_type: 'purchase',
    reference_id: 'pu-1',
    source_module: 'purchases',
    source_action: 'receive',
    balance_after_qty: 30,
    notes: 'دفعة جديدة',
    variant_id: 'v1',
    sku: 'BAG-RED-M',
    barcode: '111',
    product_id: 'p1',
    product_name: 'حقيبة A',
    sku_prefix: 'BAG',
    warehouse_id: 'w1',
    warehouse_name: 'الرئيسي',
    user_id: 'u1',
    user_name: 'محمد',
    user_username: 'mohammed',
  },
  {
    id: 'm2',
    created_at: '2026-05-16T10:00:00Z',
    movement_type: 'sale',
    direction: 'out' as const,
    quantity: 3,
    unit_cost: 5,
    reference_type: 'sale',
    reference_id: 'sa-1',
    source_module: 'pos',
    source_action: 'sell',
    balance_after_qty: 27,
    notes: null,
    variant_id: 'v1',
    sku: 'BAG-RED-M',
    barcode: '111',
    product_id: 'p1',
    product_name: 'حقيبة A',
    sku_prefix: 'BAG',
    warehouse_id: 'w1',
    warehouse_name: 'الرئيسي',
    user_id: 'u2',
    user_name: 'علي',
    user_username: 'ali',
  },
  {
    id: 'm3',
    created_at: '2026-05-17T10:00:00Z',
    movement_type: 'transfer_out',
    direction: 'out' as const,
    quantity: 2,
    unit_cost: null,
    reference_type: 'stock_transfer',
    reference_id: 'tr-1',
    source_module: 'stock_transfers',
    source_action: 'ship',
    balance_after_qty: null,
    notes: null,
    variant_id: 'v1',
    sku: 'BAG-RED-M',
    barcode: '111',
    product_id: 'p1',
    product_name: 'حقيبة A',
    sku_prefix: 'BAG',
    warehouse_id: 'w1',
    warehouse_name: 'الرئيسي',
    user_id: null,
    user_name: null,
    user_username: null,
  },
];

describe('<InventoryMovements /> — UX enhancements', () => {
  it('renders 7 summary cards with in/out/net + reference + balance + active-filters counts', async () => {
    apiMocks.getMovements.mockResolvedValue({
      items: SAMPLE_MOVEMENT_ROWS,
      total: 3,
      page: 1,
      limit: 100,
    });

    renderWithProviders(<InventoryMovements />);
    await screen.findByTestId('inventory-movements');

    const summary = await screen.findByTestId('movements-summary');
    const cards = within(summary).getAllByTestId('movements-summary-card');
    expect(cards).toHaveLength(7);

    // in_qty = 10, out_qty = 3 + 2 = 5, net = +5
    // with_reference = 3 (all rows), with_balance_after = 2 (m1, m2)
    expect(summary.textContent).toContain('10');
    expect(summary.textContent).toContain('5');
    expect(summary.textContent).toContain('+5');
  });

  it('reference cells navigate to the originating module', async () => {
    apiMocks.getMovements.mockResolvedValue({
      items: SAMPLE_MOVEMENT_ROWS,
      total: 3,
      page: 1,
      limit: 100,
    });

    renderWithProviders(<InventoryMovements />);
    const rows = await screen.findAllByTestId('movements-row');

    // purchase reference → /purchases
    const purLink = within(rows[0]).getByTestId(
      'movement-reference-link',
    ) as HTMLAnchorElement;
    expect(purLink.getAttribute('href')).toContain('/purchases');

    // stock_transfer reference → /stock-transfers
    const trLink = within(rows[2]).getByTestId(
      'movement-reference-link',
    ) as HTMLAnchorElement;
    expect(trLink.getAttribute('href')).toContain('/stock-transfers');
  });

  it('reads variant_id from the URL and surfaces it as a removable chip', async () => {
    apiMocks.getMovements.mockResolvedValue({
      items: SAMPLE_MOVEMENT_ROWS,
      total: 3,
      page: 1,
      limit: 100,
    });

    renderWithProviders(
      <InventoryMovements />,
      ['/inventory/movements?variant_id=v1'],
    );
    await screen.findByTestId('inventory-movements');

    // Server was called with variant_id locked in.
    await waitFor(() => {
      expect(apiMocks.getMovements).toHaveBeenCalled();
      const lastCallArgs = apiMocks.getMovements.mock.calls.at(-1)?.[0];
      expect(lastCallArgs?.variant_id).toBe('v1');
    });

    // Chip is rendered and clearing it strips the filter.
    const chip = await screen.findByTestId('movements-chip-variant');
    expect(chip.textContent).toContain('BAG-RED-M');
    fireEvent.click(chip);

    await waitFor(() => {
      expect(screen.queryByTestId('movements-chip-variant')).toBeNull();
    });
  });

  it('reads product_id from the URL and forwards it to the API', async () => {
    apiMocks.getMovements.mockResolvedValue({
      items: SAMPLE_MOVEMENT_ROWS,
      total: 3,
      page: 1,
      limit: 100,
    });

    renderWithProviders(
      <InventoryMovements />,
      ['/inventory/movements?product_id=p1'],
    );
    await screen.findByTestId('inventory-movements');

    await waitFor(() => {
      const lastCallArgs = apiMocks.getMovements.mock.calls.at(-1)?.[0];
      expect(lastCallArgs?.product_id).toBe('p1');
    });

    expect(screen.getByTestId('movements-chip-product')).toBeTruthy();
  });

  it('clear-all button wipes the active filters', async () => {
    apiMocks.getMovements.mockResolvedValue({
      items: SAMPLE_MOVEMENT_ROWS,
      total: 3,
      page: 1,
      limit: 100,
    });

    renderWithProviders(
      <InventoryMovements />,
      ['/inventory/movements?variant_id=v1'],
    );
    await screen.findByTestId('movements-chip-variant');

    fireEvent.click(screen.getByTestId('movements-clear-filters'));

    await waitFor(() => {
      expect(screen.queryByTestId('movements-active-chips')).toBeNull();
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-BRANCHES-INVENTORY-FILTERS — branch dropdown on the three pages
// ──────────────────────────────────────────────────────────────────
const SAMPLE_BRANCH = {
  id: 'br-1',
  code: 'CAI-01',
  name_ar: 'فرع القاهرة',
  name_en: 'Cairo',
  type: 'retail',
  is_active: true,
};

describe('Inventory pages — branch dropdown (PR-BRANCHES-INVENTORY-FILTERS)', () => {
  it('Balances: renders the branch dropdown and selecting one sends branch_id', async () => {
    apiMocks.getBalances.mockResolvedValue({
      items: SAMPLE_BALANCE_ROWS,
      total: SAMPLE_BALANCE_ROWS.length,
      page: 1,
      limit: 50,
    });
    apiMocks.listBranches.mockResolvedValue([SAMPLE_BRANCH] as any);

    renderWithProviders(<InventoryBalances />);
    await screen.findByTestId('inventory-balances');

    const select = (await screen.findByTestId(
      'balances-branch-filter',
    )) as HTMLSelectElement;
    expect(select).toBeTruthy();
    // The branch list dropdown must include the branch we mocked.
    await waitFor(() => {
      expect(within(select).getByText('فرع القاهرة')).toBeTruthy();
    });

    fireEvent.change(select, { target: { value: 'br-1' } });

    // After picking the branch the server is called with branch_id.
    await waitFor(() => {
      const lastCall = apiMocks.getBalances.mock.calls.at(-1)?.[0];
      expect(lastCall?.branch_id).toBe('br-1');
    });

    // And an active chip appears.
    const chip = await screen.findByTestId('balances-chip-branch');
    expect(chip.textContent).toContain('فرع القاهرة');

    // Clearing the chip strips branch_id from the next API call.
    fireEvent.click(chip);
    await waitFor(() => {
      const lastCall = apiMocks.getBalances.mock.calls.at(-1)?.[0];
      expect(lastCall?.branch_id).toBeUndefined();
    });
  });

  it('Movements: branch dropdown forwards branch_id and shows a removable chip', async () => {
    apiMocks.getMovements.mockResolvedValue({
      items: SAMPLE_MOVEMENT_ROWS,
      total: SAMPLE_MOVEMENT_ROWS.length,
      page: 1,
      limit: 100,
    });
    apiMocks.listBranches.mockResolvedValue([SAMPLE_BRANCH] as any);

    renderWithProviders(<InventoryMovements />);
    await screen.findByTestId('inventory-movements');

    const select = (await screen.findByTestId(
      'movements-branch-filter',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'br-1' } });

    await waitFor(() => {
      const lastCall = apiMocks.getMovements.mock.calls.at(-1)?.[0];
      expect(lastCall?.branch_id).toBe('br-1');
    });

    const chip = await screen.findByTestId('movements-chip-branch');
    expect(chip.textContent).toContain('فرع القاهرة');
  });

  it('Dashboard: branch dropdown re-fetches with branch_id and shows a chip', async () => {
    apiMocks.getDashboard.mockResolvedValue({
      totals: {
        total_products: 0,
        total_variants: 0,
        total_stock_qty: 0,
        total_available_qty: 0,
        total_stock_cost_value: 0,
        total_stock_sale_value: 0,
        low_stock_count: 0,
        out_of_stock_count: 0,
        warehouses_count: 0,
        movements_today_count: 0,
        low_stock_groups_count: 0,
      },
      top_low_stock: [],
      recent_movements: [],
      top_groups_by_stock_value: [],
      top_groups_by_sales_30d: [],
    });
    apiMocks.listBranches.mockResolvedValue([SAMPLE_BRANCH] as any);

    renderWithProviders(<InventoryDashboard />);
    await screen.findByTestId('inventory-dashboard');

    const select = (await screen.findByTestId(
      'dashboard-branch-filter',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'br-1' } });

    await waitFor(() => {
      const lastCall = apiMocks.getDashboard.mock.calls.at(-1)?.[0];
      expect(lastCall?.branch_id).toBe('br-1');
    });

    const chip = await screen.findByTestId('dashboard-chip-branch');
    expect(chip.textContent).toContain('فرع القاهرة');

    // Clear the chip → branch_id drops back to undefined.
    fireEvent.click(chip);
    await waitFor(() => {
      const lastCall = apiMocks.getDashboard.mock.calls.at(-1)?.[0];
      expect(lastCall?.branch_id).toBeUndefined();
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-BRANCHES-INVENTORY-FILTERS — read-only invariant covering
// InventoryDashboard.tsx as well (Balances + Movements are already
// covered by the parameterised describe.each below).
// ──────────────────────────────────────────────────────────────────
describe('InventoryDashboard — read-only invariant (source-level)', () => {
  const RAW_SRC = readFileSync(
    `${process.cwd()}/src/pages/InventoryDashboard.tsx`,
    'utf8',
  );
  const SRC = RAW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import useMutation or call api.post/.patch/.delete', () => {
    expect(SRC).not.toMatch(/useMutation/);
    expect(SRC).not.toMatch(/api\.post\(|api\.patch\(|api\.delete\(/);
    expect(SRC).not.toMatch(/inventoryApi\.(create|update|delete|adjust)/);
  });

  it('does NOT carry write-button labels', () => {
    const editish = /حفظ|تعديل سعر|تعديل تكلفة|تعديل الكمية|تطبيق|حذف/g;
    expect(SRC.match(editish) ?? []).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-FIX-INVENTORY-UX-BALANCES-MOVEMENTS — read-only invariant
// (matches the Product360 guard but covers Balances + Movements)
// ──────────────────────────────────────────────────────────────────
describe.each([
  { page: 'InventoryBalances' as const, file: 'InventoryBalances.tsx' },
  { page: 'InventoryMovements' as const, file: 'InventoryMovements.tsx' },
])('$page — read-only invariant (source-level)', ({ file }) => {
  const RAW_SRC = readFileSync(
    `${process.cwd()}/src/pages/${file}`,
    'utf8',
  );
  const SRC = RAW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import useMutation', () => {
    expect(SRC).not.toMatch(/useMutation/);
  });

  it('does NOT call api.post / api.patch / api.delete', () => {
    expect(SRC).not.toMatch(/api\.post\(|api\.patch\(|api\.delete\(/);
  });

  it('does NOT call any inventoryApi mutating helper', () => {
    expect(SRC).not.toMatch(
      /inventoryApi\.(create|update|delete|adjust|save|apply|remove)/,
    );
  });

  it('has no write-button labels (حفظ / تعديل / تطبيق / حذف)', () => {
    const editish = /حفظ|تعديل سعر|تعديل تكلفة|تعديل الكمية|تطبيق|حذف/g;
    expect(SRC.match(editish) ?? []).toEqual([]);
  });
});
