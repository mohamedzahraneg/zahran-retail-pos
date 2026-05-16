/**
 * QuickAddProductModal — PR-PURCHASES-P1
 *
 * Inline modal launched from the purchase-invoice product search when
 * the operator types a new code and gets no results. Creates a fresh
 * product + a first variant in two backend calls and returns the
 * resulting variant via `onCreated` so the parent (CreatePurchaseModal)
 * can drop it straight onto the current line without navigating away.
 *
 * Required: name_ar, type. Plus at least one identity field — the
 * caller seeds either a barcode or a free-text SKU.
 *
 * Duplicate prevention: the backend already enforces unique constraints
 * on products.sku_root, variants.sku, and variants.barcode. If a 409 /
 * duplicate error bubbles up, the modal surfaces an inline warning
 * "قد يكون هذا المنتج موجودًا بالفعل" and keeps the form filled so
 * the operator can adjust without losing input.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Plus, XCircle, Loader2 } from 'lucide-react';
import {
  productsApi,
  type Product,
  type Variant,
} from '@/api/products.api';

export interface QuickAddProductResult {
  product: Product;
  variant: Variant;
}

export interface QuickAddProductModalProps {
  /** Optional seed pulled from the search box (treated as barcode if
   *  numeric / unknown, or as a free-text SKU hint).  Always editable. */
  initialQuery?: string;
  onClose: () => void;
  onCreated: (result: QuickAddProductResult) => void;
}

const TYPE_LABELS: Array<{ value: 'shoe' | 'bag' | 'accessory'; label: string }> = [
  { value: 'shoe', label: 'حذاء' },
  { value: 'bag', label: 'حقيبة' },
  { value: 'accessory', label: 'إكسسوار' },
];

export function QuickAddProductModal({
  initialQuery,
  onClose,
  onCreated,
}: QuickAddProductModalProps) {
  const seedLooksLikeBarcode = /^[0-9]{6,}$/.test((initialQuery || '').trim());
  const [form, setForm] = useState({
    name_ar: '',
    name_en: '',
    type: 'shoe' as 'shoe' | 'bag' | 'accessory',
    sku_root: seedLooksLikeBarcode ? '' : (initialQuery || '').trim(),
    barcode: seedLooksLikeBarcode ? (initialQuery || '').trim() : '',
    color: '',
    size: '',
    base_price: 0,
    cost_price: 0,
    selling_price: 0,
  });
  const [duplicateHint, setDuplicateHint] = useState<string | null>(null);

  // Live "looks-like duplicate" check on barcode — best-effort, runs
  // 250ms after the operator stops typing.  Backed by the same
  // /products/barcode/:code lookup used by POS.
  const [barcodeDebounced, setBarcodeDebounced] = useState('');
  useEffect(() => {
    const v = form.barcode.trim();
    if (v.length < 4) {
      setBarcodeDebounced('');
      return;
    }
    const t = setTimeout(() => setBarcodeDebounced(v), 250);
    return () => clearTimeout(t);
  }, [form.barcode]);

  const dupCheck = useQuery({
    queryKey: ['quickadd-barcode-dup', barcodeDebounced],
    queryFn: async () => {
      try {
        return await productsApi.byBarcode(barcodeDebounced);
      } catch {
        return null;
      }
    },
    enabled: barcodeDebounced.length >= 4,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (dupCheck.data && (dupCheck.data as any).variant) {
      setDuplicateHint(
        `قد يكون هذا المنتج موجودًا بالفعل: ${(dupCheck.data as any).product?.name_ar ?? ''}`,
      );
    } else {
      setDuplicateHint(null);
    }
  }, [dupCheck.data]);

  const createMut = useMutation({
    mutationFn: async (): Promise<QuickAddProductResult> => {
      const product = await productsApi.create({
        name_ar: form.name_ar.trim(),
        name_en: form.name_en.trim() || undefined,
        type: form.type,
        sku_root: form.sku_root.trim() || undefined,
        base_price: Number(form.base_price) || 0,
        cost_price: Number(form.cost_price) || 0,
      });
      const variant = await productsApi.addVariant({
        product_id: product.id,
        sku: '' as any, // backend auto-generates when blank
        barcode: form.barcode.trim() || undefined,
        color: form.color.trim() || undefined,
        size: form.size.trim() || undefined,
        cost_price: Number(form.cost_price) || 0,
        selling_price:
          Number(form.selling_price) || Number(form.base_price) || 0,
      });
      return { product, variant };
    },
    onSuccess: (result) => {
      toast.success('تم إنشاء المنتج وإضافته إلى الفاتورة');
      onCreated(result);
    },
    onError: (err: any) => {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message || err?.message || '';
      if (
        status === 409 ||
        /duplicate|unique|already exists|موجود/i.test(String(msg))
      ) {
        setDuplicateHint('قد يكون هذا المنتج موجودًا بالفعل');
      } else {
        toast.error(msg || 'فشل إنشاء المنتج');
      }
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name_ar.trim()) {
      toast.error('اسم المنتج مطلوب');
      return;
    }
    createMut.mutate();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="quick-add-product-modal">
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-xl space-y-3 max-h-[95vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black flex items-center gap-2">
            <Plus className="w-5 h-5 text-brand-500" />
            إضافة منتج سريع
          </h2>
          <button type="button" onClick={onClose} className="icon-btn">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        {duplicateHint ? (
          <div
            data-testid="quick-add-duplicate-hint"
            className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2"
          >
            {duplicateHint}
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">الاسم بالعربية *</label>
            <input
              className="input"
              value={form.name_ar}
              onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
              autoFocus
              required
              data-testid="quick-add-name-ar"
            />
          </div>
          <div>
            <label className="label">الاسم بالإنجليزية</label>
            <input
              className="input"
              value={form.name_en}
              onChange={(e) => setForm({ ...form, name_en: e.target.value })}
            />
          </div>
          <div>
            <label className="label">النوع *</label>
            <select
              className="input"
              value={form.type}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as typeof form.type })
              }
              required
            >
              {TYPE_LABELS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">كود المنتج (اختياري)</label>
            <input
              className="input"
              value={form.sku_root}
              onChange={(e) => setForm({ ...form, sku_root: e.target.value })}
              placeholder="يُولَّد تلقائيًا إن تُرك فارغًا"
            />
          </div>
          <div>
            <label className="label">الباركود</label>
            <input
              className="input"
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              data-testid="quick-add-barcode"
            />
          </div>
          <div>
            <label className="label">اللون</label>
            <input
              className="input"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
            />
          </div>
          <div>
            <label className="label">المقاس</label>
            <input
              className="input"
              value={form.size}
              onChange={(e) => setForm({ ...form, size: e.target.value })}
            />
          </div>
          <div>
            <label className="label">سعر التكلفة</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={form.cost_price}
              onChange={(e) =>
                setForm({ ...form, cost_price: Number(e.target.value) })
              }
              data-testid="quick-add-cost-price"
            />
          </div>
          <div>
            <label className="label">سعر البيع المقترح</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={form.selling_price || form.base_price}
              onChange={(e) =>
                setForm({
                  ...form,
                  selling_price: Number(e.target.value),
                  base_price: Number(e.target.value),
                })
              }
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={createMut.isPending}
            className="btn-primary"
            data-testid="quick-add-submit"
          >
            {createMut.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> جارٍ الحفظ...
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" /> حفظ وإضافة للفاتورة
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
