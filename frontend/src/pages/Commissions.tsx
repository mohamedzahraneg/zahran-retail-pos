import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Percent,
  TrendingUp,
  Users as UsersIcon,
  Wallet,
  FileText,
  Pencil,
  X,
} from 'lucide-react';
import {
  commissionsApi,
  type CommissionSummaryRow,
} from '@/api/commissions.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export default function CommissionsPage() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const [from, setFrom] = useState(firstOfMonth.toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [editUser, setEditUser] = useState<CommissionSummaryRow | null>(null);
  const [detailUser, setDetailUser] = useState<CommissionSummaryRow | null>(
    null,
  );

  const { data: summary = [], isLoading } = useQuery({
    queryKey: ['commissions-summary', from, to],
    queryFn: () => commissionsApi.summary(from, to),
  });

  const totals = useMemo(() => {
    return summary.reduce(
      (acc, r) => {
        acc.sales += Number(r.eligible_sales || 0);
        acc.commission += Number(r.commission_amount || 0);
        acc.invoices += Number(r.invoices_count || 0);
        return acc;
      },
      { sales: 0, commission: 0, invoices: 0 },
    );
  }, [summary]);

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-2 text-slate-800">
            <Percent className="w-7 h-7 text-brand-500" />
            عمولات المبيعات
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            حساب عمولة مندوبي البيع حسب نسبة كل مندوب ومبيعاته
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            className="input w-44"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <span className="text-slate-400">→</span>
          <input
            type="date"
            className="input w-44"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          label="عدد المندوبين"
          value={String(summary.length)}
          icon={<UsersIcon className="w-5 h-5 text-slate-500" />}
        />
        <StatCard
          label="عدد الفواتير"
          value={String(totals.invoices)}
          icon={<FileText className="w-5 h-5 text-blue-500" />}
        />
        <StatCard
          label="إجمالي المبيعات المحسوبة"
          value={EGP(totals.sales)}
          icon={<TrendingUp className="w-5 h-5 text-brand-500" />}
          tone="brand"
        />
        <StatCard
          label="إجمالي العمولات"
          value={EGP(totals.commission)}
          icon={<Wallet className="w-5 h-5 text-emerald-500" />}
          tone="emerald"
        />
      </section>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-slate-400">جاري الحساب…</div>
        ) : summary.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            لا توجد بيانات عمولات في هذه الفترة
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-3 text-right">المندوب</th>
                  <th className="p-3 text-right">النسبة</th>
                  <th className="p-3 text-right">عدد الفواتير</th>
                  <th className="p-3 text-right">إجمالي المبيعات</th>
                  <th className="p-3 text-right">مبلغ العمولة</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary.map((r) => (
                  <tr key={r.user_id} className="hover:bg-slate-50">
                    <td className="p-3">
                      <div className="font-medium">{r.full_name || '—'}</div>
                      <div className="text-xs text-slate-400 font-mono">
                        {r.username}
                      </div>
                    </td>
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-brand-50 text-brand-700 font-bold text-xs">
                        <Percent className="w-3 h-3" />
                        {Number(r.commission_rate).toFixed(2)}
                      </span>
                    </td>
                    <td className="p-3 text-slate-700">
                      {r.invoices_count || 0}
                    </td>
                    <td className="p-3 font-semibold">
                      {EGP(r.eligible_sales)}
                    </td>
                    <td className="p-3 font-black text-emerald-600">
                      {EGP(r.commission_amount)}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          title="التفاصيل"
                          onClick={() => setDetailUser(r)}
                          className="icon-btn"
                        >
                          <FileText className="w-4 h-4" />
                        </button>
                        <button
                          title="تعديل النسبة"
                          onClick={() => setEditUser(r)}
                          className="icon-btn text-brand-600"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editUser && (
        <EditRateModal
          row={editUser}
          onClose={() => setEditUser(null)}
        />
      )}

      {detailUser && (
        <DetailModal
          row={detailUser}
          from={from}
          to={to}
          onClose={() => setDetailUser(null)}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: 'brand' | 'emerald';
}) {
  const tones = {
    brand: 'text-brand-600',
    emerald: 'text-emerald-600',
  };
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-slate-50 flex items-center justify-center">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-500">{label}</div>
        <div
          className={`text-lg font-black truncate ${tone ? tones[tone] : 'text-slate-800'}`}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function EditRateModal({
  row,
  onClose,
}: {
  row: CommissionSummaryRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [rate, setRate] = useState(Number(row.commission_rate));

  const mut = useMutation({
    mutationFn: () => commissionsApi.updateRate(row.user_id, rate),
    onSuccess: () => {
      toast.success('تم تحديث النسبة');
      qc.invalidateQueries({ queryKey: ['commissions-summary'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التحديث'),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (rate < 0 || rate > 100) return toast.error('النسبة من 0 إلى 100');
          mut.mutate();
        }}
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-sm space-y-4"
      >
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Percent className="w-5 h-5 text-brand-500" />
          تعديل نسبة العمولة
        </h2>
        <div className="bg-slate-50 rounded-lg p-3 text-sm">
          <div className="font-bold">{row.full_name}</div>
          <div className="text-xs text-slate-500 font-mono">{row.username}</div>
        </div>
        <div>
          <label className="label">النسبة (%)</label>
          <input
            type="number"
            min={0}
            max={100}
            step="0.5"
            className="input text-2xl font-black text-center"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={mut.isPending}
            className="btn-primary"
          >
            حفظ
          </button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DetailModal({
  row,
  from,
  to,
  onClose,
}: {
  row: CommissionSummaryRow;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['commissions-detail', row.user_id, from, to],
    queryFn: () => commissionsApi.detail(row.user_id, from, to),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-3xl space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <FileText className="w-5 h-5 text-brand-500" />
              تفاصيل عمولات {row.full_name}
            </h2>
            <div className="text-xs text-slate-500 mt-1">
              من {from} إلى {to} — النسبة:{' '}
              {Number(row.commission_rate).toFixed(2)}%
            </div>
          </div>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="p-6 text-center text-slate-400">جاري التحميل…</div>
        ) : data.length === 0 ? (
          <div className="p-6 text-center text-slate-400">
            لا توجد فواتير لهذا المندوب في هذه الفترة
          </div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-right">رقم الفاتورة</th>
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">العميل</th>
                  <th className="p-2 text-right">مبلغ الفاتورة</th>
                  <th className="p-2 text-right">العمولة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.map((d) => (
                  <tr key={d.invoice_id}>
                    <td className="p-2 font-mono text-brand-600">
                      {d.invoice_no}
                    </td>
                    <td className="p-2 text-xs">
                      {new Date(d.completed_at).toLocaleString('en-US')}
                    </td>
                    <td className="p-2">{d.customer_name || '—'}</td>
                    <td className="p-2 font-semibold">
                      {EGP(d.eligible_total)}
                    </td>
                    <td className="p-2 font-black text-emerald-600">
                      {EGP(d.commission)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-ghost">
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}
