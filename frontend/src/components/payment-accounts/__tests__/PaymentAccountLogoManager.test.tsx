/**
 * PaymentAccountLogoManager.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX-5
 *
 * Pins the restored per-account logo/image management UI inside
 * Settings → "حسابات التحصيل":
 *
 *   • renders the section heading "صور وشعارات وسائل الدفع"
 *   • lists existing accounts with their resolved logo (custom logo
 *     wins; safe data URL passes the sink sanitizer; unsafe URL
 *     falls back to the initials avatar)
 *   • "تغيير الصورة" opens the LogoPicker modal
 *   • Saving sends paymentsApi.updateAccount({ metadata: ...prev,
 *     logo_data_url }) — preserving every other metadata key
 *   • "إزالة الصورة" calls updateAccount with metadata stripped of
 *     ONLY logo_data_url, preserving every other key
 *   • The remove button only appears when logo_data_url exists
 *   • Empty state when no accounts
 *
 * The LogoPicker is mocked here so the test focuses on the manager's
 * data flow (file-reading + drag-drop are owned and tested by the
 * picker itself + by PaymentProviderLogo.sanitize.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { paymentsApi, type PaymentAccount, type PaymentProvider } from '@/api/payments.api';
import { PaymentAccountLogoManager } from '../PaymentAccountLogoManager';

// Capture LogoPicker's onChange so tests can simulate an operator
// dropping a file without running FileReader/jsdom plumbing.
let capturedOnChange: ((v: { dataUrl: string | null }) => void) | null = null;
vi.mock('@/components/payments/LogoPicker', () => ({
  LogoPicker: ({ value, onChange }: any) => {
    capturedOnChange = onChange;
    return (
      <div data-testid="logo-picker-mock">
        <span data-testid="logo-picker-current">
          {value?.dataUrl ?? '__none__'}
        </span>
      </div>
    );
  },
}));

vi.mock('@/api/payments.api', async () => {
  const actual = await vi.importActual<typeof import('@/api/payments.api')>(
    '@/api/payments.api',
  );
  return {
    ...actual,
    paymentsApi: {
      ...actual.paymentsApi,
      listAccounts: vi.fn(),
      listProviders: vi.fn(),
      updateAccount: vi.fn(),
    },
  };
});

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const SAFE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

const baseProvider: PaymentProvider = {
  provider_key: 'instapay',
  method: 'instapay',
  name_ar: 'إنستا باي',
  name_en: 'InstaPay',
  icon_name: 'wallet',
  logo_key: 'instapay',
  default_gl_account_code: '1114',
  group: 'instapay',
  requires_reference: true,
};

const cashProvider: PaymentProvider = {
  ...baseProvider,
  provider_key: 'cash-default',
  method: 'cash',
  name_ar: 'كاش',
  name_en: 'Cash',
  group: 'cash',
  default_gl_account_code: '1111',
  logo_key: 'cash',
  requires_reference: false,
};

function makeAccount(overrides: Partial<PaymentAccount> = {}): PaymentAccount {
  return {
    id: 'acc-instapay-1',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'حساب إنستا باي رئيسي',
    identifier: 'shop@instapay',
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: true,
    active: true,
    sort_order: 0,
    metadata: {},
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

function renderManager() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentAccountLogoManager />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnChange = null;
  (paymentsApi.listProviders as any).mockResolvedValue([baseProvider, cashProvider]);
});

describe('PaymentAccountLogoManager — PR-FIN-PAYACCT-4D-UX-FIX-5', () => {
  it('renders the "صور وشعارات وسائل الدفع" section heading', async () => {
    (paymentsApi.listAccounts as any).mockResolvedValue([]);
    renderManager();

    await waitFor(() => {
      expect(screen.getByText('صور وشعارات وسائل الدفع')).toBeInTheDocument();
    });
    expect(screen.getByTestId('payment-accounts-tab-logo-manager')).toBeInTheDocument();
  });

  it('shows the empty-state when there are no payment accounts', async () => {
    (paymentsApi.listAccounts as any).mockResolvedValue([]);
    renderManager();

    await waitFor(() => {
      expect(screen.getByTestId('logo-manager-empty')).toBeInTheDocument();
    });
  });

  it('lists existing payment accounts and renders their logo row', async () => {
    const account = makeAccount();
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    renderManager();

    await waitFor(() => {
      expect(screen.getByTestId(`logo-manager-row-${account.id}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId(`logo-manager-name-${account.id}`).textContent).toBe(
      'حساب إنستا باي رئيسي',
    );
    // edit button always visible
    expect(screen.getByTestId(`logo-manager-edit-${account.id}`)).toBeInTheDocument();
    // remove button hidden when no custom logo
    expect(screen.queryByTestId(`logo-manager-remove-${account.id}`)).toBeNull();
  });

  it('renders the row with a safe data-URL logo via <img> (sanitizer accepts)', async () => {
    const account = makeAccount({
      metadata: { logo_data_url: SAFE_PNG_DATA_URL, custom_note: 'مميز' },
    });
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    renderManager();

    await waitFor(() => {
      expect(screen.getByTestId(`logo-manager-row-${account.id}`)).toBeInTheDocument();
    });
    const row = screen.getByTestId(`logo-manager-row-${account.id}`);
    const img = row.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(SAFE_PNG_DATA_URL);
    // remove button visible because custom logo exists
    expect(screen.getByTestId(`logo-manager-remove-${account.id}`)).toBeInTheDocument();
  });

  it('rejects an unsafe metadata.logo_data_url (https hotlink) — falls back to initials', async () => {
    const account = makeAccount({
      id: 'acc-unsafe',
      display_name: 'حساب ضار',
      metadata: { logo_data_url: 'https://evil.example.com/x.png' },
    });
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    renderManager();

    await waitFor(() => {
      expect(screen.getByTestId(`logo-manager-row-${account.id}`)).toBeInTheDocument();
    });
    const row = screen.getByTestId(`logo-manager-row-${account.id}`);
    // No <img> rendered — sink sanitizer rejected the http URL.
    expect(row.querySelector('img')).toBeNull();
  });

  it('opens the LogoPicker modal when "تغيير الصورة" is clicked', async () => {
    const account = makeAccount();
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    renderManager();

    await waitFor(() =>
      expect(screen.getByTestId(`logo-manager-edit-${account.id}`)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`logo-manager-edit-${account.id}`));

    expect(screen.getByTestId('logo-manager-modal')).toBeInTheDocument();
    expect(screen.getByTestId('logo-picker-mock')).toBeInTheDocument();
    expect(screen.getByTestId('logo-manager-modal-title').textContent).toContain(
      'حساب إنستا باي رئيسي',
    );
  });

  it('saves a new logo with merged metadata (preserves other keys)', async () => {
    const account = makeAccount({
      metadata: { custom_note: 'مميز', sort_hint: 7 },
    });
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    (paymentsApi.updateAccount as any).mockResolvedValue({
      ...account,
      metadata: {
        custom_note: 'مميز',
        sort_hint: 7,
        logo_data_url: SAFE_PNG_DATA_URL,
      },
    });
    renderManager();

    await waitFor(() =>
      expect(screen.getByTestId(`logo-manager-edit-${account.id}`)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`logo-manager-edit-${account.id}`));

    // Save button is disabled until the picker emits a new value.
    const saveBtn = screen.getByTestId('logo-manager-modal-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    expect(capturedOnChange).not.toBeNull();
    act(() => capturedOnChange!({ dataUrl: SAFE_PNG_DATA_URL }));

    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(paymentsApi.updateAccount).toHaveBeenCalledTimes(1);
    });
    expect(paymentsApi.updateAccount).toHaveBeenCalledWith(account.id, {
      metadata: {
        custom_note: 'مميز',
        sort_hint: 7,
        logo_data_url: SAFE_PNG_DATA_URL,
      },
    });
  });

  it('removes only logo_data_url and preserves the rest of metadata', async () => {
    const account = makeAccount({
      metadata: {
        logo_data_url: SAFE_PNG_DATA_URL,
        custom_note: 'مميز',
        sort_hint: 7,
      },
    });
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    (paymentsApi.updateAccount as any).mockResolvedValue({
      ...account,
      metadata: { custom_note: 'مميز', sort_hint: 7 },
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderManager();

    await waitFor(() =>
      expect(screen.getByTestId(`logo-manager-remove-${account.id}`)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`logo-manager-remove-${account.id}`));

    await waitFor(() => {
      expect(paymentsApi.updateAccount).toHaveBeenCalledTimes(1);
    });
    expect(paymentsApi.updateAccount).toHaveBeenCalledWith(account.id, {
      metadata: { custom_note: 'مميز', sort_hint: 7 },
    });

    confirmSpy.mockRestore();
  });

  it('aborts removal when the operator cancels the confirm dialog', async () => {
    const account = makeAccount({
      metadata: { logo_data_url: SAFE_PNG_DATA_URL },
    });
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderManager();

    await waitFor(() =>
      expect(screen.getByTestId(`logo-manager-remove-${account.id}`)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`logo-manager-remove-${account.id}`));

    expect(paymentsApi.updateAccount).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('cancel button closes the modal without calling updateAccount', async () => {
    const account = makeAccount();
    (paymentsApi.listAccounts as any).mockResolvedValue([account]);
    renderManager();

    await waitFor(() =>
      expect(screen.getByTestId(`logo-manager-edit-${account.id}`)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`logo-manager-edit-${account.id}`));
    expect(screen.getByTestId('logo-manager-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('logo-manager-modal-cancel'));
    expect(screen.queryByTestId('logo-manager-modal')).toBeNull();
    expect(paymentsApi.updateAccount).not.toHaveBeenCalled();
  });
});
