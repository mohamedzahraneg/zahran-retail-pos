/**
 * SupplierContextCard — PR-PURCHASES-P1
 *
 * Read-only card rendered on the Purchase Invoice header once the
 * operator picks a supplier. Pulls everything in a single round-trip
 * via `purchasesApi.supplierContext(id)`.
 *
 * Layout (RTL):
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ #SUP-001 — مورد تجريبي              [له ١٬٥٠٠ ج.م]         │
 *   │ آخر فاتورة: PO-2026-000005 — منذ ٦ أيام · جزئي             │
 *   │ عدد الفواتير: 5  ·  إجمالي المشتريات: 12,000 ج.م           │
 *   └────────────────────────────────────────────────────────────┘
 */

import { useQuery } from '@tanstack/react-query';
import { Building2, Loader2 } from 'lucide-react';
import { purchasesApi } from '@/api/purchases.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const INTERACTION_LABEL: Record<'cash' | 'partial' | 'credit', string> = {
  cash: 'كاش',
  partial: 'سداد جزئي',
  credit: 'آجل',
};

const INTERACTION_COLOR: Record<'cash' | 'partial' | 'credit', string> = {
  cash: 'bg-emerald-50 text-emerald-700',
  partial: 'bg-amber-50 text-amber-700',
  credit: 'bg-rose-50 text-rose-700',
};

function relativeDateAr(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return 'اليوم';
  if (days === 1) return 'أمس';
  if (days < 7) return `منذ ${days} أيام`;
  if (days < 30) return `منذ ${Math.floor(days / 7)} أسابيع`;
  if (days < 365) return `منذ ${Math.floor(days / 30)} أشهر`;
  return `منذ ${Math.floor(days / 365)} سنوات`;
}

export interface SupplierContextCardProps {
  supplierId: string;
}

export function SupplierContextCard({ supplierId }: SupplierContextCardProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['supplier-context', supplierId],
    queryFn: () => purchasesApi.supplierContext(supplierId),
    enabled: !!supplierId,
    staleTime: 30_000,
  });

  if (!supplierId) return null;

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 flex items-center gap-2 text-slate-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        جارٍ تحميل بيانات المورد...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700 text-sm">
        تعذّر تحميل بيانات المورد.
      </div>
    );
  }

  const { supplier, stats, last_purchase: last } = data;

  const balanceLabel =
    supplier.balance_direction === 'owed_to_supplier'
      ? `له ${EGP(supplier.current_balance)}`
      : supplier.balance_direction === 'credit_to_us'
        ? `علينا ${EGP(Math.abs(supplier.current_balance))}`
        : 'الرصيد صفر';
  const balanceColor =
    supplier.balance_direction === 'owed_to_supplier'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : supplier.balance_direction === 'credit_to_us'
        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
        : 'bg-slate-50 text-slate-600 border-slate-200';

  return (
    <div
      data-testid="supplier-context-card"
      className="rounded-xl border border-slate-200 bg-white p-3 space-y-2 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-brand-500" />
          <span className="text-slate-500 text-xs">#{supplier.code}</span>
          <span className="font-bold text-slate-800">{supplier.name}</span>
        </div>
        <span
          className={`text-xs font-bold px-2 py-1 rounded-md border ${balanceColor}`}
          data-testid="supplier-balance-badge"
        >
          {balanceLabel}
        </span>
      </div>

      {last ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>آخر فاتورة:</span>
          <span className="font-mono font-bold text-slate-800">{last.purchase_no}</span>
          <span>—</span>
          <span>{relativeDateAr(last.invoice_date)}</span>
          {last.interaction ? (
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${INTERACTION_COLOR[last.interaction]}`}
              data-testid="supplier-last-interaction"
            >
              {INTERACTION_LABEL[last.interaction]}
            </span>
          ) : null}
          <span className="text-slate-400">·</span>
          <span>إجمالي: {EGP(last.grand_total)}</span>
          {last.remaining > 0 ? (
            <>
              <span className="text-slate-400">·</span>
              <span className="text-rose-600">متبقي: {EGP(last.remaining)}</span>
            </>
          ) : null}
        </div>
      ) : (
        <div className="text-xs text-slate-500">لا توجد فواتير سابقة لهذا المورد.</div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
        <span>
          عدد الفواتير:{' '}
          <span className="font-bold text-slate-800">{stats.purchase_count}</span>
        </span>
        <span className="text-slate-400">·</span>
        <span>
          إجمالي المشتريات:{' '}
          <span className="font-bold text-slate-800">{EGP(stats.purchases_total)}</span>
        </span>
        {stats.unpaid_total > 0 ? (
          <>
            <span className="text-slate-400">·</span>
            <span>
              غير مسدد:{' '}
              <span className="font-bold text-rose-600">{EGP(stats.unpaid_total)}</span>
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
