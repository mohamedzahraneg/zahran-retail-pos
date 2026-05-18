/**
 * CostAdjustmentAssistantModal.group-filter.test.tsx — PR-P9.1b
 *
 * Same shape as the smart-pricing group-filter test: the in-modal
 * dropdown injects group_id into the preview payload (and through
 * to apply only when the operator confirms the existing flow).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CostAdjustmentAssistantModal } from '../CostAdjustmentAssistantModal';

const costPreviewMock = vi.fn();
const costApplyMock = vi.fn();
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
      costAdjustmentPreview: (b: any) => costPreviewMock(b),
      costAdjustmentApply: (b: any) => costApplyMock(b),
    },
  };
});

const GROUPS = [
  { id: 'g1', name_ar: 'مجموعة الصيف', is_active: true, name_en: null, description: null, color: null, created_at: '', updated_at: '', member_count: 0 },
  { id: 'g2', name_ar: 'مجموعة الشتاء', is_active: true, name_en: null, description: null, color: null, created_at: '', updated_at: '', member_count: 0 },
];

beforeEach(() => {
  costPreviewMock.mockReset();
  costApplyMock.mockReset();
  productGroupsListMock.mockReset();
  productGroupsListMock.mockResolvedValue(GROUPS);
  costPreviewMock.mockResolvedValue({
    items: [],
    summary: {
      total_candidates: 0,
      returned_count: 0,
      truncated: false,
      avg_delta_pct: null,
      total_inventory_value_before: 0,
      total_inventory_value_after_reference_only: 0,
      message_ar: null,
    },
  });
});

function renderModal(filters: Record<string, any> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CostAdjustmentAssistantModal
        open
        context={{ selectedVariantIds: [], filters }}
        onClose={() => undefined}
        onApplied={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('CostAdjustmentAssistantModal — P9.1b group filter', () => {
  it('1. dropdown renders for filtered scope and lists the groups', async () => {
    renderModal({ q: 'foo' });
    const dd = await screen.findByTestId('cost-adjust-group-filter');
    await waitFor(() => {
      const opts = (dd as HTMLSelectElement).querySelectorAll('option');
      expect(opts.length).toBe(3);
    });
  });

  it('2. selecting a group threads group_id into preview only after operator runs preview', async () => {
    renderModal({ q: 'foo' });
    const dd = (await screen.findByTestId(
      'cost-adjust-group-filter',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(dd.querySelectorAll('option').length).toBe(3);
    });
    fireEvent.change(dd, { target: { value: 'g2' } });
    expect(costPreviewMock).not.toHaveBeenCalled();
    expect(costApplyMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('cost-adjust-value'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByTestId('cost-adjust-run-preview'));
    await waitFor(() => expect(costPreviewMock).toHaveBeenCalled());
    const body = costPreviewMock.mock.calls.at(-1)![0];
    expect(body.scope).toBe('filtered');
    expect(body.filters.group_id).toBe('g2');
    expect(body.filters.q).toBe('foo');
    expect(costApplyMock).not.toHaveBeenCalled();
  });

  it('3. clearing the dropdown removes group_id from the payload', async () => {
    renderModal({ q: 'foo', group_id: 'g1' });
    const dd = (await screen.findByTestId(
      'cost-adjust-group-filter',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(dd.querySelectorAll('option').length).toBe(3);
    });
    expect(dd.value).toBe('g1');
    fireEvent.change(dd, { target: { value: '' } });
    fireEvent.change(screen.getByTestId('cost-adjust-value'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByTestId('cost-adjust-run-preview'));
    await waitFor(() => expect(costPreviewMock).toHaveBeenCalled());
    const body = costPreviewMock.mock.calls.at(-1)![0];
    expect(body.filters.group_id).toBeUndefined();
    expect(body.filters.q).toBe('foo');
  });
});
