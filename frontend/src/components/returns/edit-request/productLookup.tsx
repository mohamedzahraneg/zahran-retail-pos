/**
 * ProductLookupInput — guards the guided edit-request UI from
 * accepting a free-text SKU that doesn't map to a real product
 * variant.  Used in two places:
 *   1. The "إضافة منتج جديد لطلب التعديل" form (add new line).
 *   2. The existing-line "تغيير المنتج" flow (replace product on a
 *      line that's being edited).
 *
 * Strict scope:
 *   · GET-only — calls `productsApi.byBarcode(sku)` (read-only).
 *   · Never writes a product / variant.
 *   · Never POSTs.  Never PATCHes.  Never DELETEs.
 *   · Surfaces the resolved variant to its parent through `onResolved`.
 *     The parent decides what to do with it (queue an added line,
 *     swap an existing line's identity, etc.).
 *
 * Validation states (mirrored in test ids):
 *   · empty SKU            → "كود المنتج مطلوب"
 *   · lookup miss / error  → "كود المنتج غير موجود في قاعدة البيانات"
 *   · lookup success       → "تم العثور على المنتج" + name + sku display
 *
 * The parent reads `resolved` to know whether a confirmed product
 * exists; submit/add affordances should be gated on `resolved !== null`.
 */
import { useCallback, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import { productsApi } from '@/api/products.api';

export interface ResolvedProduct {
  variant_id: string;
  sku: string;
  name: string;
  /** Pulled from `variant.selling_price` when available, else `product.base_price`. */
  suggested_price: number;
  color: string | null;
  size: string | null;
}

export interface ProductLookupInputProps {
  /** Initial SKU (e.g. the line's current SKU when entering an edit flow). */
  initialSku?: string;
  /** Called with the resolved variant once the user confirms it. */
  onResolved: (resolved: ResolvedProduct) => void;
  /** Called when the user clears / resets the lookup. */
  onCleared?: () => void;
  /** Custom miss-message override (e.g. "كود المنتج الجديد غير موجود"). */
  missMessage?: string;
  /** Compact mode hides the success card details (used in narrow editor). */
  compact?: boolean;
  /**
   * Optional testid prefix so the same component can render twice in
   * the same DOM (one in add form, one in line editor) without
   * collisions.
   */
  testIdPrefix?: string;
}

type LookupState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'resolved'; data: ResolvedProduct }
  | { kind: 'empty' }
  | { kind: 'not-found' }
  | { kind: 'error' };

const DEFAULT_MISS_MESSAGE = 'كود المنتج غير موجود في قاعدة البيانات';
const EMPTY_MESSAGE = 'كود المنتج مطلوب';

export function ProductLookupInput({
  initialSku = '',
  onResolved,
  onCleared,
  missMessage = DEFAULT_MISS_MESSAGE,
  compact = false,
  testIdPrefix = 'product-lookup',
}: ProductLookupInputProps) {
  const [sku, setSku] = useState(initialSku);
  const [state, setState] = useState<LookupState>({ kind: 'idle' });

  const reset = useCallback(() => {
    setState({ kind: 'idle' });
    onCleared?.();
  }, [onCleared]);

  const handleLookup = useCallback(async () => {
    const code = sku.trim();
    if (code.length === 0) {
      setState({ kind: 'empty' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const r = await productsApi.byBarcode(code);
      const variant = r?.variant;
      const product = r?.product;
      if (!variant?.id) {
        setState({ kind: 'not-found' });
        return;
      }
      const sellingPrice =
        variant.selling_price != null
          ? Number(variant.selling_price)
          : Number(product?.base_price ?? 0);
      const resolved: ResolvedProduct = {
        variant_id: variant.id,
        sku: variant.sku ?? code,
        name: product?.name_ar ?? variant.sku ?? code,
        suggested_price: Number.isFinite(sellingPrice) ? sellingPrice : 0,
        color: variant.color ?? null,
        size: variant.size ?? null,
      };
      setState({ kind: 'resolved', data: resolved });
      onResolved(resolved);
    } catch {
      // Treat any thrown error (404, network, etc.) as "not found" —
      // the user's remedy in both cases is to retype.
      setState({ kind: 'not-found' });
    }
  }, [sku, onResolved]);

  // Disable the search button while loading or when a product is
  // already resolved (the user must clear/reset to look up a different
  // SKU).
  const searchDisabled = state.kind === 'loading';
  const resolved = state.kind === 'resolved' ? state.data : null;

  return (
    <div
      className="space-y-2"
      data-testid={`${testIdPrefix}-root`}
      dir="rtl"
    >
      <div className="flex gap-2 items-stretch">
        <div className="relative flex-1">
          <input
            type="text"
            value={sku}
            onChange={(e) => {
              setSku(e.target.value);
              if (state.kind !== 'idle' && state.kind !== 'loading') {
                // User edited the SKU after a previous attempt — drop
                // the prior resolution so submit re-gates.
                reset();
              }
            }}
            placeholder="SKU / الكود"
            className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 pl-8 text-sm w-full font-mono focus:border-brand-300 outline-none disabled:bg-slate-100"
            data-testid={`${testIdPrefix}-sku-input`}
            dir="ltr"
            disabled={resolved !== null}
          />
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
        </div>
        {resolved ? (
          <button
            type="button"
            onClick={() => {
              setSku('');
              reset();
            }}
            className="text-[11px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2 rounded-lg inline-flex items-center gap-1"
            data-testid={`${testIdPrefix}-clear`}
          >
            <X size={12} /> إعادة البحث
          </button>
        ) : (
          <button
            type="button"
            onClick={handleLookup}
            disabled={searchDisabled}
            className="text-[11px] font-bold text-brand-700 bg-brand-50 hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed px-2 rounded-lg inline-flex items-center gap-1"
            data-testid={`${testIdPrefix}-search`}
          >
            {state.kind === 'loading' ? (
              <>
                <Loader2 size={12} className="animate-spin" /> جارٍ البحث…
              </>
            ) : (
              <>
                <Search size={12} /> بحث عن المنتج
              </>
            )}
          </button>
        )}
      </div>

      {state.kind === 'empty' && (
        <div
          className="text-[11px] text-rose-700"
          data-testid={`${testIdPrefix}-error-empty`}
        >
          {EMPTY_MESSAGE}
        </div>
      )}
      {state.kind === 'not-found' && (
        <div
          className="text-[11px] text-rose-700"
          data-testid={`${testIdPrefix}-error-not-found`}
        >
          {missMessage}
        </div>
      )}
      {resolved && (
        <div
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-[12px]"
          data-testid={`${testIdPrefix}-resolved`}
        >
          <div className="flex items-center gap-1 text-emerald-800 font-bold mb-1">
            <Check size={12} /> تم العثور على المنتج
          </div>
          <div className="text-slate-800">
            <span className="font-bold">{resolved.name}</span>
          </div>
          {!compact && (
            <div className="text-[11px] text-slate-500 font-mono">
              {[resolved.sku, resolved.color, resolved.size]
                .filter(Boolean)
                .join(' • ')}
              {resolved.suggested_price > 0 && (
                <>
                  {' • '}سعر مقترح:{' '}
                  {resolved.suggested_price.toLocaleString('en-EG', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  ج.م
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
