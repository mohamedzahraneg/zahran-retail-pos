/**
 * inventory.api.spec.ts — PR-FIX-INVENTORY-UI-SHELL
 *
 * Pins the URL + params shape of the new inventory API client.
 * Mocks the underlying axios instance so we can assert exactly what
 * the FE sends without booting the BE.
 *
 * Coverage:
 *   1. getDashboard hits GET /inventory/dashboard with no params
 *   2. getBalances forwards filter params and sends `group_id`
 *      when a group filter is requested
 *   3. cleanParams strips undefined + empty strings, KEEPS false/0
 *   4. getProduct360 / getProductMatrix build the right URLs
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the axios mock so it's available when inventory.api imports
// `./client`. Each method records `(url, config)` for assertions.
const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_url: string, _config?: any) => ({ data: { data: {} } })),
}));

vi.mock('./client', () => ({
  api: { get: mocks.get },
  // unwrap is what the client layer uses; the BE returns
  // `{ success: true, data: ... }` and unwrap pulls `data` out.
  // Tests don't care about the wrapper — return whatever was set.
  unwrap: async (p: any) => {
    const res = await p;
    return res?.data?.data ?? res?.data ?? res;
  },
}));

import {
  inventoryApi,
  cleanParams,
  type InventoryBalancesFilters,
  type InventoryMovementsFilters,
} from './inventory.api';

beforeEach(() => {
  mocks.get.mockClear();
  mocks.get.mockImplementation(async () => ({ data: { data: {} } }));
});

describe('cleanParams', () => {
  it('strips undefined values', () => {
    expect(cleanParams({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });
  it('strips empty/whitespace strings', () => {
    expect(cleanParams({ a: '', b: '   ', c: 'x' })).toEqual({ c: 'x' });
  });
  it('KEEPS false / 0 / nulls (meaningful filter values)', () => {
    expect(cleanParams({ a: false, b: 0, c: null })).toEqual({
      a: false,
      b: 0,
      c: null,
    });
  });
});

describe('inventoryApi.getDashboard', () => {
  it('GETs /inventory/dashboard with no params (empty params object)', async () => {
    await inventoryApi.getDashboard();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const [url, config] = mocks.get.mock.calls[0];
    expect(url).toBe('/inventory/dashboard');
    expect(config?.params).toEqual({});
  });

  it('forwards branch_id when supplied (PR-BRANCHES-INVENTORY-FILTERS)', async () => {
    await inventoryApi.getDashboard({ branch_id: 'br-1' });
    const [url, config] = mocks.get.mock.calls[0];
    expect(url).toBe('/inventory/dashboard');
    expect(config?.params).toMatchObject({ branch_id: 'br-1' });
  });
});

describe('inventoryApi.getBalances', () => {
  it('GETs /inventory/balances with pagination + group_id passthrough', async () => {
    const filters: InventoryBalancesFilters = {
      page: 2,
      limit: 50,
      search: 'red',
      warehouse_id: 'w-1',
      group_id: 'g-1',
      low_stock: true,
    };
    await inventoryApi.getBalances(filters);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const [url, config] = mocks.get.mock.calls[0];
    expect(url).toBe('/inventory/balances');
    expect(config.params).toMatchObject({
      page: 2,
      limit: 50,
      search: 'red',
      warehouse_id: 'w-1',
      group_id: 'g-1',
      low_stock: true,
    });
    // Filters NOT passed must not appear in params at all (so the
    // server sees a clean query string).
    expect(config.params).not.toHaveProperty('category_id');
    expect(config.params).not.toHaveProperty('color_id');
    expect(config.params).not.toHaveProperty('out_of_stock');
  });

  it('omits filter when no group_id is supplied (does not send `group_id=`)', async () => {
    await inventoryApi.getBalances({ warehouse_id: 'w-2' });
    const [, config] = mocks.get.mock.calls[0];
    expect(config.params).not.toHaveProperty('group_id');
  });

  it('accepts the empty filter shape', async () => {
    await inventoryApi.getBalances();
    expect(mocks.get).toHaveBeenCalledWith('/inventory/balances', {
      params: {},
    });
  });
});

describe('inventoryApi.getMovements', () => {
  it('GETs /inventory/movements forwarding date range + group_id', async () => {
    const filters: InventoryMovementsFilters = {
      page: 1,
      limit: 100,
      group_id: 'g-7',
      direction: 'out',
      movement_type: 'sale',
      date_from: '2026-05-01',
      date_to: '2026-05-19',
    };
    await inventoryApi.getMovements(filters);
    expect(mocks.get).toHaveBeenCalledWith('/inventory/movements', {
      params: filters,
    });
  });
});

describe('inventoryApi.getProduct360', () => {
  it('GETs /products/:id/360', async () => {
    await inventoryApi.getProduct360('abc-123');
    expect(mocks.get).toHaveBeenCalledWith('/products/abc-123/360');
  });
});

describe('inventoryApi.getProductMatrix', () => {
  it('GETs /products/:id/matrix', async () => {
    await inventoryApi.getProductMatrix('abc-123');
    expect(mocks.get).toHaveBeenCalledWith('/products/abc-123/matrix');
  });
});
