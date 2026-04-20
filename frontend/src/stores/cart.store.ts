import { create } from 'zustand';
import { Product, Variant } from '@/api/products.api';
import { Customer } from '@/api/customers.api';

export interface CartItem {
  variantId: string;
  productId: string;
  sku: string;
  productCode: string;
  name: string;
  color: string | null;
  size: string | null;
  qty: number;
  unitPrice: number;
  costPrice: number;
  discount: number;
  notes: string;
  image?: string;
  /** Cashier overrode the price manually — group-pricing resolver
   *  must not reset it. */
  priceLocked?: boolean;
}

export type ManualDiscountType = 'percent' | 'value';

export interface PaymentDraft {
  method: 'cash' | 'card' | 'instapay' | 'bank_transfer';
  amount: number;
  reference?: string;
}

export interface AppliedCoupon {
  coupon_id: string;
  code: string;
  name_ar: string;
  discount_amount: number;
}

export interface AppliedLoyalty {
  points: number;
  egp_discount: number;
}

export interface SalespersonInfo {
  id: string;
  full_name: string;
}

export interface WarehouseInfo {
  id: string;
  code: string;
  name_ar: string;
}

interface CartState {
  items: CartItem[];
  customer: Customer | null;
  salesperson: SalespersonInfo | null;
  warehouse: WarehouseInfo | null;
  /** Manual discount settings (independent of coupon/loyalty). */
  manualDiscountType: ManualDiscountType;
  manualDiscountInput: number;
  payments: PaymentDraft[];
  notes: string;
  coupon: AppliedCoupon | null;
  loyalty: AppliedLoyalty | null;

  addItem: (input: { product: Product; variant: Variant; qty?: number }) => void;
  updateQty: (variantId: string, qty: number) => void;
  /** Manually override the unit price for a line — cashier-only edit. */
  updateUnitPrice: (variantId: string, unitPrice: number) => void;
  removeItem: (variantId: string) => void;
  setItemNotes: (variantId: string, notes: string) => void;
  setManualDiscount: (type: ManualDiscountType, value: number) => void;
  clearManualDiscount: () => void;
  setCustomer: (c: Customer | null) => void;
  setSalesperson: (s: SalespersonInfo | null) => void;
  setWarehouse: (w: WarehouseInfo | null) => void;
  setPayments: (p: PaymentDraft[]) => void;
  setNotes: (n: string) => void;
  setCoupon: (c: AppliedCoupon | null) => void;
  setLoyalty: (l: AppliedLoyalty | null) => void;
  /** Re-price items using a `variant_id -> price` map from the group-pricing resolver. */
  applyGroupPrices: (prices: Record<string, number>) => void;
  clear: () => void;

  subtotal: () => number;
  manualDiscountAmount: () => number;
  discountTotal: () => number;
  grandTotal: () => number;
  totalPaid: () => number;
  change: () => number;
  totalCost: () => number;
  profit: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  customer: null,
  salesperson: null,
  warehouse: null,
  manualDiscountType: 'value',
  manualDiscountInput: 0,
  payments: [],
  notes: '',
  coupon: null,
  loyalty: null,

  addItem: ({ product, variant, qty = 1 }) =>
    set((state) => {
      const existing = state.items.find((i) => i.variantId === variant.id);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.variantId === variant.id ? { ...i, qty: i.qty + qty } : i,
          ),
        };
      }
      return {
        items: [
          ...state.items,
          {
            variantId: variant.id,
            productId: product.id,
            sku: variant.sku || '',
            productCode: product.sku_root || variant.sku || '',
            name: product.name_ar,
            color: variant.color ?? null,
            size: variant.size ?? null,
            qty,
            unitPrice: Number(
              variant.selling_price ??
                variant.price_override ??
                product.base_price ??
                0,
            ),
            costPrice: Number(variant.cost_price ?? product.cost_price ?? 0),
            discount: 0,
            notes: '',
          },
        ],
      };
    }),

  updateQty: (variantId, qty) =>
    set((state) => ({
      items:
        qty <= 0
          ? state.items.filter((i) => i.variantId !== variantId)
          : state.items.map((i) => (i.variantId === variantId ? { ...i, qty } : i)),
    })),

  updateUnitPrice: (variantId, unitPrice) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.variantId === variantId
          ? {
              ...i,
              unitPrice: Math.max(0, Number(unitPrice) || 0),
              // Lock this line from being overwritten by later group-price
              // resolves or item re-adds — cashier set the price manually.
              priceLocked: true,
            }
          : i,
      ),
    })),

  removeItem: (variantId) =>
    set((state) => ({
      items: state.items.filter((i) => i.variantId !== variantId),
    })),

  setItemNotes: (variantId, notes) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.variantId === variantId ? { ...i, notes } : i,
      ),
    })),

  setManualDiscount: (type, value) =>
    set({
      manualDiscountType: type,
      manualDiscountInput: Math.max(0, value),
    }),

  clearManualDiscount: () =>
    set({ manualDiscountType: 'value', manualDiscountInput: 0 }),

  setCustomer: (c) => set({ customer: c }),
  setSalesperson: (s) => set({ salesperson: s }),
  setWarehouse: (w) => set({ warehouse: w }),
  setPayments: (p) => set({ payments: p }),
  setNotes: (n) => set({ notes: n }),
  setCoupon: (c) => set({ coupon: c }),
  setLoyalty: (l) => set({ loyalty: l }),

  applyGroupPrices: (prices) =>
    set((state) => ({
      items: state.items.map((i) =>
        prices[i.variantId] !== undefined &&
        prices[i.variantId] !== null &&
        !i.priceLocked
          ? { ...i, unitPrice: Number(prices[i.variantId]) }
          : i,
      ),
    })),

  clear: () =>
    set((state) => ({
      items: [],
      customer: null,
      salesperson: null,
      // keep warehouse selection across transactions (cashier works one branch)
      warehouse: state.warehouse,
      manualDiscountType: 'value',
      manualDiscountInput: 0,
      payments: [],
      notes: '',
      coupon: null,
      loyalty: null,
    })),

  subtotal: () =>
    get().items.reduce(
      (s, i) => s + i.qty * i.unitPrice - (i.discount || 0),
      0,
    ),

  manualDiscountAmount: () => {
    const s = get();
    if (s.manualDiscountInput <= 0) return 0;
    if (s.manualDiscountType === 'percent') {
      const pct = Math.min(100, Math.max(0, s.manualDiscountInput));
      return Math.round(((s.subtotal() * pct) / 100) * 100) / 100;
    }
    return Math.min(s.subtotal(), s.manualDiscountInput);
  },

  discountTotal: () => {
    const s = get();
    return (
      s.manualDiscountAmount() +
      (s.coupon ? Number(s.coupon.discount_amount) : 0) +
      (s.loyalty ? Number(s.loyalty.egp_discount) : 0)
    );
  },

  grandTotal: () => Math.max(0, get().subtotal() - get().discountTotal()),

  totalPaid: () => get().payments.reduce((s, p) => s + p.amount, 0),

  change: () => Math.max(0, get().totalPaid() - get().grandTotal()),

  totalCost: () =>
    get().items.reduce((s, i) => s + i.qty * (i.costPrice || 0), 0),

  profit: () => get().grandTotal() - get().totalCost(),
}));
