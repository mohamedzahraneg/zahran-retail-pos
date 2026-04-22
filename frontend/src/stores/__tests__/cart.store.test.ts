import { beforeEach, describe, expect, it } from 'vitest';
import { useCartStore } from '../cart.store';
import type { Product, Variant } from '@/api/products.api';

/**
 * Unit tests for the POS cart store — the heart of the checkout UX.
 *
 * We intentionally avoid mocking anything; the store is a pure Zustand
 * store so we just drive it through its public API and assert the
 * derived selectors.
 */

const makeProduct = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p1',
    sku: 'SKU-1',
    name_ar: 'حذاء جلد أسود',
    name_en: 'Black Leather Shoe',
    base_price: 500,
    is_active: true,
    ...over,
  } as unknown as Product);

const makeVariant = (over: Partial<Variant> = {}): Variant =>
  ({
    id: 'v1',
    product_id: 'p1',
    sku: 'SKU-1-38',
    price_override: null,
    cost_price: 200,
    is_active: true,
    ...over,
  } as unknown as Variant);

const resetStore = () => {
  useCartStore.getState().clear();
};

describe('cart.store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('starts with an empty cart', () => {
    const s = useCartStore.getState();
    expect(s.items).toEqual([]);
    expect(s.subtotal()).toBe(0);
    expect(s.grandTotal()).toBe(0);
    expect(s.totalPaid()).toBe(0);
    expect(s.change()).toBe(0);
  });

  it('addItem inserts a fresh line with the product price', () => {
    const product = makeProduct({ base_price: 750 });
    const variant = makeVariant({ id: 'v-fresh' });

    useCartStore.getState().addItem({ product, variant });

    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      variantId: 'v-fresh',
      productId: 'p1',
      qty: 1,
      unitPrice: 750,
      discount: 0,
    });
  });

  it('addItem increments qty when the same variant is added twice', () => {
    const product = makeProduct();
    const variant = makeVariant({ id: 'v-dup' });

    useCartStore.getState().addItem({ product, variant, qty: 2 });
    useCartStore.getState().addItem({ product, variant, qty: 3 });

    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(5);
  });

  it('addItem prefers variant.price_override when present', () => {
    const product = makeProduct({ base_price: 500 });
    const variant = makeVariant({ id: 'v-over', price_override: 299 });

    useCartStore.getState().addItem({ product, variant });

    expect(useCartStore.getState().items[0].unitPrice).toBe(299);
  });

  it('updateQty with qty<=0 removes the line', () => {
    const { addItem, updateQty } = useCartStore.getState();
    addItem({ product: makeProduct(), variant: makeVariant({ id: 'v-a' }) });
    addItem({ product: makeProduct(), variant: makeVariant({ id: 'v-b' }) });

    updateQty('v-a', 0);

    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].variantId).toBe('v-b');
  });

  it('updateQty with qty>0 updates that line only', () => {
    const { addItem, updateQty } = useCartStore.getState();
    addItem({ product: makeProduct(), variant: makeVariant({ id: 'v-a' }) });
    addItem({ product: makeProduct(), variant: makeVariant({ id: 'v-b' }) });

    updateQty('v-b', 7);

    const items = useCartStore.getState().items;
    expect(items.find((i) => i.variantId === 'v-a')!.qty).toBe(1);
    expect(items.find((i) => i.variantId === 'v-b')!.qty).toBe(7);
  });

  it('removeItem drops the matching line', () => {
    const { addItem, removeItem } = useCartStore.getState();
    addItem({ product: makeProduct(), variant: makeVariant({ id: 'v-a' }) });
    addItem({ product: makeProduct(), variant: makeVariant({ id: 'v-b' }) });

    removeItem('v-a');

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0].variantId).toBe('v-b');
  });

  it('subtotal is sum of qty*unitPrice minus per-line discount', () => {
    const { addItem } = useCartStore.getState();
    addItem({
      product: makeProduct({ base_price: 100 }),
      variant: makeVariant({ id: 'v-a' }),
      qty: 2,
    });
    addItem({
      product: makeProduct({ base_price: 50 }),
      variant: makeVariant({ id: 'v-b' }),
      qty: 3,
    });

    // 2*100 + 3*50 = 350
    expect(useCartStore.getState().subtotal()).toBe(350);
  });

  it('setManualDiscount (value) clamps negative to zero', () => {
    useCartStore.getState().setManualDiscount('value', -50);
    expect(useCartStore.getState().manualDiscountInput).toBe(0);

    useCartStore.getState().setManualDiscount('value', 25);
    expect(useCartStore.getState().manualDiscountInput).toBe(25);
    // Sanity-check the computed amount, but only when the cart has
    // enough subtotal to not clamp it. `manualDiscountAmount` does
    // `Math.min(subtotal, input)` — on an empty cart it reports 0,
    // which is the correct behaviour (you can't discount nothing).
    useCartStore.getState().addItem({
      product: makeProduct({ base_price: 100 }),
      variant: makeVariant({ id: 'v-for-discount' }),
      qty: 1,
    });
    expect(useCartStore.getState().manualDiscountAmount()).toBe(25);
  });

  it('grandTotal subtracts manual discount and clamps at zero', () => {
    const { addItem, setManualDiscount } = useCartStore.getState();
    addItem({
      product: makeProduct({ base_price: 100 }),
      variant: makeVariant({ id: 'v-a' }),
      qty: 2,
    });
    setManualDiscount('value', 50);
    expect(useCartStore.getState().grandTotal()).toBe(150);

    // Value > subtotal is capped at subtotal → grandTotal 0
    setManualDiscount('value', 500);
    expect(useCartStore.getState().grandTotal()).toBe(0);
  });

  it('setCoupon adds to discountTotal and clearing coupon removes it', () => {
    const { setCoupon } = useCartStore.getState();
    setCoupon({
      coupon_id: 'c1',
      code: 'WELCOME',
      name_ar: 'كوبون ترحيبي',
      discount_amount: 30,
    });
    expect(useCartStore.getState().discountTotal()).toBe(30);
    expect(useCartStore.getState().coupon?.code).toBe('WELCOME');

    setCoupon(null);
    expect(useCartStore.getState().discountTotal()).toBe(0);
    expect(useCartStore.getState().coupon).toBeNull();
  });

  it('totalPaid sums payments and change is paid minus grandTotal', () => {
    const { addItem, setPayments } = useCartStore.getState();
    addItem({
      product: makeProduct({ base_price: 100 }),
      variant: makeVariant({ id: 'v-a' }),
      qty: 2,
    });

    setPayments([
      { method: 'cash', amount: 150 },
      { method: 'card', amount: 100 },
    ]);

    expect(useCartStore.getState().totalPaid()).toBe(250);
    // grandTotal = 200 → change = 50
    expect(useCartStore.getState().change()).toBe(50);
  });

  it('change never goes negative when underpaid', () => {
    const { addItem, setPayments } = useCartStore.getState();
    addItem({
      product: makeProduct({ base_price: 100 }),
      variant: makeVariant({ id: 'v-a' }),
      qty: 2,
    });
    setPayments([{ method: 'cash', amount: 50 }]);

    expect(useCartStore.getState().change()).toBe(0);
  });

  it('clear() resets everything, including coupon and payments', () => {
    const { addItem, setPayments, setCoupon, setNotes, clear } =
      useCartStore.getState();
    addItem({
      product: makeProduct(),
      variant: makeVariant({ id: 'v-a' }),
      qty: 1,
    });
    setPayments([{ method: 'cash', amount: 10 }]);
    setCoupon({
      coupon_id: 'c1',
      code: 'X',
      name_ar: 'x',
      discount_amount: 5,
    });
    setNotes('ملاحظات');

    clear();

    const s = useCartStore.getState();
    expect(s.items).toEqual([]);
    expect(s.payments).toEqual([]);
    expect(s.coupon).toBeNull();
    expect(s.discountTotal()).toBe(0);
    expect(s.notes).toBe('');
    expect(s.customer).toBeNull();
  });
});
