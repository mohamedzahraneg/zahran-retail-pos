/**
 * Returns.ux-0b-data-visibility.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-RETURNS-UX-0B — pins the data-visibility safeguards added on
 * top of Phase 0a:
 *
 *   1. `normalizeListResponse` accepts {array | rows | data | items |
 *      results} and tags an empty array with `__shapeWarning` for any
 *      unrecognized shape.
 *   2. The page never renders a visually blank list area: at least one
 *      of (rows / loading / error / no-data / filtered-empty /
 *      diagnostic banner) is always present in the DOM.
 *   3. The visible diagnostic banner appears whenever the list area is
 *      empty (no rows, no error, no loading) and surfaces the runtime
 *      counts + filter values + any shape warning.
 *   4. A non-array `returns` payload that slips through the adapter
 *      (defensive belt-and-suspenders) does NOT crash the page —
 *      surfaces a "map error" diagnostic instead.
 *
 * The diagnostic banner is intentionally temporary; it can be removed
 * once the user confirms data is visible. The tests below pin its
 * exact testids so the eventual cleanup PR has a clear contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { ReturnListItem } from '@/api/returns.api';
import { normalizeListResponse } from '@/api/returns.api';

// ─── normalizer: pure-function tests ───────────────────────────────

describe('normalizeListResponse — shape adapter', () => {
  it('passes through a real array unchanged', () => {
    const arr = [{ id: 'a' }, { id: 'b' }];
    expect(normalizeListResponse(arr)).toBe(arr);
  });

  it('extracts the array from a {rows, total} envelope', () => {
    const out = normalizeListResponse<{ id: string }>({
      rows: [{ id: 'a' }, { id: 'b' }],
      total: 2,
    });
    expect(out).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('extracts the array from a {data: [...]} envelope', () => {
    const out = normalizeListResponse<{ id: string }>({
      data: [{ id: 'x' }],
    });
    expect(out).toEqual([{ id: 'x' }]);
  });

  it('extracts the array from an {items: [...]} envelope', () => {
    expect(
      normalizeListResponse<number>({ items: [1, 2, 3] }),
    ).toEqual([1, 2, 3]);
  });

  it('extracts the array from a {results: [...]} envelope', () => {
    expect(
      normalizeListResponse<number>({ results: [9] }),
    ).toEqual([9]);
  });

  it('returns [] (with __shapeWarning tag) for a recognized-but-empty payload', () => {
    // null / undefined / number / random object → safely empty.
    const out = normalizeListResponse<unknown>(null);
    expect(out).toEqual([]);
    expect((out as any).__shapeWarning).toBe('unexpected payload shape');
  });

  it('returns [] (with __shapeWarning tag) for a totally unknown shape', () => {
    const out = normalizeListResponse<unknown>({ weird: 1, nope: 'x' });
    expect(out).toEqual([]);
    expect((out as any).__shapeWarning).toBe('unexpected payload shape');
  });

  it('does not throw on objects without the marker keys', () => {
    expect(() => normalizeListResponse({ pagination: {} })).not.toThrow();
  });
});

// ─── page-level integration tests ──────────────────────────────────

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

function row(over: Partial<ReturnListItem> = {}): ReturnListItem {
  return {
    id: 'r-prod-' + (over.id ?? 'a'),
    return_no: 'RET-2026-000001',
    status: 'refunded',
    reason: 'wrong_size',
    total_refund: '250',
    restocking_fee: '0',
    net_refund: '250',
    refund_method: 'cash',
    requested_at: '2026-04-25T17:00:14.640Z',
    approved_at: '2026-04-25T17:00:39.310Z',
    refunded_at: '2026-04-25T17:00:54.528Z',
    rejected_at: null,
    created_at: '2026-04-25T17:00:14.640Z',
    updated_at: '2026-04-25T17:00:54.528Z',
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
    journal_entry_posted_at: '2026-04-25T17:00:54.528Z',
    refund_cashbox_transaction_id: 245,
    has_unlinked_cash_leg: false,
    accounting_status: 'matched',
    inventory_status: 'restored',
    match_status: 'matched',
    restock_eligible_items: 1,
    ...over,
  };
}

function fourProductionReturns(): ReturnListItem[] {
  return [
    row({ id: 'r-prod-1', return_no: 'RET-2026-000001' }),
    row({ id: 'r-prod-2', return_no: 'RET-2026-000002' }),
    row({ id: 'r-prod-3', return_no: 'RET-2026-000003' }),
    row({ id: 'r-prod-4', return_no: 'RET-2026-000004' }),
  ];
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
//  1. Production-shape happy path
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0b: production-shape happy path', () => {
  it('renders all 4 returns on default load', async () => {
    listMock.mockResolvedValue(fourProductionReturns());
    listExchangesMock.mockResolvedValue([]);
    renderPage();

    for (const n of [1, 2, 3, 4]) {
      await screen.findByTestId(`returns-row-r-prod-${n}`);
    }
    // The diagnostic banner must NOT appear when rows are present.
    expect(
      screen.queryByTestId('returns-diagnostic-banner'),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  2. Diagnostic banner
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0b: diagnostic banner', () => {
  it('appears when list is empty (no error, no loading) and shows counts + filters', async () => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockResolvedValue([]);
    renderPage();

    const banner = await screen.findByTestId('returns-diagnostic-banner');
    expect(banner).toBeInTheDocument();
    // PR-FIN-RETURNS-UX-0B — spec'd Arabic header literal must render.
    expect(banner.textContent).toContain('تشخيص تحميل البيانات');
    // Counts are visible (with their spec'd labels).
    const rCount = screen.getByTestId('returns-diag-returns-count');
    const xCount = screen.getByTestId('returns-diag-exchanges-count');
    expect(rCount.textContent).toContain('عدد المرتجعات المحمّلة');
    expect(xCount.textContent).toContain('عدد الاستبدالات المحمّلة');
    expect(rCount.textContent).toMatch(/0/);
    expect(xCount.textContent).toMatch(/0/);
    // State + filters are visible.
    expect(screen.getByTestId('returns-diag-state').textContent).toMatch(
      /success/,
    );
    const filters = screen.getByTestId('returns-diag-filters');
    expect(filters.textContent).toContain('tab=');
    expect(filters.textContent).toContain('datePreset=');
    expect(filters.textContent).toContain('q=');
  });

  it('does NOT appear when at least one row is present', async () => {
    listMock.mockResolvedValue([row()]);
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    await screen.findByTestId('returns-row-r-prod-a');
    expect(
      screen.queryByTestId('returns-diagnostic-banner'),
    ).toBeNull();
  });

  it('does NOT appear during the initial loading state', async () => {
    // Never resolve — query stays in loading.
    listMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    // After microtasks settle, banner is still absent.
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId('returns-diagnostic-banner'),
    ).toBeNull();
  });

  it('renders the shape-warning row with its spec\'d Arabic label when __shapeWarning is tagged', async () => {
    // Hand-craft a tagged empty array — the same shape `normalizeListResponse`
    // produces when the BE payload is unrecognized.
    const tagged: any[] = [];
    Object.defineProperty(tagged, '__shapeWarning', {
      value: 'unexpected payload shape',
      enumerable: false,
    });
    listMock.mockResolvedValue(tagged);
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    const warn = await screen.findByTestId('returns-diag-shape-warning');
    expect(warn.textContent).toContain('تحذير شكل الاستجابة');
    expect(warn.textContent).toContain('unexpected payload shape');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  3. Page never goes visually blank
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0b: page never blank', () => {
  it('always renders one of {rows, loading, error, no-data, filtered, banner}', async () => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockResolvedValue([]);
    renderPage();

    await screen.findByTestId('returns-list');

    // Wait for the resolved-empty state.
    await screen.findByTestId('returns-empty-no-data');

    // The list container has a min-height so it is never collapsed
    // to zero height (visual safety net regardless of inner content).
    const listEl = screen.getByTestId('returns-list');
    expect(listEl.className).toMatch(/min-h-\[200px\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4. Defensive belt-and-suspenders: non-array slips through
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0b: non-array payload safety', () => {
  it('does not crash when listMock unexpectedly returns a non-array', async () => {
    // Bypass the adapter (which would otherwise normalize to [])
    // by mocking the api method directly. The page-level useMemo
    // try/catch + Array.isArray guards must catch this cleanly.
    listMock.mockResolvedValue({ unexpected: true } as any);
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    // Banner appears with the map-error diagnostic.
    const banner = await screen.findByTestId('returns-diagnostic-banner');
    expect(banner).toBeInTheDocument();
    const mapErr = await screen.findByTestId('returns-diag-map-error');
    // PR-FIN-RETURNS-UX-0B — spec'd Arabic label for the map-error row.
    expect(mapErr.textContent).toContain('خطأ تحويل البيانات');
    expect(mapErr.textContent).toContain('non-array');
  });
});
