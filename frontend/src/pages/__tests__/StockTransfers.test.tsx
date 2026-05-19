/**
 * StockTransfers.test.tsx — PR-STOCK-TRANSFERS-WORKFLOW
 *
 * Smoke + behavior tests for the new transfer workflow page:
 *   · Renders summary cards + filters.
 *   · Branch dropdown selections forward from_branch_id / to_branch_id.
 *   · Per-status action sets show only the legitimate verbs.
 *   · Ship/cancel prompt for confirmation (window.confirm).
 *   · Receive modal posts cumulative quantities (delta handled BE side).
 *   · Ship button is disabled while the mutation is pending
 *     (double-click defence — primary idempotency is server-side).
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

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/stock-purchases-idempotency', () => ({
  resetStockTransferCreateIdempotencyKey: vi.fn(),
  resetStockTransferShipIdempotencyKey: vi.fn(),
  resetStockTransferReceiveIdempotencyKey: vi.fn(),
  resetStockTransferCancelIdempotencyKey: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  ship: vi.fn(),
  receive: vi.fn(),
  cancel: vi.fn(),
  listWarehouses: vi.fn(),
  listBranches: vi.fn(),
}));

vi.mock('@/api/stock-transfers.api', async () => {
  const actual = await vi.importActual<any>('@/api/stock-transfers.api');
  return {
    ...actual,
    stockTransfersApi: {
      list: (...a: any[]) => mocks.list(...a),
      get: (...a: any[]) => mocks.get(...a),
      create: (...a: any[]) => mocks.create(...a),
      approve: (...a: any[]) => mocks.approve(...a),
      ship: (...a: any[]) => mocks.ship(...a),
      receive: (...a: any[]) => mocks.receive(...a),
      cancel: (...a: any[]) => mocks.cancel(...a),
    },
  };
});

vi.mock('@/api/settings.api', () => ({
  settingsApi: { listWarehouses: (...a: any[]) => mocks.listWarehouses(...a) },
}));

vi.mock('@/api/branches.api', async () => {
  const actual = await vi.importActual<any>('@/api/branches.api');
  return {
    ...actual,
    branchesApi: { list: (...a: any[]) => mocks.listBranches(...a) },
  };
});

// `@/api/client` is only used by the create-modal variant search.
// Stub the get to no-op so it never hits the network.
vi.mock('@/api/client', () => ({
  api: { get: vi.fn(async () => ({ data: { data: { data: [] } } })) },
  unwrap: vi.fn(async () => ({ data: [] })),
}));

import StockTransfers from '../StockTransfers';

const realConfirm = window.confirm;
beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as any).mockReset?.();
  mocks.list.mockResolvedValue([
    {
      id: 't-draft',
      transfer_no: 'TRF-2026-00001',
      from_warehouse_id: 'wh-a',
      to_warehouse_id: 'wh-b',
      from_warehouse_name: 'الرئيسي',
      to_warehouse_name: 'الفرع 2',
      from_primary_branch: {
        id: 'br-1',
        code: 'CAI-01',
        name_ar: 'فرع القاهرة',
        name_en: 'Cairo',
        type: 'retail',
      },
      to_primary_branch: {
        id: 'br-2',
        code: 'ALX-01',
        name_ar: 'فرع الإسكندرية',
        name_en: 'Alex',
        type: 'retail',
      },
      status: 'draft',
      notes: null,
      requested_at: '2026-05-19T10:00:00Z',
      shipped_at: null,
      received_at: null,
      created_at: '2026-05-19T10:00:00Z',
      updated_at: '2026-05-19T10:00:00Z',
      items_count: 2,
      total_qty_requested: 7,
      total_qty_received: 0,
    },
    {
      id: 't-in-transit',
      transfer_no: 'TRF-2026-00002',
      from_warehouse_id: 'wh-a',
      to_warehouse_id: 'wh-b',
      from_warehouse_name: 'الرئيسي',
      to_warehouse_name: 'الفرع 2',
      status: 'in_transit',
      notes: null,
      requested_at: '2026-05-19T10:00:00Z',
      shipped_at: '2026-05-19T11:00:00Z',
      received_at: null,
      created_at: '2026-05-19T10:00:00Z',
      updated_at: '2026-05-19T11:00:00Z',
      items_count: 1,
      total_qty_requested: 5,
      total_qty_received: 0,
    },
    {
      id: 't-partial',
      transfer_no: 'TRF-2026-00003',
      from_warehouse_id: 'wh-a',
      to_warehouse_id: 'wh-b',
      from_warehouse_name: 'الرئيسي',
      to_warehouse_name: 'الفرع 2',
      status: 'partially_received',
      notes: null,
      requested_at: '2026-05-18T10:00:00Z',
      shipped_at: '2026-05-18T11:00:00Z',
      received_at: null,
      created_at: '2026-05-18T10:00:00Z',
      updated_at: '2026-05-18T12:00:00Z',
      items_count: 1,
      total_qty_requested: 10,
      total_qty_received: 6,
    },
    {
      id: 't-received',
      transfer_no: 'TRF-2026-00004',
      from_warehouse_id: 'wh-a',
      to_warehouse_id: 'wh-b',
      from_warehouse_name: 'الرئيسي',
      to_warehouse_name: 'الفرع 2',
      status: 'received',
      notes: null,
      requested_at: '2026-05-17T10:00:00Z',
      shipped_at: '2026-05-17T11:00:00Z',
      received_at: '2026-05-17T13:00:00Z',
      created_at: '2026-05-17T10:00:00Z',
      updated_at: '2026-05-17T13:00:00Z',
      items_count: 1,
      total_qty_requested: 3,
      total_qty_received: 3,
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
  window.confirm = vi.fn().mockReturnValue(true);
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
      <MemoryRouter initialEntries={['/stock-transfers']}>
        <StockTransfers />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<StockTransfers /> — summary + filters + actions', () => {
  it('renders 6 summary cards and a filters section', async () => {
    renderPage();
    await screen.findByTestId('stock-transfers-page');

    const summary = await screen.findByTestId('transfers-summary');
    expect(within(summary).getAllByTestId('transfers-summary-card')).toHaveLength(6);
    expect(await screen.findByTestId('transfers-filters')).toBeTruthy();
  });

  it('forwards from_branch_id when the from-branch dropdown changes', async () => {
    renderPage();
    await screen.findByTestId('stock-transfers-page');

    const select = (await screen.findByTestId(
      'transfers-from-branch-filter',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'br-1' } });

    await waitFor(() => {
      const lastArgs = mocks.list.mock.calls.at(-1)?.[0];
      expect(lastArgs?.from_branch_id).toBe('br-1');
    });
    expect(await screen.findByTestId('transfers-chip-from-branch')).toBeTruthy();
  });

  it('forwards to_branch_id when the to-branch dropdown changes', async () => {
    renderPage();
    await screen.findByTestId('stock-transfers-page');

    const select = (await screen.findByTestId(
      'transfers-to-branch-filter',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'br-2' } });

    await waitFor(() => {
      const lastArgs = mocks.list.mock.calls.at(-1)?.[0];
      expect(lastArgs?.to_branch_id).toBe('br-2');
    });
  });

  it('shows the right action set per status', async () => {
    renderPage();
    await screen.findByTestId('stock-transfers-page');

    const rows = await screen.findAllByTestId('transfer-row');
    expect(rows).toHaveLength(4);

    // Draft → approve + ship + cancel (no receive)
    const draftActions = within(rows[0]).getByTestId('transfer-row-actions');
    expect(within(draftActions).getByTestId('transfer-action-approve')).toBeTruthy();
    expect(within(draftActions).getByTestId('transfer-action-ship')).toBeTruthy();
    expect(within(draftActions).getByTestId('transfer-action-cancel')).toBeTruthy();
    expect(
      within(draftActions).queryByTestId('transfer-action-receive'),
    ).toBeNull();

    // In-transit → receive only
    const inTransitActions = within(rows[1]).getByTestId('transfer-row-actions');
    expect(within(inTransitActions).getByTestId('transfer-action-receive')).toBeTruthy();
    expect(
      within(inTransitActions).queryByTestId('transfer-action-ship'),
    ).toBeNull();
    expect(
      within(inTransitActions).queryByTestId('transfer-action-cancel'),
    ).toBeNull();

    // Partially-received → receive only
    const partialActions = within(rows[2]).getByTestId('transfer-row-actions');
    expect(within(partialActions).getByTestId('transfer-action-receive')).toBeTruthy();
    expect(
      within(partialActions).queryByTestId('transfer-action-cancel'),
    ).toBeNull();

    // Received → no actions
    const receivedActions = within(rows[3]).getByTestId('transfer-row-actions');
    expect(receivedActions.children).toHaveLength(0);
  });

  it('ship action confirms before calling the API + disables itself while pending', async () => {
    // Make ship hang so isPending stays true.
    let resolveShip: any;
    mocks.ship.mockReturnValue(
      new Promise((res) => {
        resolveShip = res;
      }),
    );
    renderPage();
    const rows = await screen.findAllByTestId('transfer-row');
    const draftActions = within(rows[0]).getByTestId('transfer-row-actions');
    const shipBtn = within(draftActions).getByTestId(
      'transfer-action-ship',
    ) as HTMLButtonElement;

    fireEvent.click(shipBtn);
    expect(window.confirm).toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.ship).toHaveBeenCalledWith('t-draft');
    });

    // While pending all ship buttons across the page are disabled
    // (the mutation is shared between rows). This is the FE double-
    // click defence; idempotency proper lives server-side.
    const allShipBtns = screen.getAllByTestId(
      'transfer-action-ship',
    ) as HTMLButtonElement[];
    for (const b of allShipBtns) {
      expect(b.disabled).toBe(true);
    }
    resolveShip({});
  });

  it('cancel action prompts for confirmation', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('transfer-row');
    const cancelBtn = within(
      within(rows[0]).getByTestId('transfer-row-actions'),
    ).getByTestId('transfer-action-cancel');
    fireEvent.click(cancelBtn);
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('t-draft'));
  });
});

describe('<StockTransfers /> — receive modal posts cumulative quantities', () => {
  it('opens the detail modal and submits the receive payload', async () => {
    mocks.get.mockResolvedValue({
      id: 't-in-transit',
      transfer_no: 'TRF-2026-00002',
      from_warehouse_id: 'wh-a',
      to_warehouse_id: 'wh-b',
      from_warehouse_name: 'الرئيسي',
      to_warehouse_name: 'الفرع 2',
      from_primary_branch: null,
      to_primary_branch: null,
      status: 'in_transit',
      notes: null,
      requested_at: '2026-05-19T10:00:00Z',
      shipped_at: '2026-05-19T11:00:00Z',
      received_at: null,
      created_at: '2026-05-19T10:00:00Z',
      updated_at: '2026-05-19T11:00:00Z',
      items: [
        {
          id: 'item-1',
          transfer_id: 't-in-transit',
          variant_id: 'v-1',
          quantity_requested: 5,
          quantity_received: 0,
          notes: null,
          product_name: 'حقيبة A',
          variant_sku: 'BAG-RED-M',
        },
      ],
      movements: [],
    } as any);
    mocks.receive.mockResolvedValue({});

    renderPage();
    const rows = await screen.findAllByTestId('transfer-row');
    fireEvent.click(
      within(within(rows[1]).getByTestId('transfer-row-actions')).getByTestId(
        'transfer-action-receive',
      ),
    );

    await screen.findByTestId('transfer-detail-modal');
    const submit = await screen.findByTestId('detail-receive-submit');
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mocks.receive).toHaveBeenCalledTimes(1);
    });
    const [id, payload] = mocks.receive.mock.calls[0];
    expect(id).toBe('t-in-transit');
    expect(payload).toMatchObject({
      items: [{ item_id: 'item-1', quantity_received: 5 }],
    });
  });
});

describe('<StockTransfers /> — read-only invariant (source-level)', () => {
  const RAW = readFileSync(
    `${process.cwd()}/src/pages/StockTransfers.tsx`,
    'utf8',
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import direct stock / movement clients', () => {
    expect(SRC).not.toMatch(/@\/api\/stock\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory-counts\.api/);
    expect(SRC).not.toMatch(/stockApi\b/);
    expect(SRC).not.toMatch(/inventoryApi\b/);
  });

  it('does NOT mention manual quantity_on_hand mutations', () => {
    // Page renders quantities but never assigns them in any local
    // helper that could leak as a write surface. The `=(?!=)` look-
    // ahead excludes comparison operators (`==`, `===`).
    expect(SRC).not.toMatch(/quantity_on_hand\s*=(?!=)/);
    expect(SRC).not.toMatch(/balance_after_qty\s*=(?!=)/);
  });
});
