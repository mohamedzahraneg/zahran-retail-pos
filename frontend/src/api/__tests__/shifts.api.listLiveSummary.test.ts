/**
 * shifts.api.listLiveSummary.test.ts
 * PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE
 *
 * Pins the bulk live-summary wrapper contract:
 *   1. POSTs to /shifts/reports/list-live-summary (NOT a per-row GET).
 *   2. Body shape: { shift_ids: string[] }.
 *   3. Client-side caps shift_ids at 100 to defend against the BE
 *      422 (and to prevent a buggy caller from accidentally
 *      submitting a 500-shift payload).
 *   4. Returns the BE response array verbatim.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client', () => {
  return {
    api: { post: vi.fn() },
    unwrap: vi.fn(<T>(p: Promise<{ data: T }>) => p.then((r) => r.data)),
  };
});

import { api } from '../client';
import { shiftsApi } from '../shifts.api';

const post = api.post as unknown as ReturnType<typeof vi.fn>;

const stubResponse = (data: any) => Promise.resolve({ data });

describe('shiftsApi.listLiveSummary wrapper', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockImplementation(() => stubResponse([]));
  });

  it('POSTs to /shifts/reports/list-live-summary with { shift_ids }', async () => {
    await shiftsApi.listLiveSummary(['a', 'b', 'c']);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/shifts/reports/list-live-summary');
    expect(body).toEqual({ shift_ids: ['a', 'b', 'c'] });
  });

  it('caps the request body at 100 ids client-side (defense-in-depth)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    await shiftsApi.listLiveSummary(ids);
    const [, body] = post.mock.calls[0];
    expect(body.shift_ids).toHaveLength(100);
    // Slice from the start (preserves caller-provided ordering).
    expect(body.shift_ids[0]).toBe('id-0');
    expect(body.shift_ids[99]).toBe('id-99');
  });

  it('returns the response array verbatim', async () => {
    const fixture = [
      {
        shift_id: 'sh-A',
        expected_closing: 1160,
        actual_closing: 1160,
        variance: 0,
        cash_total: 1225,
        non_cash_total: 500,
        invoice_count: 7,
        total_sales: 1725,
        total_collections: 1725,
      },
    ];
    post.mockImplementation(() => stubResponse(fixture));
    const out = await shiftsApi.listLiveSummary(['sh-A']);
    expect(out).toEqual(fixture);
  });

  it('does NOT call any per-row endpoint (no /shifts/{id}/summary fan-out)', async () => {
    await shiftsApi.listLiveSummary(['a', 'b', 'c']);
    // Only one POST went out, against the bulk endpoint.
    expect(post).toHaveBeenCalledTimes(1);
    const calledUrls = post.mock.calls.map((c) => c[0]);
    for (const url of calledUrls) {
      expect(url).not.toMatch(/\/shifts\/[^/]+\/summary$/);
    }
  });
});
