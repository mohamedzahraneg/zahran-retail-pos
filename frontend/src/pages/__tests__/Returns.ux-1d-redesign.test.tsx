/**
 * Returns.ux-1d-redesign.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-RETURNS-UX-1D — pins the redesigned Returns & Exchanges page:
 *   • Layout: title, subtitle, 6 KPI cards, 8 tabs, filters, master/detail.
 *   • Filters: search, date preset (today/week/month/custom), refund_method,
 *     accounting_status, sort threading into the API request.
 *   • Row enrichment: operator name + DD/MM/YYYY HH:mm:ss timestamp +
 *     accounting/inventory/match badges.
 *   • Details panel: operator/timestamps section, refund/payment section,
 *     inventory impact section, accounting diagnostic section, timeline.
 *   • Missing-user fallback renders `غير معروف` (never blank).
 *   • Exchange-specific: returned/replacement split + price delta tile.
 *   • Diagnostic-only: NO settlement / cancel / fix-accounting button.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type {
  ReturnDetails,
  ReturnListItem,
} from '@/api/returns.api';

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
  return {
    id: 'r1',
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

function detail(): ReturnDetails {
  // ReturnListItem declares the operator-name fields as optional
  // (`?:`), but `ReturnDetails extends ReturnListItem` redeclares them
  // as `string | null` (always present in the findOne response).
  // Spreading `...row()` widens to `string | null | undefined`, so the
  // operator-name fields must be re-asserted explicitly here.
  const base = row();
  return {
    ...base,
    requested_by_name: base.requested_by_name ?? null,
    approved_by_name: base.approved_by_name ?? null,
    refunded_by_name: base.refunded_by_name ?? null,
    reason_details: 'العميل غير المقاس',
    notes: '',
    warehouse_id: 'w1',
    warehouse_name: 'المخزن الرئيسي',
    invoice_date: '2026-04-25T16:00:00Z',
    items: [
      {
        id: 'ri-1',
        original_invoice_item_id: 'oii-1',
        variant_id: 'v-1',
        product_name: 'قميص',
        sku: 'SH-001',
        color: 'أزرق',
        size: 'L',
        quantity: 1,
        unit_price: '250',
        refund_amount: '250',
        condition: 'resellable',
        back_to_stock: true,
        notes: null,
      },
    ],
  };
}

function exchange(over: any = {}) {
  return {
    id: 'ex-1',
    exchange_no: 'EXC-2026-000001',
    status: 'completed',
    returned_value: 100,
    new_items_value: 150,
    price_difference: 50,
    created_at: '2026-04-26T10:05:12.000Z',
    completed_at: '2026-04-26T10:08:12.000Z',
    original_invoice_no: 'INV-2026-000099',
    new_invoice_no: 'INV-2026-000100',
    customer_name: 'فاطمة',
    customer_phone: '0100000000',
    ...over,
  };
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
  getMock.mockResolvedValue(detail());
  listExchangesMock.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────
//  1. Layout
// ─────────────────────────────────────────────────────────────────────

describe('Returns — layout', () => {
  it('renders title + subtitle + 6 KPI cards + 8 tabs + filters + master-detail', async () => {
    renderPage();
    await screen.findByTestId('returns-page');

    // Title + subtitle
    expect(screen.getByText('المرتجعات والاستبدال')).toBeInTheDocument();
    expect(
      screen.getByText(/إدارة المرتجعات، الاستبدالات/),
    ).toBeInTheDocument();

    // KPI cards (6)
    expect(screen.getByTestId('kpi-today-returns')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-today-exchanges')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-pending')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-refunded')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-stock-impact')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-needs-review')).toBeInTheDocument();

    // 8 tabs
    for (const t of [
      'all',
      'returns',
      'exchanges',
      'pending',
      'approved',
      'refunded',
      'rejected',
      'needs_review',
    ]) {
      expect(screen.getByTestId(`returns-tab-${t}`)).toBeInTheDocument();
    }

    // Filters bar
    expect(screen.getByTestId('returns-filter-search')).toBeInTheDocument();
    expect(screen.getByTestId('returns-filter-date-preset')).toBeInTheDocument();
    expect(screen.getByTestId('returns-filter-refund-method')).toBeInTheDocument();
    expect(screen.getByTestId('returns-filter-accounting')).toBeInTheDocument();
    expect(screen.getByTestId('returns-filter-sort')).toBeInTheDocument();

    // Master + detail panes
    expect(screen.getByTestId('returns-list')).toBeInTheDocument();
    expect(screen.getByTestId('returns-details-empty')).toBeInTheDocument();
    expect(screen.getByText('اختر عملية لعرض التفاصيل')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  2. Filters thread into the API request
// ─────────────────────────────────────────────────────────────────────

describe('Returns — filter wiring', () => {
  it('clicking "اليوم" preset sends date_from = date_to = today', async () => {
    renderPage();
    await screen.findByTestId('returns-filter-date-today');
    fireEvent.click(screen.getByTestId('returns-filter-date-today'));
    await waitFor(() => {
      const last = listMock.mock.calls.at(-1)?.[0] ?? {};
      expect(last.date_from).toBe(last.date_to);
      expect(typeof last.date_from).toBe('string');
      expect(last.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('refund_method filter threads into the request', async () => {
    renderPage();
    await screen.findByTestId('returns-filter-refund-method');
    fireEvent.change(screen.getByTestId('returns-filter-refund-method'), {
      target: { value: 'cash' },
    });
    await waitFor(() => {
      const last = listMock.mock.calls.at(-1)?.[0] ?? {};
      expect(last.refund_method).toBe('cash');
    });
  });

  it('accounting_status filter threads into the request', async () => {
    renderPage();
    await screen.findByTestId('returns-filter-accounting');
    fireEvent.change(screen.getByTestId('returns-filter-accounting'), {
      target: { value: 'cashbox_not_linked' },
    });
    await waitFor(() => {
      const last = listMock.mock.calls.at(-1)?.[0] ?? {};
      expect(last.accounting_status).toBe('cashbox_not_linked');
    });
  });

  it('"يحتاج مراجعة" tab forces accounting_status=needs_review', async () => {
    renderPage();
    await screen.findByTestId('returns-tab-needs_review');
    fireEvent.click(screen.getByTestId('returns-tab-needs_review'));
    await waitFor(() => {
      const last = listMock.mock.calls.at(-1)?.[0] ?? {};
      expect(last.accounting_status).toBe('needs_review');
    });
  });

  it('status tabs (pending/approved/refunded/rejected) thread their status', async () => {
    renderPage();
    for (const s of ['pending', 'approved', 'refunded', 'rejected']) {
      await screen.findByTestId(`returns-tab-${s}`);
      fireEvent.click(screen.getByTestId(`returns-tab-${s}`));
      await waitFor(() => {
        const last = listMock.mock.calls.at(-1)?.[0] ?? {};
        expect(last.status).toBe(s);
      });
    }
  });

  it('"الاستبدالات" tab does NOT call returnsApi.list (only listExchanges)', async () => {
    renderPage();
    await screen.findByTestId('returns-tab-exchanges');
    listMock.mockClear();
    fireEvent.click(screen.getByTestId('returns-tab-exchanges'));
    await waitFor(() => {
      expect(listExchangesMock).toHaveBeenCalled();
    });
    // After clicking exchanges, list() must NOT be called for that tab.
    // (May have been called before mockClear; we cleared above.)
    await new Promise((r) => setTimeout(r, 30));
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  3. Row enrichment — operator name + timestamp + badges
// ─────────────────────────────────────────────────────────────────────

describe('Returns — row enrichment', () => {
  it('row shows operator name + DD/MM/YYYY HH:mm:ss + 3 diagnostic badges', async () => {
    renderPage();
    const r = await screen.findByTestId('returns-row-r1');
    // Operator name
    const meta = await screen.findByTestId('returns-row-r1-meta');
    expect(meta.textContent).toContain('محمود زهران');
    // Timestamp formatted (Arabic-Indic digits via Intl 'ar-EG')
    expect(meta.textContent).toMatch(/[\d٠-٩]{2}\/[\d٠-٩]{2}\/[\d٠-٩]{4}/);
    // Three badges with the inventory / accounting / match labels
    const badges = await screen.findByTestId('returns-row-r1-badges');
    expect(badges.textContent).toContain('المخزون');
    expect(badges.textContent).toContain('المحاسبة');
    expect(badges.textContent).toContain('المطابقة');
    // The row container holds the operation number
    expect(r.textContent).toContain('RET-2026-000001');
  });

  it('row shows NO raw ISO/GMT date strings', async () => {
    renderPage();
    const r = await screen.findByTestId('returns-row-r1');
    expect(r.textContent).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    expect(r.textContent).not.toMatch(/GMT|UTC/i);
  });

  it('missing operator name falls back to غير معروف', async () => {
    listMock.mockResolvedValueOnce([
      row({
        id: 'r2',
        return_no: 'RET-2026-000002',
        requested_by_name: null,
        approved_by_name: null,
        refunded_by_name: null,
      }),
    ]);
    renderPage();
    const meta = await screen.findByTestId('returns-row-r2-meta');
    expect(meta.textContent).toContain('غير معروف');
  });

  it('row badges reflect cashbox_not_linked diagnostic when accounting_status says so', async () => {
    listMock.mockResolvedValueOnce([
      row({
        id: 'r3',
        return_no: 'RET-2026-000003',
        accounting_status: 'cashbox_not_linked',
        match_status: 'needs_review',
        has_unlinked_cash_leg: true,
      }),
    ]);
    renderPage();
    const badges = await screen.findByTestId('returns-row-r3-badges');
    expect(badges.textContent).toContain('سطر النقد غير مربوط');
    expect(badges.textContent).toContain('تحتاج مراجعة');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4. Details panel
// ─────────────────────────────────────────────────────────────────────

describe('Returns — details panel', () => {
  it('selecting a row renders all 5 detail sections', async () => {
    renderPage();
    const r = await screen.findByTestId('returns-row-r1');
    fireEvent.click(r);
    // Wait for the detail data fetch.
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('r1'),
    );
    expect(
      await screen.findByTestId('returns-detail-operator-timestamps'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-detail-refund-section'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-detail-inventory-section'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-detail-accounting-section'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('returns-detail-timeline')).toBeInTheDocument();
  });

  it('details panel shows JE number + cashbox name + accounting badges (diagnostic only)', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    const acc = await screen.findByTestId('returns-detail-accounting-section');
    expect(acc.textContent).toContain('JE-2026-000358');
    expect(acc.textContent).toContain('الخزينة الرئيسية');
    expect(acc.textContent).toContain('مطابق');
    expect(acc.textContent).toContain('عرض تشخيصي فقط');
  });

  it('refund section shows cashbox name + CT id when cash refund', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    const refund = await screen.findByTestId('returns-detail-refund-section');
    expect(refund.textContent).toContain('كاش');
    expect(refund.textContent).toContain('الخزينة الرئيسية');
    expect(refund.textContent).toContain('CT #245');
  });

  it('timeline renders operator + timestamp for every state change', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    const tl = await screen.findByTestId('returns-detail-timeline');
    expect(tl.textContent).toContain('إنشاء المرتجع');
    expect(tl.textContent).toContain('الموافقة');
    expect(tl.textContent).toContain('صرف المبلغ');
    expect(tl.textContent).toContain('محمود زهران');
    // No raw ISO leaks in the timeline.
    expect(tl.textContent).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
  });

  it('details panel renders غير معروف for missing user names', async () => {
    getMock.mockResolvedValueOnce({
      ...detail(),
      requested_by_name: null,
      approved_by_name: null,
      refunded_by_name: null,
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    const ts = await screen.findByTestId(
      'returns-detail-operator-timestamps',
    );
    expect(ts.textContent).toContain('غير معروف');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  5. Diagnostic-only — NO settlement / cancel / fix-accounting
// ─────────────────────────────────────────────────────────────────────

describe('Returns — diagnostic only (no settlement/cancel/fix actions)', () => {
  it('has no "إلغاء" / cancellation button anywhere', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-detail-accounting-section');
    expect(screen.queryByText(/إلغاء المرتجع/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/تصحيح الحساب|إصلاح القيد|fix accounting/i),
    ).not.toBeInTheDocument();
  });

  it('no settlement / مطابقة-fix action visible in row or details', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-detail-accounting-section');
    expect(screen.queryByText(/تسوية|settlement/i)).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  6. Exchange-specific
// ─────────────────────────────────────────────────────────────────────

describe('Returns — exchange-specific display', () => {
  beforeEach(() => {
    listMock.mockResolvedValue([]);
    listExchangesMock.mockResolvedValue([exchange()]);
  });

  it('exchanges tab renders the row + opens an exchange-specific detail panel', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-tab-exchanges'));
    const r = await screen.findByTestId('returns-row-ex-1');
    expect(r.textContent).toContain('EXC-2026-000001');
    expect(r.textContent).toContain('استبدال');

    fireEvent.click(r);
    expect(
      await screen.findByTestId('exchange-details-panel'),
    ).toBeInTheDocument();
    const split = screen.getByTestId('exchange-split');
    expect(split.textContent).toContain('المُرجَع');
    expect(split.textContent).toContain('البديل');
    expect(screen.getByTestId('exchange-price-delta')).toBeInTheDocument();
  });

  it('positive delta shows "+" prefix and "العميل دفع الفرق"', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-tab-exchanges'));
    fireEvent.click(await screen.findByTestId('returns-row-ex-1'));
    const delta = await screen.findByTestId('exchange-price-delta');
    expect(delta.textContent).toContain('+');
    expect(delta.textContent).toContain('العميل دفع الفرق');
  });

  it('zero delta shows "لا يوجد أثر نقدي"', async () => {
    listExchangesMock.mockResolvedValueOnce([
      exchange({ id: 'ex-2', exchange_no: 'EXC-2026-000002', price_difference: 0 }),
    ]);
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-tab-exchanges'));
    fireEvent.click(await screen.findByTestId('returns-row-ex-2'));
    const delta = await screen.findByTestId('exchange-price-delta');
    expect(delta.textContent).toContain('لا يوجد أثر نقدي');
  });

  it('negative delta shows "تم رد الفرق للعميل"', async () => {
    listExchangesMock.mockResolvedValueOnce([
      exchange({ id: 'ex-3', exchange_no: 'EXC-2026-000003', price_difference: -30 }),
    ]);
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-tab-exchanges'));
    fireEvent.click(await screen.findByTestId('returns-row-ex-3'));
    const delta = await screen.findByTestId('exchange-price-delta');
    expect(delta.textContent).toContain('تم رد الفرق للعميل');
  });
});
