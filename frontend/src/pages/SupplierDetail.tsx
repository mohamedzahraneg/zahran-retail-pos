import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import {
  Truck,
  ArrowLeft,
  DollarSign,
  ShoppingCart,
  Wallet,
  Percent,
  AlertTriangle,
} from 'lucide-react';
import { suppliersApi, SupplierType } from '@/api/suppliers.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const TYPE_LABEL: Record<SupplierType, { label: string; tone: string }> = {
  cash: { label: 'كاش', tone: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  credit: { label: 'آجل', tone: 'bg-amber-100 text-amber-700 border-amber-200' },
  installments: { label: 'أقساط', tone: 'bg-violet-100 text-violet-700 border-violet-200' },
};

function fmtDate(s: string) {
  if (!s) return '';
  return new Date(s).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
function fmtWhen(s: string) {
  if (!s) return '';
  return new Date(s).toLocaleString('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: 'نقدي',
  card: 'بطاقة',
  instapay: 'إنستا باي',
  bank_transfer: 'تحويل بنكي',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'مسودة',
  received: 'تم الاستلام',
  partial: 'سداد جزئي',
  paid: 'مسدد',
  cancelled: 'ملغاة',
};
const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600 border-slate-200',
  received: 'bg-amber-100 text-amber-700 border-amber-200',
  partial: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  paid: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  cancelled: 'bg-rose-100 text-rose-700 border-rose-200',
};

export default function SupplierDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading } = useQuery({
    queryKey: ['supplier-summary', id],
    queryFn: () => suppliersApi.summary(id as string),
    enabled: !!id,
    refetchInterval: 60_000,
  });

  const totals = useMemo(() => {
    if (!data) return null;
    const s = data.supplier;
    return {
      purchases: Number(s.purchases_total || 0),
      paid: Number(s.paid_total || 0),
      unpaid: Number(s.unpaid_total || 0),
      balance: Number(s.current_balance || 0),
    };
  }, [data]);

  if (isLoading || !data) {
    return (
      <div className="card p-12 text-center text-slate-500">
        جارٍ تحميل ملف المورد…
      </div>
    );
  }

  const s = data.supplier;
  const type = (s.supplier_type || 'credit') as SupplierType;
  const typeStyle = TYPE_LABEL[type];
  const overLimit =
    Number(s.credit_limit || 0) > 0 &&
    Number(s.current_balance || 0) > Number(s.credit_limit || 0);

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/suppliers"
          className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1 mb-2"
        >
          <ArrowLeft size={14} /> رجوع للموردين
        </Link>
      </div>

      {/* ─── Profile header ─── */}
      <div className="card p-5 bg-gradient-to-br from-slate-800 via-slate-900 to-slate-800 text-white">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center">
              <Truck size={26} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-widest text-white/60">
                ملف المورد
              </div>
              <div className="text-2xl font-black mt-1">{s.name}</div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="chip bg-white/10 border-white/20 font-mono">
                  {s.code}
                </span>
                <span className={`chip border ${typeStyle.tone}`}>
                  {typeStyle.label}
                </span>
                {Number(s.payment_terms_days || 0) > 0 && (
                  <span className="chip bg-white/10 border-white/20 text-xs">
                    مهلة {s.payment_terms_days} يوم
                  </span>
                )}
                {s.phone && (
                  <span className="text-white/80 text-xs" dir="ltr">
                    📞 {s.phone}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="text-left">
            <div className="text-[11px] text-white/60 mb-1">الرصيد المستحق</div>
            <div className="text-3xl font-black tabular-nums">
              {EGP(totals?.balance || 0)}
            </div>
            {Number(s.credit_limit || 0) > 0 && (
              <div className="text-[11px] text-white/70 mt-1">
                من حد ائتمان {EGP(s.credit_limit || 0)}
                {data.credit_usage_pct != null && (
                  <span className="font-mono mx-1">
                    ({data.credit_usage_pct}%)
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {overLimit && (
        <div className="card p-4 border-2 border-rose-200 bg-rose-50">
          <div className="flex items-start gap-2">
            <AlertTriangle className="text-rose-600 mt-0.5" size={18} />
            <div className="text-sm text-rose-800">
              <div className="font-black mb-1">تحذير: تجاوزت حد الائتمان</div>
              <div className="text-xs">
                الرصيد المستحق {EGP(s.current_balance || 0)} تجاوز الحد
                المتفق عليه {EGP(s.credit_limit || 0)} — يُفضَّل وقف
                التعامل الآجل حتى السداد.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Payment schedule + upcoming-due alert */}
      {data.schedule?.day_of_week !== null &&
        data.schedule?.day_of_week !== undefined && (
          <div
            className={`card p-4 border-2 ${
              Number(data.schedule.days_until) <= 1
                ? 'border-rose-300 bg-rose-50'
                : Number(data.schedule.days_until) <= 3
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-indigo-200 bg-indigo-50'
            }`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className={
                  Number(data.schedule.days_until) <= 1
                    ? 'text-rose-600 mt-0.5'
                    : Number(data.schedule.days_until) <= 3
                      ? 'text-amber-600 mt-0.5'
                      : 'text-indigo-600 mt-0.5'
                }
                size={18}
              />
              <div className="text-sm flex-1">
                <div className="font-black mb-1">
                  موعد دفعة قادم —{' '}
                  {data.schedule.days_until === 0
                    ? 'اليوم'
                    : data.schedule.days_until === 1
                      ? 'غدًا'
                      : `بعد ${data.schedule.days_until} يوم`}
                </div>
                <div className="text-xs">
                  التاريخ: {data.schedule.next_payment_date} · قيمة الدفعة:{' '}
                  {data.schedule.installment_amount != null
                    ? EGP(data.schedule.installment_amount)
                    : 'غير محددة'}
                </div>
              </div>
            </div>
          </div>
        )}

      {/* Ratios strip (outstanding vs paid) */}
      {data.ratios && (
        <div className="card p-4">
          <div className="flex items-center justify-between text-xs mb-2">
            <div className="flex items-center gap-2">
              <span className="font-black text-slate-700">نسبة السداد</span>
              <span className="text-slate-400">
                من إجمالي النشاط (مستحق + مدفوع)
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-bold">
              <span className="text-rose-700">
                مستحق {data.ratios.outstanding_pct}%
              </span>
              <span className="text-emerald-700">
                مدفوع {data.ratios.paid_pct}%
              </span>
            </div>
          </div>
          <div className="h-3 rounded-full bg-slate-100 overflow-hidden flex">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${data.ratios.paid_pct}%` }}
            />
            <div
              className="h-full bg-rose-500"
              style={{ width: `${data.ratios.outstanding_pct}%` }}
            />
          </div>
        </div>
      )}

      {/* ─── Metrics ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric
          label="إجمالي المشتريات"
          value={EGP(totals?.purchases || 0)}
          hint={`${s.purchase_count || 0} فاتورة`}
          tone="indigo"
          icon={<ShoppingCart size={18} />}
        />
        <Metric
          label="إجمالي المدفوع"
          value={EGP(totals?.paid || 0)}
          hint={`${data.payments.length} دفعة`}
          tone="emerald"
          icon={<Wallet size={18} />}
        />
        <Metric
          label="غير المسدد"
          value={EGP(totals?.unpaid || 0)}
          tone={totals && totals.unpaid > 0 ? 'amber' : 'slate'}
          icon={<DollarSign size={18} />}
        />
        <Metric
          label="رصيد افتتاحي"
          value={EGP(s.opening_balance || 0)}
          tone="slate"
        />
      </div>

      {/* ─── Purchases ─── */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <ShoppingCart className="text-indigo-600" size={18} />
          <h3 className="font-black text-slate-800">
            المشتريات ({data.purchases.length})
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs">
              <tr>
                <th className="p-2 text-right">رقم الفاتورة</th>
                <th className="p-2 text-center">التاريخ</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2 text-left">المسدد</th>
                <th className="p-2 text-left">المتبقي</th>
                <th className="p-2 text-center">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.purchases.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-400">
                    لا مشتريات
                  </td>
                </tr>
              )}
              {data.purchases.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="p-2 font-mono font-bold text-slate-700">
                    {p.purchase_no}
                  </td>
                  <td className="p-2 text-center tabular-nums text-slate-600">
                    {fmtDate(p.invoice_date)}
                  </td>
                  <td className="p-2 text-left font-mono font-bold">
                    {EGP(p.grand_total)}
                  </td>
                  <td className="p-2 text-left font-mono text-emerald-700">
                    {EGP(p.paid_amount)}
                  </td>
                  <td className="p-2 text-left font-mono text-amber-700">
                    {EGP(p.remaining)}
                  </td>
                  <td className="p-2 text-center">
                    <span
                      className={`chip border text-[11px] ${
                        STATUS_STYLE[p.status] || STATUS_STYLE.draft
                      }`}
                    >
                      {STATUS_LABEL[p.status] || p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Payments + Ledger ─── */}
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Wallet className="text-emerald-600" size={18} />
            <h3 className="font-black text-slate-800">
              السدادات ({data.payments.length})
            </h3>
          </div>
          {data.payments.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-6">
              لا دفعات
            </div>
          ) : (
            <ul className="space-y-2">
              {data.payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between border-b border-slate-100 pb-2 last:border-0 text-xs"
                >
                  <div>
                    <div className="font-bold text-slate-700">
                      {EGP(p.amount)}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {p.purchase_no} ·{' '}
                      {PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}
                      {p.paid_by_name && (
                        <span className="mx-1">· {p.paid_by_name}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-slate-500 tabular-nums">
                    {fmtWhen(p.paid_at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Percent className="text-violet-600" size={18} />
            <h3 className="font-black text-slate-800">
              خصومات على الأصناف ({data.discounts.length})
            </h3>
          </div>
          {data.discounts.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-6">
              لا خصومات مسجلة على أصناف هذا المورد
            </div>
          ) : (
            <ul className="space-y-1 text-xs">
              {data.discounts.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between border-b border-slate-100 pb-1 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="font-bold text-slate-700 truncate">
                      {d.name}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono">
                      {d.sku} · {d.purchase_no} · {fmtDate(d.invoice_date)}
                    </div>
                  </div>
                  <span className="chip bg-violet-100 text-violet-700 border-violet-200 font-mono">
                    − {EGP(d.discount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'indigo' | 'emerald' | 'amber' | 'slate' | 'rose';
  icon?: React.ReactNode;
}) {
  const bg = {
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 ${bg}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold opacity-80">{label}</span>
        <span className="opacity-70">{icon}</span>
      </div>
      <div className="text-xl font-black tabular-nums truncate">{value}</div>
      {hint && <div className="text-[10px] opacity-70 mt-0.5">{hint}</div>}
    </div>
  );
}
