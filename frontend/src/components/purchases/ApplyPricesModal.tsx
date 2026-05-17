/**
 * ApplyPricesModal — PR-PURCHASES-P3.2
 *
 * Confirmation modal for the manual "apply suggested sale prices"
 * action. Surfaces every variant about to change with old / new /
 * diff / strategy so the operator confirms exactly what will hit the
 * DB. On confirm, calls `productsApi.applyVariantPrices` (single round
 * trip, single transaction on the backend) and reports the result.
 *
 * Pricing-only contract:
 *   · The endpoint updates `product_variants.selling_price` and
 *     inserts a `variant_price_history` audit row per change.
 *   · NOT linked to the purchase save mutation — operators can apply
 *     prices independently of whether the purchase is saved.
 *   · 403 from the backend (missing `products.price_change`) is
 *     surfaced as a clear Arabic toast.
 */
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, XCircle } from 'lucide-react';
import {
  productsApi,
  type ApplyVariantPricesResponse,
} from '@/api/products.api';
import type { PricingStrategy } from './pricingMath';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const STRATEGY_LABEL_AR: Record<PricingStrategy, string> = {
  competitive: 'اقتصادي / منافس',
  recommended: 'موصى به',
  high_margin: 'هامش عالي',
  wholesale: 'جملة',
};

export interface ApplyPricesItem {
  /** Local row index in the parent modal (so we can clear the pending
   *  state by index after a successful apply). */
  row_index: number;
  variant_id: string;
  display: string;
  current_selling_price: number | undefined;
  new_selling_price: number;
  strategy: PricingStrategy;
}

export interface ApplyPricesModalProps {
  open: boolean;
  items: ApplyPricesItem[];
  /** Optional source purchase id — stored on every audit row. */
  sourcePurchaseId?: string;
  onClose: () => void;
  /** Fired with the indexes of rows that were either updated or
   *  skipped (i.e. equal to current price) so the parent can clear
   *  their pending markers. */
  onApplied: (rowIndexes: number[]) => void;
}

export function ApplyPricesModal({
  open,
  items,
  sourcePurchaseId,
  onClose,
  onApplied,
}: ApplyPricesModalProps) {
  const apply = useMutation({
    mutationFn: () =>
      productsApi.applyVariantPrices({
        source_purchase_id: sourcePurchaseId,
        reason: sourcePurchaseId
          ? 'تطبيق الأسعار المقترحة من فاتورة مشتريات'
          : 'تطبيق الأسعار المقترحة يدويًا',
        items: items.map((it) => ({
          variant_id: it.variant_id,
          new_selling_price: it.new_selling_price,
        })),
      }),
    onSuccess: (res: ApplyVariantPricesResponse) => {
      const message =
        res.updated > 0 && res.skipped > 0
          ? `تم تحديث ${res.updated} سعر — تم تخطي ${res.skipped} سعر مطابق للقيمة الحالية.`
          : res.updated > 0
            ? `تم تحديث ${res.updated} سعر بيع.`
            : 'لم تتغير الأسعار — جميع القيم مطابقة للحالية.';
      toast.success(message);
      onApplied(items.map((it) => it.row_index));
      onClose();
    },
    onError: (e: any) => {
      const status = e?.response?.status;
      if (status === 403) {
        toast.error('ليس لديك صلاحية تحديث أسعار البيع.');
      } else {
        toast.error(
          e?.response?.data?.message
            || e?.message
            || 'فشل تحديث أسعار البيع.',
        );
      }
    },
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-[60] flex items-center justify-center p-4"
      data-testid="apply-prices-modal"
    >
      <div
        className="bg-white rounded-2xl w-full max-w-2xl shadow-xl max-h-[90vh] overflow-hidden flex flex-col"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-black text-slate-800 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              تأكيد تحديث أسعار البيع
            </h3>
            <p
              className="text-[11px] text-slate-600 mt-1 leading-relaxed"
              data-testid="apply-prices-disclaimer"
            >
              سيتم تحديث أسعار البيع لهذه الأصناف. لن يتم تعديل الفاتورة
              الحالية أو المخزون أو القيود المحاسبية.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={apply.isPending}
            aria-label="إغلاق"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs">
                <tr>
                  <th className="p-2 text-right">الصنف</th>
                  <th className="p-2 text-right">السعر الحالي</th>
                  <th className="p-2 text-right">السعر الجديد</th>
                  <th className="p-2 text-right">الفرق</th>
                  <th className="p-2 text-right">الاستراتيجية</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => {
                  const diff =
                    it.current_selling_price != null
                      ? +(it.new_selling_price - it.current_selling_price).toFixed(2)
                      : null;
                  return (
                    <tr
                      key={it.variant_id}
                      data-testid={`apply-prices-row-${it.variant_id}`}
                    >
                      <td className="p-2 font-medium">{it.display}</td>
                      <td className="p-2 text-slate-600">
                        {it.current_selling_price != null
                          ? EGP(it.current_selling_price)
                          : '—'}
                      </td>
                      <td className="p-2 font-bold text-emerald-700">
                        {EGP(it.new_selling_price)}
                      </td>
                      <td className="p-2">
                        {diff == null ? (
                          '—'
                        ) : (
                          <span
                            className={`font-bold ${
                              diff >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {diff >= 0 ? '+' : ''}
                            {EGP(diff)}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-xs text-slate-600">
                        {STRATEGY_LABEL_AR[it.strategy]}
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="p-6 text-center text-slate-400 text-xs"
                    >
                      لا توجد أسعار محددة للتطبيق
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="p-4 border-t flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={apply.isPending}
            className="btn-ghost"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={() => apply.mutate()}
            disabled={apply.isPending || items.length === 0}
            className="btn-primary"
            data-testid="apply-prices-confirm"
          >
            {apply.isPending ? 'جاري التحديث...' : 'تأكيد تحديث أسعار البيع'}
          </button>
        </div>
      </div>
    </div>
  );
}
