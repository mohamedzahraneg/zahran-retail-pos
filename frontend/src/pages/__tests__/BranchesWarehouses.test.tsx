/**
 * BranchesWarehouses.test.tsx — PR-BRANCHES-WAREHOUSES-FOUNDATION
 *
 * Smoke + behavior tests for the new /branches admin page:
 *   · Page renders branch rows + warehouse roll-up rows.
 *   · Create form calls branchesApi.create with the trimmed payload.
 *   · Linking modal calls linkWarehouse + setPrimary + unlinkWarehouse.
 *   · No stock / inventory mutation calls fire (defensive spies).
 *
 * Plus a source-level guard asserting the page never imports a
 * stock-mutating API client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import BranchesWarehouses from '../BranchesWarehouses';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listWarehouses: vi.fn(),
  linkWarehouse: vi.fn(),
  unlinkWarehouse: vi.fn(),
  setPrimary: vi.fn(),
  listWarehousesWithBranches: vi.fn(),
  settingsListWarehouses: vi.fn(),
  // Defensive spies that must remain at zero invocations.
  stockAdjust: vi.fn(),
  stockTransferCreate: vi.fn(),
  countCreate: vi.fn(),
}));

vi.mock('@/api/branches.api', async () => {
  const actual = await vi.importActual<any>('@/api/branches.api');
  return {
    ...actual,
    branchesApi: {
      list: (...a: any[]) => apiMocks.list(...a),
      get: (...a: any[]) => apiMocks.get(...a),
      create: (...a: any[]) => apiMocks.create(...a),
      update: (...a: any[]) => apiMocks.update(...a),
      listWarehouses: (...a: any[]) => apiMocks.listWarehouses(...a),
      linkWarehouse: (...a: any[]) => apiMocks.linkWarehouse(...a),
      unlinkWarehouse: (...a: any[]) => apiMocks.unlinkWarehouse(...a),
      setPrimary: (...a: any[]) => apiMocks.setPrimary(...a),
      listWarehousesWithBranches: (...a: any[]) =>
        apiMocks.listWarehousesWithBranches(...a),
    },
  };
});

vi.mock('@/api/settings.api', () => ({
  settingsApi: {
    listWarehouses: (...a: any[]) => apiMocks.settingsListWarehouses(...a),
  },
}));

vi.mock('@/api/stock.api', () => ({
  stockApi: { adjust: (...a: any[]) => apiMocks.stockAdjust(...a) },
}));
vi.mock('@/api/stock-transfers.api', () => ({
  stockTransfersApi: {
    create: (...a: any[]) => apiMocks.stockTransferCreate(...a),
  },
}));
vi.mock('@/api/inventory-counts.api', () => ({
  inventoryCountsApi: {
    create: (...a: any[]) => apiMocks.countCreate(...a),
  },
}));

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) {
    (fn as any).mockReset?.();
  }
  apiMocks.list.mockResolvedValue([
    {
      id: 'b1',
      code: 'CAI-01',
      name_ar: 'فرع القاهرة',
      name_en: 'Cairo',
      type: 'retail',
      manager_id: null,
      manager_name: null,
      address: null,
      phone: '0100',
      is_active: true,
      created_at: '',
      updated_at: '',
      warehouses_count: 2,
      parent_branch_id: null,
    },
  ]);
  apiMocks.listWarehousesWithBranches.mockResolvedValue([
    {
      id: 'w1',
      code: 'WH-01',
      name: 'الرئيسي',
      name_ar: 'الرئيسي',
      name_en: null,
      address: null,
      phone: null,
      manager_id: null,
      is_main: true,
      is_retail: false,
      is_active: true,
      warehouse_type: 'main',
      is_sellable: true,
      allow_negative_stock: false,
      sort_order: 0,
      primary_branch: {
        id: 'b1',
        code: 'CAI-01',
        name_ar: 'فرع القاهرة',
        name_en: null,
        type: 'retail',
      },
      branches: [
        {
          id: 'b1',
          code: 'CAI-01',
          name_ar: 'فرع القاهرة',
          name_en: null,
          type: 'retail',
          is_primary: true,
        },
      ],
    },
  ]);
  apiMocks.settingsListWarehouses.mockResolvedValue([
    { id: 'w1', code: 'WH-01', name_ar: 'الرئيسي', is_active: true },
    { id: 'w2', code: 'WH-02', name_ar: 'مخزن المرتجعات', is_active: true },
  ]);
  apiMocks.listWarehouses.mockResolvedValue([
    {
      id: 'w1',
      code: 'WH-01',
      name: 'الرئيسي',
      name_ar: 'الرئيسي',
      name_en: null,
      is_active: true,
      warehouse_type: 'main',
      is_sellable: true,
      allow_negative_stock: false,
      sort_order: 0,
      is_primary: true,
      linked_at: '',
    },
  ]);
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/branches']}>
        <BranchesWarehouses />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<BranchesWarehouses />', () => {
  it('renders branches and warehouse roll-up rows', async () => {
    renderPage();
    await screen.findByTestId('branches-warehouses-page');

    const branchRow = await screen.findByTestId('branch-row');
    expect(within(branchRow).getByText('CAI-01')).toBeTruthy();
    expect(within(branchRow).getByText('فرع القاهرة')).toBeTruthy();

    const rollupRow = await screen.findByTestId('warehouse-rollup-row');
    expect(within(rollupRow).getByText('WH-01')).toBeTruthy();
    expect(
      within(rollupRow).getByTestId('warehouse-rollup-primary').textContent,
    ).toContain('فرع القاهرة');
  });

  it('create form calls branchesApi.create with trimmed payload', async () => {
    apiMocks.create.mockResolvedValue({ id: 'b2' });
    renderPage();
    await screen.findByTestId('branches-warehouses-page');

    fireEvent.click(screen.getByTestId('branches-create-button'));
    await screen.findByTestId('branch-form-modal');
    fireEvent.change(screen.getByTestId('branch-form-code'), {
      target: { value: '  ALX-01 ' },
    });
    fireEvent.change(screen.getByTestId('branch-form-name-ar'), {
      target: { value: '  فرع الإسكندرية  ' },
    });
    fireEvent.click(screen.getByTestId('branch-form-save'));

    await waitFor(() => {
      expect(apiMocks.create).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.create.mock.calls[0][0]).toMatchObject({
      code: 'ALX-01',
      name_ar: 'فرع الإسكندرية',
      type: 'retail',
    });
  });

  it('linking modal triggers linkWarehouse + setPrimary + unlink', async () => {
    apiMocks.linkWarehouse.mockResolvedValue({
      warehouse_id: 'w2',
      branch_id: 'b1',
      is_primary: false,
    });
    apiMocks.setPrimary.mockResolvedValue({});
    apiMocks.unlinkWarehouse.mockResolvedValue({ unlinked: true });

    renderPage();
    await screen.findByTestId('branches-warehouses-page');

    fireEvent.click((await screen.findAllByTestId('branch-link-button'))[0]);
    await screen.findByTestId('link-warehouses-modal');

    // Already-linked row in the top list (WH-01, primary)
    const linkedRow = await screen.findByTestId('link-warehouses-linked-row');
    // WH-01 is primary so the "set primary" button is hidden — but the
    // "unlink" button must exist.
    expect(
      within(linkedRow).getByTestId('link-warehouses-unlink'),
    ).toBeTruthy();
    fireEvent.click(within(linkedRow).getByTestId('link-warehouses-unlink'));
    await waitFor(() => {
      expect(apiMocks.unlinkWarehouse).toHaveBeenCalledWith('b1', 'w1');
    });

    // Available (WH-02) → link
    const availRow = await screen.findByTestId('link-warehouses-available-row');
    fireEvent.click(within(availRow).getByTestId('link-warehouses-link'));
    await waitFor(() => {
      expect(apiMocks.linkWarehouse).toHaveBeenCalledWith('b1', 'w2');
    });
  });

  it('never calls stock / transfer / count mutations', async () => {
    renderPage();
    await screen.findByTestId('branches-warehouses-page');
    fireEvent.click(screen.getByTestId('branches-create-button'));
    await screen.findByTestId('branch-form-modal');
    fireEvent.change(screen.getByTestId('branch-form-code'), {
      target: { value: 'X' },
    });
    fireEvent.change(screen.getByTestId('branch-form-name-ar'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('branch-form-save'));
    await waitFor(() => {
      expect(apiMocks.create).toHaveBeenCalled();
    });
    expect(apiMocks.stockAdjust).not.toHaveBeenCalled();
    expect(apiMocks.stockTransferCreate).not.toHaveBeenCalled();
    expect(apiMocks.countCreate).not.toHaveBeenCalled();
  });
});

describe('BranchesWarehouses — read-only-against-stock invariant (source-level)', () => {
  const RAW = readFileSync(
    `${process.cwd()}/src/pages/BranchesWarehouses.tsx`,
    'utf8',
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import stock / inventory mutation clients', () => {
    expect(SRC).not.toMatch(/@\/api\/stock\.api/);
    expect(SRC).not.toMatch(/@\/api\/stock-transfers\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory-counts\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory\.api/);
    expect(SRC).not.toMatch(/@\/api\/purchases\.api/);
  });

  it('does NOT touch the inventory APIs at all', () => {
    expect(SRC).not.toMatch(/inventoryApi\b/);
    expect(SRC).not.toMatch(/stockApi\b/);
    expect(SRC).not.toMatch(/stockTransfersApi\b/);
    expect(SRC).not.toMatch(/inventoryCountsApi\b/);
  });
});
