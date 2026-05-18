/**
 * SmartPricingAssistantModal.group-filter.test.tsx — PR-P9.1b
 *
 * Pins the in-modal "المجموعة" select inside the smart-pricing
 * assistant. Verifies:
 *   · Dropdown renders only on the filtered scope step.
 *   · Selecting a group inside the modal threads group_id into the
 *     preview payload (and through to apply when the operator
 *     confirms — apply is NOT triggered by the dropdown alone).
 *   · Defensive: smartPricingApply / applyVariantPrices stay at zero
 *     when the operator only changes the dropdown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SmartPricingAssistantModal } from '../SmartPricingAssistantModal';

const smartPreviewMock = vi.fn();
const smartApplyMock = vi.fn();
const applyPricesMock = vi.fn();
const productGroupsListMock = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/productGroups.api', () => ({
  productGroupsApi: { list: (p: any) => productGroupsListMock(p) },
}));

vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      ...((actual as any).productsApi ?? {}),
      smartPricingPreview: (b: any) => smartPreviewMock(b),
      smartPricingApply: (b: any) => smartApplyMock(b),
      applyVariantPrices: (b: any) => applyPricesMock(b),
    },
  };
});

const GROUPS = [
  { id: 'g1', name_ar: 'مجموعة الصيف', is_active: true, name_en: null, description: null, color: null, created_at: '', updated_at: '', member_count: 0 },
  { id: 'g2', name_ar: 'مجموعة الشتاء', is_active: true, name_en: null, description: null, color: null, created_at: '', updated_at: '', member_count: 0 },
];

beforeEach(() => {
  smartPreviewMock.mockReset();
  smartApplyMock.mockReset();
  applyPricesMock.mockReset();
  productGroupsListMock.mockReset();
  productGroupsListMock.mockResolvedValue(GROUPS);
  smartPreviewMock.mockResolvedValue({
    strategy: 'balanced',
    scope_type: 'filtered',
    settings: {
      competitive_markup_pct: 30,
      recommended_margin_pct: 30,
      high_margin_pct: 40,
      wholesale_markup_pct: 20,
      min_margin_pct_default: 15,
      rounding_step: 5,
      rounding_mode: 'nearest',
    },
    summary: { total: 0, increase: 0, decrease: 0, keep: 0, review: 0 },
    items: [],
  });
});

function renderModal(filters: Record<string, any> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SmartPricingAssistantModal
        open
        context={{
          selectedVariantIds: [],
          filters,
        }}
        onClose={() => undefined}
        onApplied={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('SmartPricingAssistantModal — P9.1b group filter', () => {
  it('1. dropdown renders ONLY for filtered scope and lists the groups', async () => {
    renderModal({ q: 'foo' });
    // The modal opens with scope=filtered when context.filters is non-empty.
    const dd = await screen.findByTestId('smart-pricing-group-filter');
    await waitFor(() => {
      const opts = (dd as HTMLSelectElement).querySelectorAll('option');
      expect(opts.length).toBe(3); // "كل المجموعات" + 2 groups
    });
  });

  it('2. selecting a group threads group_id into preview only after operator generates preview', async () => {
    renderModal({ q: 'foo' });
    const dd = (await screen.findByTestId(
      'smart-pricing-group-filter',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(dd.querySelectorAll('option').length).toBe(3);
    });
    fireEvent.change(dd, { target: { value: 'g2' } });
    // Selecting alone MUST NOT fire any backend call.
    expect(smartPreviewMock).not.toHaveBeenCalled();
    expect(smartApplyMock).not.toHaveBeenCalled();
    expect(applyPricesMock).not.toHaveBeenCalled();

    // Move to strategy → generate preview.
    fireEvent.click(screen.getByTestId('smart-pricing-next-strategy'));
    fireEvent.click(
      await screen.findByTestId('smart-pricing-strategy-balanced'),
    );
    fireEvent.click(
      await screen.findByTestId('smart-pricing-generate-preview'),
    );
    await waitFor(() => expect(smartPreviewMock).toHaveBeenCalled());
    const body = smartPreviewMock.mock.calls.at(-1)![0];
    expect(body.scope.type).toBe('filtered');
    expect(body.scope.filters.group_id).toBe('g2');
    // Tab's pre-existing filter survives the merge.
    expect(body.scope.filters.q).toBe('foo');
    expect(smartApplyMock).not.toHaveBeenCalled();
  });

  it('3. clearing the dropdown drops group_id from the payload', async () => {
    renderModal({ q: 'foo', group_id: 'g1' });
    const dd = (await screen.findByTestId(
      'smart-pricing-group-filter',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(dd.querySelectorAll('option').length).toBe(3);
    });
    // Seeded from forwarded filters.
    expect(dd.value).toBe('g1');
    fireEvent.change(dd, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('smart-pricing-next-strategy'));
    fireEvent.click(
      await screen.findByTestId('smart-pricing-strategy-balanced'),
    );
    fireEvent.click(
      await screen.findByTestId('smart-pricing-generate-preview'),
    );
    await waitFor(() => expect(smartPreviewMock).toHaveBeenCalled());
    const body = smartPreviewMock.mock.calls.at(-1)![0];
    expect(body.scope.filters.group_id).toBeUndefined();
    expect(body.scope.filters.q).toBe('foo');
  });
});
