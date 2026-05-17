/**
 * Settings.pricing-tab.test.tsx — PR-PURCHASES-P3.3
 *
 * Pins the new smart_pricing settings tab:
 *   · renders 7 inputs + 2 checkboxes + 4 preview cards
 *   · live preview reflects edits before save
 *   · save sends a typed PATCH (not a generic key/value upsert)
 *   · invalid recommended vs high margin shows inline Arabic error
 *     and disables save
 *   · 403 surfaces the Arabic permission error
 *   · reset button restores built-in defaults locally
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Settings from '../Settings';

const getSmartPricingMock = vi.fn();
const updateSmartPricingMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: {
    success: (...a: any[]) => toastSuccess(...a),
    error: (...a: any[]) => toastError(...a),
  },
}));

vi.mock('@/api/settings.api', async () => {
  const actual = await vi.importActual<any>('@/api/settings.api');
  return {
    ...actual,
    settingsApi: {
      ...(actual as any).settingsApi,
      getSmartPricing: () => getSmartPricingMock(),
      updateSmartPricing: (body: any) => updateSmartPricingMock(body),
      // The Settings page only touches getSmartPricing/updateSmartPricing
      // when the pricing tab is active. Other tab APIs aren't exercised
      // here, so we stub the few that the page calls on mount.
      getCompany: () => Promise.resolve(null),
      listWarehouses: () => Promise.resolve([]),
      listCashboxes: () => Promise.resolve([]),
      listPaymentMethods: () => Promise.resolve([]),
      listRoles: () => Promise.resolve([]),
      listPermissions: () =>
        Promise.resolve({ groups: {}, all: [] }),
    },
    SMART_PRICING_DEFAULTS: (actual as any).SMART_PRICING_DEFAULTS,
  };
});

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: any) =>
    selector({ user: { id: 'u-1', role: 'admin' } }),
}));

function renderSettings() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openPricingTab() {
  fireEvent.click(screen.getByText('اقتراحات أسعار البيع'));
  await screen.findByTestId('pricing-settings-tab');
}

const DEFAULT_RESPONSE = {
  competitive_markup_pct: 15,
  recommended_margin_pct: 30,
  high_margin_pct: 40,
  wholesale_markup_pct: 10,
  min_margin_pct_default: 15,
  rounding_step: 5,
  rounding_mode: 'nearest',
  show_wholesale_card: true,
  show_high_margin_card: true,
};

beforeEach(() => {
  getSmartPricingMock.mockReset();
  updateSmartPricingMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('PricingSettingsTab — P3.3', () => {
  it('renders all 7 input fields, 2 checkboxes, and the 4 preview cards', async () => {
    getSmartPricingMock.mockResolvedValue(DEFAULT_RESPONSE);
    renderSettings();
    await openPricingTab();
    // 5 percent inputs
    expect(screen.getByTestId('pricing-setting-competitive_markup_pct')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-setting-recommended_margin_pct')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-setting-high_margin_pct')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-setting-wholesale_markup_pct')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-setting-min_margin_pct_default')).toBeInTheDocument();
    // 2 selects
    expect(screen.getByTestId('pricing-setting-rounding_step')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-setting-rounding_mode')).toBeInTheDocument();
    // 2 checkboxes
    expect(screen.getByTestId('pricing-setting-show_wholesale_card')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-setting-show_high_margin_card')).toBeInTheDocument();
    // 4 preview cards
    expect(screen.getByTestId('pricing-settings-preview-competitive')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-settings-preview-recommended')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-settings-preview-high_margin')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-settings-preview-wholesale')).toBeInTheDocument();
  });

  it('live preview updates as the operator changes inputs', async () => {
    getSmartPricingMock.mockResolvedValue(DEFAULT_RESPONSE);
    renderSettings();
    await openPricingTab();
    // Default recommended is 30% → cost 100 → 100/0.7 = 142.86 → round 5 → 145
    expect(
      screen.getByTestId('pricing-settings-preview-recommended'),
    ).toHaveTextContent('145.00 ج.م');
    fireEvent.change(
      screen.getByTestId('pricing-setting-recommended_margin_pct'),
      { target: { value: '50' } },
    );
    // 50% margin → 100/0.5 = 200 exactly.
    await waitFor(() =>
      expect(
        screen.getByTestId('pricing-settings-preview-recommended'),
      ).toHaveTextContent('200.00 ج.م'),
    );
  });

  it('save sends a typed PATCH payload to the new endpoint', async () => {
    getSmartPricingMock.mockResolvedValue(DEFAULT_RESPONSE);
    updateSmartPricingMock.mockResolvedValue({
      ...DEFAULT_RESPONSE,
      competitive_markup_pct: 22,
    });
    renderSettings();
    await openPricingTab();
    fireEvent.change(
      screen.getByTestId('pricing-setting-competitive_markup_pct'),
      { target: { value: '22' } },
    );
    fireEvent.click(screen.getByTestId('pricing-settings-save'));
    await waitFor(() => expect(updateSmartPricingMock).toHaveBeenCalledTimes(1));
    const body = updateSmartPricingMock.mock.calls[0][0];
    expect(body.competitive_markup_pct).toBe(22);
    expect(body.recommended_margin_pct).toBe(30);
    expect(body.rounding_step).toBe(5);
    // Payload is the typed object — NOT a key/value generic Setting upsert.
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('value');
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('invalid recommended >= high margin → inline Arabic error + save disabled', async () => {
    getSmartPricingMock.mockResolvedValue(DEFAULT_RESPONSE);
    renderSettings();
    await openPricingTab();
    fireEvent.change(
      screen.getByTestId('pricing-setting-recommended_margin_pct'),
      { target: { value: '50' } },
    );
    fireEvent.change(
      screen.getByTestId('pricing-setting-high_margin_pct'),
      { target: { value: '45' } },
    );
    const err = await screen.findByTestId(
      'pricing-setting-high_margin_pct-error',
    );
    expect(err).toHaveTextContent(
      'هامش السعر العالي يجب أن يكون أكبر من هامش السعر الموصى به',
    );
    const save = screen.getByTestId('pricing-settings-save') as HTMLButtonElement;
    expect(save).toBeDisabled();
    fireEvent.click(save);
    // disabled click should not call the API
    expect(updateSmartPricingMock).not.toHaveBeenCalled();
  });

  it('403 surfaces the Arabic permission error', async () => {
    getSmartPricingMock.mockResolvedValue(DEFAULT_RESPONSE);
    updateSmartPricingMock.mockRejectedValue({
      response: { status: 403, data: {} },
    });
    renderSettings();
    await openPricingTab();
    fireEvent.change(
      screen.getByTestId('pricing-setting-competitive_markup_pct'),
      { target: { value: '22' } },
    );
    fireEvent.click(screen.getByTestId('pricing-settings-save'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toBe(
      'ليس لديك صلاحية تعديل هذه الإعدادات.',
    );
  });

  it('reset restores defaults locally without calling the API', async () => {
    getSmartPricingMock.mockResolvedValue({
      ...DEFAULT_RESPONSE,
      competitive_markup_pct: 88,
    });
    renderSettings();
    await openPricingTab();
    const inp = screen.getByTestId(
      'pricing-setting-competitive_markup_pct',
    ) as HTMLInputElement;
    expect(Number(inp.value)).toBe(88);
    fireEvent.click(screen.getByTestId('pricing-settings-reset'));
    await waitFor(() => expect(Number(inp.value)).toBe(15));
    expect(updateSmartPricingMock).not.toHaveBeenCalled();
  });
});
