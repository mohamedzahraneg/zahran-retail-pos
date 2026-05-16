/**
 * PurchaseProductSearch.test.tsx — PR-PURCHASES-P1
 *
 * Pins the search box behavior:
 *  - Renders search input.
 *  - After debounce + fetch, renders rows with the exact-match badge
 *    on the top exact hit.
 *  - Pressing Enter when results contain exactly one exact match
 *    auto-selects it.
 *  - With zero results, surfaces the quick-add CTA and clicking it
 *    invokes onQuickAdd with the typed query.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PurchaseProductSearch } from '../PurchaseProductSearch';

vi.mock('@/api/purchases.api', () => ({
  purchasesApi: {
    productSearch: vi.fn(),
  },
}));

import { purchasesApi } from '@/api/purchases.api';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const exactRow = {
  product_id: 'p-1',
  sku_root: 'P-001',
  name_ar: 'حذاء جلد',
  name_en: 'Leather Shoe',
  primary_image_url: null,
  base_price: 180,
  variant_id: 'v-1',
  variant_sku: 'SKU-1',
  variant_barcode: '6291234567890',
  variant_image_url: null,
  color: 'أحمر',
  size: '42',
  cost_price: 120,
  selling_price: 180,
  available_stock: 7,
  last_purchase_price: 115,
  last_purchase_at: '2026-04-01',
  last_supplier_name: 'مورد تجريبي',
  last_supplier_id: 'sup-1',
  exact_match: true,
  rank_score: 1,
};

const fuzzyRow = {
  ...exactRow,
  variant_id: 'v-2',
  variant_sku: 'SKU-2',
  variant_barcode: '6299999999999',
  exact_match: false,
  rank_score: 4,
};

describe('PurchaseProductSearch', () => {
  it('renders the search input', () => {
    render(wrap(<PurchaseProductSearch onSelect={() => {}} />));
    expect(
      screen.getByTestId('purchase-product-search-input'),
    ).toBeInTheDocument();
  });

  it('renders result rows after a debounced search and tags the exact match', async () => {
    (purchasesApi.productSearch as any).mockResolvedValue({
      query: '6291234567890',
      results: [exactRow, fuzzyRow],
    });
    render(wrap(<PurchaseProductSearch onSelect={() => {}} />));

    fireEvent.change(screen.getByTestId('purchase-product-search-input'), {
      target: { value: '6291234567890' },
    });

    await waitFor(() =>
      expect(
        screen.getByTestId('purchase-product-row-v-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('purchase-product-exact-badge'),
    ).toBeInTheDocument();
    // Both rows present, only the exact one shows the badge.
    expect(screen.getByTestId('purchase-product-row-v-2')).toBeInTheDocument();
    expect(screen.getAllByTestId('purchase-product-exact-badge')).toHaveLength(
      1,
    );
  });

  it('Enter auto-selects when there is exactly one exact match', async () => {
    (purchasesApi.productSearch as any).mockResolvedValue({
      query: '6291234567890',
      results: [exactRow],
    });
    const onSelect = vi.fn();
    render(wrap(<PurchaseProductSearch onSelect={onSelect} />));

    const input = screen.getByTestId(
      'purchase-product-search-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '6291234567890' } });

    await waitFor(() =>
      expect(
        screen.getByTestId('purchase-product-row-v-1'),
      ).toBeInTheDocument(),
    );

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0].variant_id).toBe('v-1');
  });

  it('shows quick-add CTA on zero results and forwards the query', async () => {
    (purchasesApi.productSearch as any).mockResolvedValue({
      query: 'لا يوجد',
      results: [],
    });
    const onQuickAdd = vi.fn();
    render(
      wrap(
        <PurchaseProductSearch onSelect={() => {}} onQuickAdd={onQuickAdd} />,
      ),
    );

    fireEvent.change(screen.getByTestId('purchase-product-search-input'), {
      target: { value: 'لا يوجد' },
    });

    await waitFor(() =>
      expect(
        screen.getByTestId('purchase-product-search-empty'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('purchase-product-quick-add-btn'));
    expect(onQuickAdd).toHaveBeenCalledWith('لا يوجد');
  });

  it('clicking a row calls onSelect with the variant payload', async () => {
    (purchasesApi.productSearch as any).mockResolvedValue({
      query: 'حذاء',
      results: [fuzzyRow],
    });
    const onSelect = vi.fn();
    render(wrap(<PurchaseProductSearch onSelect={onSelect} />));

    fireEvent.change(screen.getByTestId('purchase-product-search-input'), {
      target: { value: 'حذاء' },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('purchase-product-row-v-2'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('purchase-product-row-v-2'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].variant_id).toBe('v-2');
  });
});
