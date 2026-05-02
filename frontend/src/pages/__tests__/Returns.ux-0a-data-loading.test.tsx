/**
 * Returns.ux-0a-data-loading.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-RETURNS-UX-0A — pins the data-loading diagnostic surface:
 *
 *   1. Initial load sends NO date_from / date_to (default datePreset='all'),
 *      so the page never silently hides historical rows.
 *   2. Existing returns render on first load (happy path).
 *   3. API errors are visible — never silently rendered as an empty list.
 *      403 surfaces the auth/permission card; other failures surface
 *      the generic error card (with HTTP status + retry button).
 *   4. The retry button calls the query's refetch.
 *   5. Filtered-empty state is distinct from no-data-yet state — the
 *      former offers a "مسح الفلاتر" button, the latter offers "create".
 *   6. Sparse / null-heavy backend rows render with fallback labels
 *      (`غير معروف`, `—`) and don't crash the page.
 *   7. `status='cancelled'` rows render with the new "ملغي" badge.
 *   8. The page does NOT contain a cancel button — that ships in PR 1E.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { ReturnListItem } from '@/api/returns.api';

// ─── mocks ──────────────────────────────────────────────────────────

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
  // Old-but-real row: 3 months ago. Under the previous default
  // (datePreset='month'), the old code would have hidden this. The
  // initial-load test pins the new behavior: no date filter sent at
  // all, so this row reaches the page.
  return {
    id: 'r-old',
    return_no: 'RET-2026-000001',
    status: 'refunded',
    reason: 'wrong_size',
    total_refund: '250',
    restocking_fee: '0',
    net_refund: '250',
    refund_method: 'cash',
    requested_at: '2026-02-15T17:00:14.640Z',
    approved_at: '2026-02-15T17:00:39.310Z',
    refunded_at: '2026-02-15T17:00:54.528Z',
    rejected_at: null,
    created_at: '2026-02-15T17:00:14.640Z',
    updated_at: '2026-02-15T17:00:54.528Z',
    original_invoice_id: 'inv-old',
    invoice_no: 'INV-2026-000001',
    customer_id: null,
    customer_name: 'عميل قديم',
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
    journal_entry_id: 'je-old',
    journal_entry_no: 'JE-2026-000001',
    journal_entry_posted_at: '2026-02-15T17:00:54.528Z',
    refund_cashbox_transaction_id: 100,
    has_unlinked_cash_leg: false,
    accounting_status: 'matched',
    inventory_status: 'restored',
    match_status: 'matched',
    restock_eligible_items: 1,
    ...over,
  };
}

/** A row with every operator/cashbox/journal field nulled — ensures the
 *  defensive fallbacks (`غير معروف`, `—`) survive a sparse BE row. */
function sparseRow(): ReturnListItem {
  return row({
    id: 'r-sparse',
    return_no: 'RET-2026-NULL-1',
    requested_by_name: null,
    approved_by_name: null,
    refunded_by_name: null,
    cashbox_id: null,
    cashbox_name: null,
    journal_entry_id: null,
    journal_entry_no: null,
    journal_entry_posted_at: null,
    refund_cashbox_transaction_id: null,
    accounting_status: undefined,
    inventory_status: undefined,
    match_status: undefined,
    restock_eligible_items: null,
  });
}

function cancelledRow(): ReturnListItem {
  return row({ id: 'r-cancelled', status: 'cancelled' });
}

/** Build an axios-shaped error for any HTTP status. */
function axiosError(status: number, message = 'fail') {
  const err: any = new Error(message);
  err.response = { status, data: { message } };
  return err;
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
//  1. Initial load sends NO date filters
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0a: initial-load filter defaults', () => {
  it('does NOT pass date_from or date_to on the very first list() call', async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const params = listMock.mock.calls[0][0];
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty('date_from');
    expect(params).not.toHaveProperty('date_to');
  });

  it('renders an old (3-month-old) return on first load — proves no hidden window', async () => {
    listMock.mockResolvedValue([row()]); // requested_at = 2026-02-15
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(await screen.findByTestId('returns-row-r-old')).toBeInTheDocument();
  });

  it('exposes the new "الكل" date-preset chip and it is selected by default', async () => {
    renderPage();
    const chipAll = await screen.findByTestId('returns-filter-date-all');
    expect(chipAll).toBeInTheDocument();
    // Active chip carries the brand-500 background class.
    expect(chipAll.className).toContain('bg-brand-500');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  2. Error / auth states
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0a: error visibility', () => {
  it('shows the generic error card with HTTP status when /returns 500s', async () => {
    listMock.mockRejectedValue(axiosError(500, 'boom'));
    renderPage();
    await screen.findByTestId('returns-error-generic');
    expect(screen.getByText('تعذر تحميل المرتجعات')).toBeInTheDocument();
    expect(screen.getByTestId('returns-error-message').textContent).toContain(
      'boom',
    );
    expect(screen.getByTestId('returns-error-status').textContent).toContain(
      '500',
    );
    // The "no data" card MUST NOT render when an error is present.
    expect(screen.queryByTestId('returns-empty-no-data')).toBeNull();
  });

  it('shows the auth/permission card on 401', async () => {
    listMock.mockRejectedValue(axiosError(401, 'Unauthorized'));
    renderPage();
    await screen.findByTestId('returns-error-unauthorized');
    expect(
      screen.getByText('غير مصرح أو انتهت الجلسة'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-error-login-link'),
    ).toBeInTheDocument();
  });

  it('shows the permission card on 403 with admin-contact hint', async () => {
    listMock.mockRejectedValue(axiosError(403, 'Forbidden'));
    renderPage();
    await screen.findByTestId('returns-error-unauthorized');
    expect(screen.getByText(/تواصل مع الأدمن/)).toBeInTheDocument();
  });

  it('the retry button calls returnsApi.list again', async () => {
    listMock
      .mockRejectedValueOnce(axiosError(500, 'first attempt'))
      .mockResolvedValueOnce([row()]);
    renderPage();
    await screen.findByTestId('returns-error-generic');
    expect(listMock).toHaveBeenCalledTimes(1);

    const retry = screen.getByTestId('returns-error-retry');
    fireEvent.click(retry);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    await screen.findByTestId('returns-row-r-old');
  });

  it('an exchanges-only failure on the "all" tab still shows error state', async () => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockRejectedValue(axiosError(500, 'exch boom'));
    renderPage();
    // The "all" tab fetches both endpoints; an exchanges 500 must be
    // visible — never silently swallowed into an empty list.
    await screen.findByTestId('returns-error-generic');
    expect(screen.getByTestId('returns-error-message').textContent).toContain(
      'exch boom',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  3. Empty-state distinction
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0a: empty-state distinction', () => {
  it('shows the no-data state when there are no rows AND no filters active', async () => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    const emptyCard = await screen.findByTestId('returns-empty-no-data');
    expect(screen.queryByTestId('returns-empty-filtered')).toBeNull();
    // No-data card offers a create CTA inside the card itself (the
    // page-header create button is matched separately and not what
    // this assertion is about).
    expect(emptyCard.textContent).toContain('لا توجد مرتجعات بعد');
    expect(
      emptyCard.querySelector('button')?.textContent ?? '',
    ).toContain('مرتجع جديد');
  });

  it('shows the filtered-empty state when filters narrow result to zero', async () => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    // Trigger a filter — typing in the search box.
    const search = await screen.findByTestId('returns-filter-search');
    fireEvent.change(search, { target: { value: 'NO_MATCH' } });

    await screen.findByTestId('returns-empty-filtered');
    expect(screen.queryByTestId('returns-empty-no-data')).toBeNull();
    expect(
      screen.getByText('لا توجد عمليات مطابقة للفلاتر'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-empty-clear-filters'),
    ).toBeInTheDocument();
  });

  it('"مسح الفلاتر" resets every filter and reverts to no-filter state', async () => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockResolvedValue([]);
    renderPage();
    const search = await screen.findByTestId('returns-filter-search');
    fireEvent.change(search, { target: { value: 'NO_MATCH' } });
    await screen.findByTestId('returns-empty-filtered');

    fireEvent.click(screen.getByTestId('returns-empty-clear-filters'));

    await waitFor(() => {
      expect(
        screen.queryByTestId('returns-empty-filtered'),
      ).toBeNull();
    });
    // Search input is back to empty.
    expect(
      (screen.getByTestId('returns-filter-search') as HTMLInputElement).value,
    ).toBe('');
  });

  it('exchanges empty array does NOT break page (returns still render on "all" tab)', async () => {
    listMock.mockResolvedValue([row()]);
    listExchangesMock.mockResolvedValue([]); // 0 exchanges
    renderPage();
    await screen.findByTestId('returns-row-r-old');
    // The page is intact — no error state.
    expect(screen.queryByTestId('returns-error-generic')).toBeNull();
    expect(screen.queryByTestId('returns-error-unauthorized')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4. Defensive null-safe mapping
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0a: defensive mapping', () => {
  it('renders sparse row (null operator + null cashbox + null JE) without crashing', async () => {
    listMock.mockResolvedValue([sparseRow()]);
    renderPage();
    const r = await screen.findByTestId('returns-row-r-sparse');
    // Operator name fallback.
    expect(r.textContent).toContain('غير معروف');
  });

  it('does not throw on a row with NaN-prone numeric fields', async () => {
    listMock.mockResolvedValue([
      row({
        id: 'r-nan',
        return_no: 'RET-NAN',
        net_refund: 'not-a-number' as any,
        units_count: null as any,
      }),
    ]);
    renderPage();
    // Page still renders.
    await screen.findByTestId('returns-row-r-nan');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  5. Cancelled status support
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0a: cancelled status', () => {
  it('renders a cancelled row with the "ملغي" badge', async () => {
    listMock.mockResolvedValue([cancelledRow()]);
    renderPage();
    const r = await screen.findByTestId('returns-row-r-cancelled');
    expect(r.textContent).toContain('ملغي');
    // It must NOT silently fall back to the pending label.
    expect(r.textContent).not.toContain('بانتظار الموافقة');
  });

  it('the tab list now includes a "ملغية" tab for filtering', async () => {
    renderPage();
    await screen.findByTestId('returns-tab-cancelled');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  6. No cancel button (defensive — admin cancel UI ships in PR 1E)
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 0a: no cancel UI yet', () => {
  it('does NOT add a cancel/إلغاء action button to the page chrome', async () => {
    listMock.mockResolvedValue([row()]);
    renderPage();
    await screen.findByTestId('returns-row-r-old');
    // No "إلغاء المرتجع" button anywhere.
    expect(
      screen.queryByRole('button', { name: /إلغاء المرتجع/ }),
    ).toBeNull();
    // No /cancel testid (would be added by PR 1E).
    expect(screen.queryByTestId(/returns-action-cancel/)).toBeNull();
  });
});
