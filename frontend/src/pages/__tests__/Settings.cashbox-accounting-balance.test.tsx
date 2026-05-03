/**
 * Settings.cashbox-accounting-balance.test.tsx
 * PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE
 *
 * Pins the Settings → "الخزائن" tab balance cell:
 *
 *   ✓ ewallet/bank/check rows show the GL-derived `accounting_balance`
 *     and a "محاسبي" pill (so the operator sees the wallet money sat
 *     in GL 1114 instead of the misleading stored 0).
 *
 *   ✓ cash rows still show `current_balance` plain — no pill.
 *
 *   ✓ non-cash rows missing a GL link render the "غير مربوط" amber
 *     warning pill instead of pretending to have a balance.
 *
 * Locks the regression: anyone reverting this cell to a flat
 * `cb.current_balance` print fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const listCashboxesMock = vi.fn();
const listWarehousesMock = vi.fn();

vi.mock('@/api/settings.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    settingsApi: {
      listCashboxes: () => listCashboxesMock(),
      listWarehouses: () => listWarehousesMock(),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import { CashboxesTab } from '../Settings';

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CashboxesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listWarehousesMock.mockResolvedValue([]);
});

describe('Settings → CashboxesTab balance cell — PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE', () => {
  it('ewallet row shows the GL-derived accounting_balance + "محاسبي" pill (NOT stored 0)', async () => {
    // Production fixture-shape: خزنة التحويلات stores 0 (non-cash
    // payments don't write CTs) but GL 1114 has +2,190 EGP.
    listCashboxesMock.mockResolvedValue([
      {
        id: 'cb-ewallet', name_ar: 'خزنة التحويلات', warehouse_name: 'الفرع الرئيسي',
        kind: 'ewallet', current_balance: 0, is_active: true,
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      },
    ]);
    renderTab();
    const row = await screen.findByText('خزنة التحويلات');
    const tr = row.closest('tr')!;
    // Real derived figure visible.
    expect(within(tr).getByText(/2,190\.00/)).toBeInTheDocument();
    // The pill exists for ewallet rows.
    expect(within(tr).getByTestId('cashbox-accounting-badge-cb-ewallet')).toBeInTheDocument();
    expect(within(tr).getByTestId('cashbox-accounting-badge-cb-ewallet').textContent).toMatch(/محاسبي/);
  });

  it('cash row shows current_balance and NO "محاسبي" pill (drawer figure is canonical)', async () => {
    listCashboxesMock.mockResolvedValue([
      {
        id: 'cb-cash', name_ar: 'الخزينة الرئيسية', warehouse_name: 'الفرع الرئيسي',
        kind: 'cash', current_balance: 5000, is_active: true,
        accounting_gl_code: null, accounting_balance: null,
      },
    ]);
    renderTab();
    const row = await screen.findByText('الخزينة الرئيسية');
    const tr = row.closest('tr')!;
    expect(within(tr).getByText(/5,000\.00/)).toBeInTheDocument();
    expect(within(tr).queryByTestId('cashbox-accounting-badge-cb-cash')).toBeNull();
    expect(within(tr).queryByText('محاسبي')).toBeNull();
  });

  it('bank row shows the derived figure with "محاسبي" pill', async () => {
    listCashboxesMock.mockResolvedValue([
      {
        id: 'cb-bank', name_ar: 'حساب POS Visa', warehouse_name: 'الفرع الرئيسي',
        kind: 'bank', current_balance: 0, is_active: true,
        accounting_gl_code: '1113', accounting_balance: '4500.00',
      },
    ]);
    renderTab();
    const row = await screen.findByText('حساب POS Visa');
    const tr = row.closest('tr')!;
    expect(within(tr).getByText(/4,500\.00/)).toBeInTheDocument();
    expect(within(tr).getByTestId('cashbox-accounting-badge-cb-bank')).toBeInTheDocument();
  });

  it('non-cash row missing a GL link renders the "غير مربوط" amber warning pill', async () => {
    // Defensive: settings.service.ts shouldn't produce this in production
    // (the CASE expression always supplies a GL code for ewallet/bank/check),
    // but if it ever does, the FE warns instead of pretending.
    listCashboxesMock.mockResolvedValue([
      {
        id: 'cb-orphan', name_ar: 'خزنة بدون GL', warehouse_name: 'الفرع',
        kind: 'ewallet', current_balance: 0, is_active: true,
        accounting_gl_code: null, accounting_balance: '0',
      },
    ]);
    renderTab();
    const row = await screen.findByText('خزنة بدون GL');
    const tr = row.closest('tr')!;
    await waitFor(() => {
      expect(within(tr).getByText('غير مربوط')).toBeInTheDocument();
    });
  });

  it('mixed cash + ewallet table renders BOTH cells with the right semantics in one pass', async () => {
    listCashboxesMock.mockResolvedValue([
      {
        id: 'cb-cash', name_ar: 'الخزينة الرئيسية', warehouse_name: 'A',
        kind: 'cash', current_balance: 1500, is_active: true,
        accounting_gl_code: null, accounting_balance: null,
      },
      {
        id: 'cb-ewallet', name_ar: 'خزنة التحويلات', warehouse_name: 'A',
        kind: 'ewallet', current_balance: 0, is_active: true,
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      },
    ]);
    renderTab();
    await screen.findByText('الخزينة الرئيسية');
    const cashRow = screen.getByText('الخزينة الرئيسية').closest('tr')!;
    const ewalletRow = screen.getByText('خزنة التحويلات').closest('tr')!;
    expect(within(cashRow).getByText(/1,500\.00/)).toBeInTheDocument();
    expect(within(cashRow).queryByText('محاسبي')).toBeNull();
    expect(within(ewalletRow).getByText(/2,190\.00/)).toBeInTheDocument();
    expect(within(ewalletRow).getByText('محاسبي')).toBeInTheDocument();
  });
});
