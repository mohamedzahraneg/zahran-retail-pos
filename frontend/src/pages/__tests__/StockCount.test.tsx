/**
 * StockCount.test.tsx — PR-INVENTORY-COUNTS-WORKFLOW
 *
 * Branch-aware stocktaking page tests:
 *   · Page renders 6 summary cards + filters section.
 *   · Branch dropdown forwards branch_id.
 *   · Create modal sends only warehouse_id (and optional notes).
 *   · Detail drawer surfaces system_qty / counted_qty / difference
 *     and writes counts via updateItems (NOT a stock client).
 *   · Finalize prompts confirmation and calls inventoryCountsApi.finalize.
 *   · Action visibility per status (e.g. cancel hidden on finalized).
 *   · Source-level guard: page does NOT import any stock-mutating client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  // The page uses `toast(...)` and `toast.success(...)`.
  (fn as any).success = vi.fn();
  (fn as any).error = vi.fn();
  return { default: fn };
});

vi.mock('@/lib/final-ops-idempotency', () => ({
  resetInventoryFinalizeIdempotencyKey: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  freeze: vi.fn(),
  updateItems: vi.fn(),
  review: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
  listWarehouses: vi.fn(),
  listBranches: vi.fn(),
}));

vi.mock('@/api/inventory-counts.api', async () => {
  const actual = await vi.importActual<any>('@/api/inventory-counts.api');
  return {
    ...actual,
    inventoryCountsApi: {
      list: (...a: any[]) => mocks.list(...a),
      get: (...a: any[]) => mocks.get(...a),
      create: (...a: any[]) => mocks.create(...a),
      freeze: (...a: any[]) => mocks.freeze(...a),
      updateItems: (...a: any[]) => mocks.updateItems(...a),
      review: (...a: any[]) => mocks.review(...a),
      finalize: (...a: any[]) => mocks.finalize(...a),
      cancel: (...a: any[]) => mocks.cancel(...a),
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

import StockCount from '../StockCount';

const realConfirm = window.confirm;
beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as any).mockReset?.();
  window.confirm = vi.fn().mockReturnValue(true);
  mocks.list.mockResolvedValue([
    {
      id: 'cnt-open',
      count_no: 'CNT-2026-00001',
      warehouse_id: 'wh-a',
      warehouse_name: 'الرئيسي',
      primary_branch: {
        id: 'br-1',
        code: 'CAI-01',
        name_ar: 'فرع القاهرة',
        name_en: 'Cairo',
        type: 'retail',
      },
      status: 'open',
      started_at: '2026-05-19T10:00:00Z',
      completed_at: null,
      finalized_at: null,
      notes: null,
      items_total: 12,
      items_counted: 0,
      items_with_diff: 0,
      positive_diff_qty: 0,
      negative_diff_qty: 0,
    },
    {
      id: 'cnt-counting',
      count_no: 'CNT-2026-00002',
      warehouse_id: 'wh-a',
      warehouse_name: 'الرئيسي',
      primary_branch: null,
      status: 'counting',
      started_at: '2026-05-19T08:00:00Z',
      completed_at: null,
      finalized_at: null,
      notes: null,
      items_total: 8,
      items_counted: 5,
      items_with_diff: 2,
      positive_diff_qty: 3,
      negative_diff_qty: 1,
    },
    {
      id: 'cnt-finalized',
      count_no: 'CNT-2026-00003',
      warehouse_id: 'wh-a',
      warehouse_name: 'الرئيسي',
      primary_branch: null,
      status: 'finalized',
      started_at: '2026-05-18T08:00:00Z',
      completed_at: '2026-05-18T18:00:00Z',
      finalized_at: '2026-05-18T18:00:00Z',
      notes: null,
      items_total: 5,
      items_counted: 5,
      items_with_diff: 0,
      positive_diff_qty: 0,
      negative_diff_qty: 0,
    },
  ] as any);
  mocks.listWarehouses.mockResolvedValue([
    { id: 'wh-a', code: 'WH-A', name_ar: 'الرئيسي', is_active: true },
    { id: 'wh-b', code: 'WH-B', name_ar: 'الفرع 2', is_active: true },
  ] as any);
  mocks.listBranches.mockResolvedValue([
    { id: 'br-1', code: 'CAI-01', name_ar: 'فرع القاهرة' },
    { id: 'br-2', code: 'ALX-01', name_ar: 'فرع الإسكندرية' },
  ] as any);
});
afterEach(() => {
  window.confirm = realConfirm;
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/stock-count']}>
        <StockCount />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<StockCount /> — page-level UX', () => {
  it('renders 6 summary cards + filters section', async () => {
    renderPage();
    await screen.findByTestId('stock-count-page');
    expect(
      within(await screen.findByTestId('counts-summary')).getAllByTestId(
        'counts-summary-card',
      ),
    ).toHaveLength(6);
    expect(await screen.findByTestId('counts-filters')).toBeTruthy();
  });

  it('forwards branch_id when the branch dropdown changes', async () => {
    renderPage();
    await screen.findByTestId('stock-count-page');

    const select = (await screen.findByTestId(
      'counts-branch-filter',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'br-2' } });

    await waitFor(() => {
      const lastArgs = mocks.list.mock.calls.at(-1)?.[0];
      expect(lastArgs?.branch_id).toBe('br-2');
    });
    expect(await screen.findByTestId('counts-chip-branch')).toBeTruthy();
  });

  it('create modal calls inventoryCountsApi.create with warehouse_id only (no stock mutation)', async () => {
    mocks.create.mockResolvedValue({ id: 'cnt-new', count_no: 'CNT-2026-00099' });
    mocks.freeze.mockResolvedValue({ id: 'cnt-new', count_no: 'CNT-2026-00099', status: 'open' });
    mocks.get.mockResolvedValue({
      id: 'cnt-new',
      count_no: 'CNT-2026-00099',
      status: 'open',
      warehouse_id: 'wh-a',
      warehouse_name: 'الرئيسي',
      started_at: '2026-05-19T10:00:00Z',
      completed_at: null,
      notes: null,
      items: [],
      movements: [],
    });

    renderPage();
    await screen.findByTestId('stock-count-page');
    fireEvent.click(screen.getByTestId('counts-create-button'));

    await screen.findByTestId('counts-create-modal');
    fireEvent.change(screen.getByTestId('counts-create-warehouse'), {
      target: { value: 'wh-a' },
    });
    fireEvent.click(screen.getByTestId('counts-create-submit'));

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledTimes(1);
    });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      warehouse_id: 'wh-a',
    });
    // Auto-freeze defaults to ON.
    await waitFor(() => expect(mocks.freeze).toHaveBeenCalledWith('cnt-new', {}));
  });
});

describe('<StockCount /> — detail drawer', () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({
      id: 'cnt-counting',
      count_no: 'CNT-2026-00002',
      warehouse_id: 'wh-a',
      warehouse_name: 'الرئيسي',
      primary_branch: null,
      status: 'counting',
      started_at: '2026-05-19T08:00:00Z',
      completed_at: null,
      finalized_at: null,
      notes: null,
      items: [
        {
          id: 'item-1',
          count_id: 'cnt-counting',
          variant_id: 'v-1',
          system_qty: 10,
          counted_qty: null,
          difference: 0,
          notes: null,
          product_name: 'حقيبة A',
          product_sku: 'BAG',
          variant_sku: 'BAG-RED-M',
          color: 'أحمر',
          size: 'M',
        },
        {
          id: 'item-2',
          count_id: 'cnt-counting',
          variant_id: 'v-2',
          system_qty: 5,
          counted_qty: 4,
          difference: -1,
          notes: null,
          product_name: 'حقيبة B',
          product_sku: 'BAG',
          variant_sku: 'BAG-BLUE-L',
          color: 'أزرق',
          size: 'L',
        },
      ],
      movements: [],
    });
  });

  it('shows system_qty / counted_qty / difference for each item', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('count-row');
    fireEvent.click(rows[1]); // counting row

    const drawer = await screen.findByTestId('count-detail-modal');
    const items = await within(drawer).findAllByTestId(
      'count-detail-item-row',
    );
    expect(items).toHaveLength(2);
    // First row: system_qty 10, counted_qty empty.
    expect(items[0].textContent).toContain('10');
    // Second row: -1 difference.
    expect(items[1].textContent).toContain('-1');
  });

  it('save counts calls updateItems with only the edited rows', async () => {
    mocks.updateItems.mockResolvedValue({});
    renderPage();
    const rows = await screen.findAllByTestId('count-row');
    fireEvent.click(rows[1]);

    const inputs = await screen.findAllByTestId('count-detail-input');
    fireEvent.change(inputs[0], { target: { value: '12' } });

    fireEvent.click(screen.getByTestId('count-action-save'));
    await waitFor(() => {
      expect(mocks.updateItems).toHaveBeenCalledTimes(1);
    });
    expect(mocks.updateItems.mock.calls[0]).toEqual([
      'cnt-counting',
      { items: [{ item_id: 'item-1', counted_qty: 12 }] },
    ]);
  });

  it('finalize confirms then calls inventoryCountsApi.finalize', async () => {
    // For finalize we need the status to allow it. Re-mock the
    // detail row as `review` so the finalize button shows up
    // regardless of the action-visibility rules.
    mocks.get.mockResolvedValue({
      id: 'cnt-review',
      count_no: 'CNT-2026-00088',
      warehouse_id: 'wh-a',
      warehouse_name: 'الرئيسي',
      primary_branch: null,
      status: 'review',
      started_at: '2026-05-19T08:00:00Z',
      completed_at: null,
      finalized_at: null,
      notes: null,
      items: [
        {
          id: 'item-1',
          count_id: 'cnt-review',
          variant_id: 'v-1',
          system_qty: 10,
          counted_qty: 11,
          difference: 1,
          notes: null,
          product_name: 'حقيبة A',
          product_sku: 'BAG',
          variant_sku: 'BAG-RED-M',
          color: 'أحمر',
          size: 'M',
        },
      ],
      movements: [],
    });
    mocks.finalize.mockResolvedValue({});

    renderPage();
    const rows = await screen.findAllByTestId('count-row');
    fireEvent.click(rows[0]);
    await screen.findByTestId('count-detail-modal');

    const finalizeBtn = await screen.findByTestId('count-action-finalize');
    fireEvent.click(finalizeBtn);
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.finalize).toHaveBeenCalledTimes(1);
    });
    // The drawer was opened from the FIRST row in the list (id =
    // 'cnt-open'); the API returned a `review`-status detail so the
    // finalize button surfaced. The mutation still targets the
    // clicked row's id.
    expect(mocks.finalize.mock.calls[0][0]).toBe('cnt-open');
  });

  it('finalized status hides the cancel button entirely', async () => {
    mocks.get.mockResolvedValue({
      id: 'cnt-finalized',
      count_no: 'CNT-2026-00003',
      warehouse_id: 'wh-a',
      warehouse_name: 'الرئيسي',
      primary_branch: null,
      status: 'finalized',
      started_at: '2026-05-18T08:00:00Z',
      completed_at: '2026-05-18T18:00:00Z',
      finalized_at: '2026-05-18T18:00:00Z',
      notes: null,
      items: [],
      movements: [],
    });
    renderPage();
    const rows = await screen.findAllByTestId('count-row');
    fireEvent.click(rows[2]);
    await screen.findByTestId('count-detail-modal');
    expect(screen.queryByTestId('count-action-cancel')).toBeNull();
    expect(screen.queryByTestId('count-action-finalize')).toBeNull();
    expect(screen.queryByTestId('count-action-save')).toBeNull();
  });
});

describe('<StockCount /> — read-only invariant (source-level)', () => {
  const RAW = readFileSync(
    `${process.cwd()}/src/pages/StockCount.tsx`,
    'utf8',
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import direct stock / inventory clients (only the counts client)', () => {
    expect(SRC).not.toMatch(/@\/api\/stock\.api/);
    expect(SRC).not.toMatch(/@\/api\/stock-transfers\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory\.api/);
    expect(SRC).not.toMatch(/stockApi\b/);
    expect(SRC).not.toMatch(/inventoryApi\b/);
    expect(SRC).not.toMatch(/stockTransfersApi\b/);
  });

  it('no manual quantity_on_hand / balance_after_qty assignment in the page source', () => {
    expect(SRC).not.toMatch(/\bquantity_on_hand\s*=(?!=)/);
    expect(SRC).not.toMatch(/\bbalance_after_qty\s*=(?!=)/);
  });
});
