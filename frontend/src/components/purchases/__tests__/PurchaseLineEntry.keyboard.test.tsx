/**
 * PurchaseLineEntry.keyboard.test.tsx — Purchases UX fixes
 *
 * Pins the Enter-key flow inside the per-row entry:
 *
 *   1. On mount the quantity input is auto-focused (the search just
 *      cleared and we landed here).
 *   2. Enter on quantity → focus the price input.
 *   3. Enter on price → fires onConfirm (parent re-renders the search,
 *      so refocus there is the parent's responsibility).
 *   4. Enter never bubbles into a surrounding `<form onSubmit>`.
 *   5. Same flow in carton mode: cartons → carton_cost → onConfirm.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PurchaseLineEntry } from '../PurchaseLineEntry';

const row: any = {
  product_id: 'p-1',
  sku_root: 'P-001',
  name_ar: 'حذاء جلد',
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

describe('PurchaseLineEntry — Enter keyboard flow', () => {
  it('K1. quantity input is focused on mount', async () => {
    render(
      <PurchaseLineEntry
        row={row}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('purchase-line-piece-qty')).toBe(
        document.activeElement,
      ),
    );
  });

  it('K2. Enter on quantity focuses the price input', async () => {
    render(
      <PurchaseLineEntry
        row={row}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const qty = screen.getByTestId('purchase-line-piece-qty');
    fireEvent.keyDown(qty, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('purchase-line-piece-cost')).toBe(
        document.activeElement,
      ),
    );
  });

  it('K3. Enter on price fires onConfirm with a piece-level payload', async () => {
    const onConfirm = vi.fn();
    render(
      <PurchaseLineEntry
        row={row}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const price = screen.getByTestId('purchase-line-piece-cost');
    fireEvent.keyDown(price, { key: 'Enter' });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const payload = onConfirm.mock.calls[0][0];
    expect(payload.variant_id).toBe('v-1');
    expect(payload.quantity).toBe(1);
    expect(payload.unit_cost).toBe(115);
  });

  it('K4. Enter on price does NOT submit a surrounding form', async () => {
    const onFormSubmit = vi.fn();
    render(
      <form onSubmit={onFormSubmit}>
        <PurchaseLineEntry
          row={row}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
        <button type="submit">Save</button>
      </form>,
    );
    fireEvent.keyDown(screen.getByTestId('purchase-line-piece-cost'), {
      key: 'Enter',
    });
    expect(onFormSubmit).not.toHaveBeenCalled();
  });

  it('K5. Switching to carton mode wires cartons → carton_cost → onConfirm', async () => {
    const onConfirm = vi.fn();
    render(
      <PurchaseLineEntry
        row={row}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('purchase-line-mode-carton'));
    const cartons = await screen.findByTestId('purchase-line-cartons');
    await waitFor(() => expect(cartons).toBe(document.activeElement));
    fireEvent.keyDown(cartons, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('purchase-line-carton-cost')).toBe(
        document.activeElement,
      ),
    );
    fireEvent.keyDown(screen.getByTestId('purchase-line-carton-cost'), {
      key: 'Enter',
    });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0].variant_id).toBe('v-1');
  });
});
