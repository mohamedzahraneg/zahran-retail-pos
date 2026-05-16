/**
 * QuickAddProductModal.test.tsx — PR-PURCHASES-P1
 *
 * Pins:
 *  - Renders required fields with the seeded barcode/sku.
 *  - On save: calls products.create THEN products.addVariant and
 *    fires onCreated with the resulting pair.
 *  - On 409/duplicate error, surfaces the Arabic duplicate hint
 *    inline (no toast).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickAddProductModal } from '../QuickAddProductModal';

vi.mock('@/api/products.api', () => ({
  productsApi: {
    create: vi.fn(),
    addVariant: vi.fn(),
    byBarcode: vi.fn().mockRejectedValue(new Error('not found')),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
  __esModule: true,
}));

import { productsApi } from '@/api/products.api';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('QuickAddProductModal', () => {
  it('renders the form with the seeded barcode populated', () => {
    render(
      wrap(
        <QuickAddProductModal
          initialQuery="6291234567890"
          onClose={() => {}}
          onCreated={() => {}}
        />,
      ),
    );
    const barcode = screen.getByTestId('quick-add-barcode') as HTMLInputElement;
    expect(barcode.value).toBe('6291234567890');
  });

  it('on save, calls products.create then products.addVariant and fires onCreated', async () => {
    (productsApi.create as any).mockResolvedValueOnce({
      id: 'p-1',
      sku_root: 'P-001',
      name_ar: 'منتج جديد',
      type: 'shoe',
      base_price: 180,
      cost_price: 120,
    });
    (productsApi.addVariant as any).mockResolvedValueOnce({
      id: 'v-1',
      product_id: 'p-1',
      sku: 'SKU-NEW',
      barcode: '6291234567890',
      cost_price: 120,
      selling_price: 180,
    });

    const onCreated = vi.fn();
    render(
      wrap(
        <QuickAddProductModal
          initialQuery="6291234567890"
          onClose={() => {}}
          onCreated={onCreated}
        />,
      ),
    );

    fireEvent.change(screen.getByTestId('quick-add-name-ar'), {
      target: { value: 'منتج جديد' },
    });
    fireEvent.change(screen.getByTestId('quick-add-cost-price'), {
      target: { value: '120' },
    });

    fireEvent.click(screen.getByTestId('quick-add-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(productsApi.create).toHaveBeenCalledTimes(1);
    expect(productsApi.addVariant).toHaveBeenCalledTimes(1);
    expect(onCreated.mock.calls[0][0].product.id).toBe('p-1');
    expect(onCreated.mock.calls[0][0].variant.id).toBe('v-1');
  });

  it('surfaces the duplicate hint on 409 instead of toasting an error', async () => {
    (productsApi.create as any).mockRejectedValueOnce({
      response: { status: 409, data: { message: 'duplicate code' } },
    });

    render(
      wrap(
        <QuickAddProductModal
          onClose={() => {}}
          onCreated={() => {}}
        />,
      ),
    );

    fireEvent.change(screen.getByTestId('quick-add-name-ar'), {
      target: { value: 'منتج مكرر' },
    });
    fireEvent.click(screen.getByTestId('quick-add-submit'));

    await waitFor(() =>
      expect(
        screen.getByTestId('quick-add-duplicate-hint'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('quick-add-duplicate-hint')).toHaveTextContent(
      /موجود/,
    );
  });
});
