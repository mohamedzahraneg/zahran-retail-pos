/**
 * Cashboxes.fix-10-edit-mapping.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX-10
 *
 * Pins the production fix for the "Validation failed (uuid is
 * expected)" toast operators saw when linking a cashbox to a real
 * InstaPay PA. Root cause was an unsafe cast
 * `b as unknown as PaymentAccount` in two places, which left
 * `paEditing.id` undefined at runtime → PATCH path
 * `/payment-accounts/undefined` → ParseUUIDPipe (HOTFIX-1) rejected.
 *
 * What we lock:
 *   • Clicking the table-row edit button on a real PA opens the
 *     modal seeded with the REAL payment_account_id as `id`.
 *   • Saving from the modal calls `paymentsApi.updateAccount` with
 *     that real UUID — never `'undefined'`, never `'null'`, never
 *     the synthetic-row sentinel `unattached:<method>`.
 *   • Cashbox link round-trip: send a real UUID when the operator
 *     selects a cashbox; send `null` when they clear the link.
 *   • Synthetic unattached rows have NO edit button rendered. (PR
 *     #212 already pins this; this test asserts it specifically for
 *     the FIX-10 mapping path.)
 *
 * The mapping helper itself (`balanceToAccount`) is private to
 * `Cashboxes.tsx`; we exercise it indirectly through the rendered
 * table → modal → save flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type { PaymentAccountBalance, PaymentMethodMixRow, PaymentProvider } from '@/api/payments.api';
import type { Cashbox, FinancialInstitution } from '@/api/cash-desk.api';

// ─── Mocks ──────────────────────────────────────────────────────────
const cashboxesMock     = vi.fn();
const movementsMock     = vi.fn();
const glDriftMock       = vi.fn();
const balancesMock      = vi.fn();
const providersMock     = vi.fn();
const methodMixMock     = vi.fn();
const updateAccountMock = vi.fn();

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      cashboxes:               () => cashboxesMock(),
      movements:        (p: any) => movementsMock(p),
      glDrift:                 () => glDriftMock(),
      cashboxMovementsUnified: vi.fn(async () => ({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      })),
      transfer:      vi.fn(async () => ({})),
      updateCashbox: vi.fn(async () => ({})),
      createCashbox: vi.fn(async () => ({})),
      removeCashbox: vi.fn(async () => ({})),
      institutions:  vi.fn(async (): Promise<FinancialInstitution[]> => []),
    },
  };
});

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      listProviders:      () => providersMock(),
      listBalances:       () => balancesMock(),
      methodMix:          () => methodMixMock(),
      unattachedSummary:  vi.fn(async () => []),
      backfillUnattached: vi.fn(),
      setDefault:         vi.fn(async () => ({})),
      toggleActive:       vi.fn(async () => ({})),
      deleteAccount:      vi.fn(async () => ({ id: '', mode: 'hard' as const })),
      createAccount:      vi.fn(async () => ({})),
      updateAccount:      (id: string, body: any) => updateAccountMock(id, body),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import Cashboxes from '../Cashboxes';

// ─── Fixtures ───────────────────────────────────────────────────────
const REAL_INSTAPAY_ID = '4dbe8e84-f145-4bbb-a508-4f934bf302ca';
const EWALLET_CASHBOX_ID = 'b533200b-ec23-4cb8-a539-8c78e3679f78';

function makeBalance(over: Partial<PaymentAccountBalance> = {}): PaymentAccountBalance {
  return {
    payment_account_id: REAL_INSTAPAY_ID,
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay',
    identifier: '01004888879',
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: true,
    active: true,
    sort_order: 0,
    metadata: {},
    gl_name_ar: 'المحافظ الإلكترونية',
    normal_balance: 'debit',
    total_in: '355',
    total_out: '10',
    net_debit: '345',
    je_count: 4,
    last_movement: '2026-04-30',
    ...over,
  };
}

const PROVIDERS: PaymentProvider[] = [
  { provider_key: 'instapay', method: 'instapay', name_ar: 'إنستا باي', name_en: 'InstaPay',
    icon_name: 'wallet', logo_key: 'instapay', default_gl_account_code: '1114',
    group: 'instapay', requires_reference: true },
];
const METHOD_MIX: PaymentMethodMixRow[] = [];

const EWALLET_CASHBOX: Cashbox = {
  id: EWALLET_CASHBOX_ID, name: 'محفظة العمليات', name_ar: 'محفظة العمليات',
  warehouse_id: null, currency: 'EGP', current_balance: '0', is_active: true,
  kind: 'ewallet',
  institution_code: 'instapay', institution_name: 'إنستا باي', institution_name_en: 'InstaPay',
  institution_domain: null, institution_color: null, institution_kind: 'ewallet',
  bank_branch: null, account_number: null, iban: null, swift_code: null,
  account_holder_name: null, account_manager_name: null, account_manager_phone: null, account_manager_email: null,
  wallet_phone: null, wallet_owner_name: null, check_issuer_name: null, color: null,
};

function setAdmin() {
  useAuthStore.setState({ user: { id: 't', role: 'admin', permissions: ['*'] } as any });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Cashboxes />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setAdmin();
  cashboxesMock.mockResolvedValue([EWALLET_CASHBOX]);
  movementsMock.mockResolvedValue([]);
  glDriftMock.mockResolvedValue([]);
  providersMock.mockResolvedValue(PROVIDERS);
  methodMixMock.mockResolvedValue(METHOD_MIX);
  updateAccountMock.mockResolvedValue({ id: REAL_INSTAPAY_ID });
});

// ─── Tests ──────────────────────────────────────────────────────────
describe('/cashboxes — PR-FIN-PAYACCT-4D-UX-FIX-10 edit mapping', () => {
  it('clicking edit on a real InstaPay row opens the modal and saves with the REAL UUID (not "undefined")', async () => {
    balancesMock.mockResolvedValue([makeBalance()]);
    renderPage();

    // Wait for the row, click the row-action-edit button.
    const editBtn = await screen.findByTestId('row-action-edit');
    fireEvent.click(editBtn);

    // Modal opens. Save without touching anything.
    const modal = await screen.findByTestId('payment-account-modal');
    fireEvent.click(within(modal).getByTestId('payment-account-modal-submit'));

    await waitFor(() => expect(updateAccountMock).toHaveBeenCalledTimes(1));
    const [calledId, body] = updateAccountMock.mock.calls[0];
    // The critical assertion — id must be the real UUID, NOT undefined,
    // NOT 'undefined' string, NOT the synthetic sentinel.
    expect(calledId).toBe(REAL_INSTAPAY_ID);
    expect(calledId).not.toBe(undefined);
    expect(calledId).not.toBe('undefined');
    expect(String(calledId).startsWith('unattached:')).toBe(false);
    // No payload value sneaks in the sentinel either.
    for (const [k, v] of Object.entries(body)) {
      expect(v, `body.${k}`).not.toBe('undefined');
      expect(v, `body.${k}`).not.toBe('null');
    }
  });

  it('linking a cashbox sends a real cashbox_id UUID in the update payload', async () => {
    balancesMock.mockResolvedValue([makeBalance({ cashbox_id: null })]);
    renderPage();

    fireEvent.click(await screen.findByTestId('row-action-edit'));
    const modal = await screen.findByTestId('payment-account-modal');
    // Operator picks a wallet cashbox from the dropdown.
    fireEvent.change(within(modal).getByTestId('payment-account-modal-cashbox'), {
      target: { value: EWALLET_CASHBOX_ID },
    });
    fireEvent.click(within(modal).getByTestId('payment-account-modal-submit'));

    await waitFor(() => expect(updateAccountMock).toHaveBeenCalledTimes(1));
    const [calledId, body] = updateAccountMock.mock.calls[0];
    expect(calledId).toBe(REAL_INSTAPAY_ID);
    expect(body.cashbox_id).toBe(EWALLET_CASHBOX_ID);
  });

  it('clearing the linked cashbox sends cashbox_id: null', async () => {
    balancesMock.mockResolvedValue([makeBalance({ cashbox_id: EWALLET_CASHBOX_ID })]);
    renderPage();

    fireEvent.click(await screen.findByTestId('row-action-edit'));
    const modal = await screen.findByTestId('payment-account-modal');
    // Operator selects "— بدون ربط —" (empty option).
    fireEvent.change(within(modal).getByTestId('payment-account-modal-cashbox'), {
      target: { value: '' },
    });
    fireEvent.click(within(modal).getByTestId('payment-account-modal-submit'));

    await waitFor(() => expect(updateAccountMock).toHaveBeenCalledTimes(1));
    const [calledId, body] = updateAccountMock.mock.calls[0];
    expect(calledId).toBe(REAL_INSTAPAY_ID);
    expect(body.cashbox_id).toBeNull();
  });

  it('synthetic unattached row exposes NO edit / delete / set-default actions and clicking the row does NOT open the modal', async () => {
    balancesMock.mockResolvedValue([
      // Real account row — has the edit button (so we know edit IS rendered when applicable).
      makeBalance(),
      // Synthetic row with the FIX-9 sentinel.
      makeBalance({
        payment_account_id: 'unattached:instapay',
        is_default: false,
        sort_order: -1,
        net_debit: '1050',
        total_in: '1050',
        total_out: '0',
        is_unattached: true,
      }),
    ]);
    renderPage();

    // Synthetic row uses a different testid pattern (PR #212).
    const syntheticRow = await screen.findByTestId(
      'payment-account-row-unattached-instapay',
    );
    expect(syntheticRow).toBeInTheDocument();
    // No actionable buttons on the synthetic row.
    expect(within(syntheticRow).queryByTestId('row-action-edit')).toBeNull();
    expect(within(syntheticRow).queryByTestId('row-action-set-default')).toBeNull();
    expect(within(syntheticRow).queryByTestId('row-action-toggle-active')).toBeNull();
    expect(within(syntheticRow).queryByTestId('row-action-delete')).toBeNull();
    expect(within(syntheticRow).queryByTestId('row-action-view-details')).toBeNull();

    // Clicking the synthetic row does NOT open the modal (cursor isn't
    // even pointer; click is a no-op per PR #212 onClick guard).
    fireEvent.click(syntheticRow);
    expect(screen.queryByTestId('payment-account-modal')).toBeNull();

    // No PATCH request was fired.
    expect(updateAccountMock).not.toHaveBeenCalled();
  });

  it('no PATCH path ever uses the unattached sentinel id (regression guard for the cast bug)', async () => {
    // Render a page with both rows; even if a future change accidentally
    // wires up an edit handler on the synthetic row, the helper refuses
    // to map it (returns null), so updateAccount stays uncalled.
    balancesMock.mockResolvedValue([
      makeBalance(),
      makeBalance({
        payment_account_id: 'unattached:instapay',
        is_default: false,
        is_unattached: true,
        net_debit: '1050',
      }),
    ]);
    renderPage();

    // Click edit on the REAL row.
    const editBtn = await screen.findByTestId('row-action-edit');
    fireEvent.click(editBtn);
    const modal = await screen.findByTestId('payment-account-modal');
    fireEvent.click(within(modal).getByTestId('payment-account-modal-submit'));

    await waitFor(() => expect(updateAccountMock).toHaveBeenCalledTimes(1));
    const [calledId] = updateAccountMock.mock.calls[0];
    // Sanity: real id, not sentinel.
    expect(calledId).toBe(REAL_INSTAPAY_ID);
    expect(String(calledId).includes('unattached')).toBe(false);
  });
});
