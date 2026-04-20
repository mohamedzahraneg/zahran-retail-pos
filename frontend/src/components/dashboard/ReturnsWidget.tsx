import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Undo2, ArrowLeft } from 'lucide-react';
import {
  returnsAnalyticsApi,
  REASON_LABELS_AR,
} from '@/api/returnsAnalytics.api';

const EGP = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'EGP',
  maximumFractionDigits: 0,
});

export function ReturnsWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ['returns-widget'],
    queryFn: () => returnsAnalyticsApi.widget(),
    refetchInterval: 60_000,
  });

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-black text-slate-800 flex items-center gap-2">
          <Undo2 size={18} className="text-rose-500" />
          المرتجعات — آخر 30 يوم
        </h3>
        <Link
          to="/returns-analytics"
          className="text-sm text-brand-600 font-semibold hover:text-brand-700 flex items-center gap-1"
        >
          التفاصيل
          <ArrowLeft size={14} />
        </Link>
      </div>

      {isLoading ? (
        <div className="text-center text-slate-400 py-6">جارٍ التحميل...</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-4">
            <div className="bg-rose-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-black text-rose-600">
                {data?.count_30d || 0}
              </div>
              <div className="text-xs text-rose-700 font-semibold">
                مرتجع
              </div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3 text-center">
              <div className="text-lg font-black text-amber-600">
                {EGP.format(Number(data?.refund_30d || 0))}
              </div>
              <div className="text-xs text-amber-700 font-semibold">
                مبلغ مسترد
              </div>
            </div>
            <div className="bg-indigo-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-black text-indigo-600">
                {data?.pending_count || 0}
              </div>
              <div className="text-xs text-indigo-700 font-semibold">
                معلّقة
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <div className="text-xs font-bold text-slate-500 mb-2">
                أهم الأسباب
              </div>
              {(data?.top_reasons || []).length === 0 ? (
                <div className="text-xs text-slate-400">لا توجد مرتجعات</div>
              ) : (
                <div className="space-y-1">
                  {(data?.top_reasons || []).map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between text-sm bg-slate-50 rounded-lg px-3 py-1.5"
                    >
                      <span className="font-semibold text-slate-700">
                        {REASON_LABELS_AR[r.reason] || r.reason}
                      </span>
                      <span className="chip bg-white text-slate-700">
                        {r.cnt}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-bold text-slate-500 mb-2">
                أكثر المنتجات مرتجعة
              </div>
              {(data?.top_products || []).length === 0 ? (
                <div className="text-xs text-slate-400">
                  لا توجد منتجات مرتجعة
                </div>
              ) : (
                <div className="space-y-1">
                  {(data?.top_products || []).map((p, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between text-sm bg-slate-50 rounded-lg px-3 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-700 truncate">
                          {p.name_ar}
                        </div>
                        <div className="text-xs text-slate-400 font-mono">
                          {p.sku}
                        </div>
                      </div>
                      <span className="chip bg-rose-100 text-rose-700">
                        {p.returned_qty}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
