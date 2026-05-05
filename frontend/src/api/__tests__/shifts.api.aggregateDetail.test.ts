/**
 * shifts.api.aggregateDetail.test.ts
 * PR-SHIFT-REPORTS-AGGREGATED-DETAIL-FE
 *
 * Pins the API wrapper contract:
 *   1. When `shift_ids` is provided AND non-empty, the wrapper sends
 *      `{ shift_ids }` only — `filters` is dropped.
 *   2. When `shift_ids` is absent or empty, the wrapper sends
 *      `{ filters }` (defaulting to `{}` when filters omitted).
 *   3. When BOTH are provided AND `shift_ids` is non-empty, selection
 *      wins — `filters` is dropped on the wire (matches the BE
 *      contract; making it client-explicit avoids surprising BE
 *      behavior if the contract ever diverges).
 *   4. The wrapper NEVER sends `generated_by` / `generated_at` —
 *      both are server-supplied.
 *
 * We mock `api.post` from `../client` and intercept the body argument.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client', () => {
  return {
    api: {
      post: vi.fn(),
    },
    unwrap: vi.fn(<T>(p: Promise<{ data: T }>) => p.then((r) => r.data)),
  };
});

import { api } from '../client';
import { shiftsApi } from '../shifts.api';

const post = api.post as unknown as ReturnType<typeof vi.fn>;

const stubResponse = () =>
  Promise.resolve({
    data: {
      header: {
        date_range: { from: null, to: null },
        shift_count: 0,
        shifts: [],
        cashiers: [],
        cashboxes: [],
        selection_mode: 'explicit',
        generated_by: { user_id: 'u', full_name: null },
        generated_at: '2026-05-05T12:00:00.000Z',
      },
      totals: {},
      sections: {
        operating_expenses: [],
        employee_cash_movements: [],
        cashbox_movements: [],
        payment_breakdown: [],
        refund_cash_movements: [],
        closing_adjustments: [],
      },
    },
  });

describe('shiftsApi.aggregateDetail wrapper', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockImplementation(() => stubResponse());
  });

  it('sends { shift_ids } when selection exists (filters dropped)', async () => {
    await shiftsApi.aggregateDetail({
      shift_ids: ['a', 'b', 'c'],
      filters: { from: '2026-05-04', to: '2026-05-04' },
    });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/shifts/reports/aggregate-detail');
    expect(body).toEqual({ shift_ids: ['a', 'b', 'c'] });
    expect(body).not.toHaveProperty('filters');
  });

  it('sends { filters } when no selection exists', async () => {
    await shiftsApi.aggregateDetail({
      filters: {
        from: '2026-05-04',
        to: '2026-05-04',
        status: 'closed',
        cashbox_id: 'cb-1',
      },
    });
    expect(post).toHaveBeenCalledTimes(1);
    const [, body] = post.mock.calls[0];
    expect(body).toEqual({
      filters: {
        from: '2026-05-04',
        to: '2026-05-04',
        status: 'closed',
        cashbox_id: 'cb-1',
      },
    });
    expect(body).not.toHaveProperty('shift_ids');
  });

  it('sends { filters: {} } when neither shift_ids nor filters are provided', async () => {
    await shiftsApi.aggregateDetail({});
    const [, body] = post.mock.calls[0];
    expect(body).toEqual({ filters: {} });
  });

  it('sends { filters } when shift_ids is an empty array (selection does NOT win on empty)', async () => {
    await shiftsApi.aggregateDetail({
      shift_ids: [],
      filters: { from: '2026-05-04' },
    });
    const [, body] = post.mock.calls[0];
    expect(body).toEqual({ filters: { from: '2026-05-04' } });
    expect(body).not.toHaveProperty('shift_ids');
  });

  it('never sends generated_by/generated_at from the client', async () => {
    await shiftsApi.aggregateDetail({
      shift_ids: ['a'],
      // Typing forbids these fields. Cast to any to simulate a buggy
      // caller; the wrapper must drop them.
      generated_by: { user_id: 'fake', full_name: 'evil' },
      generated_at: '1970-01-01T00:00:00.000Z',
    } as any);
    const [, body] = post.mock.calls[0];
    expect(body).not.toHaveProperty('generated_by');
    expect(body).not.toHaveProperty('generated_at');
  });
});
