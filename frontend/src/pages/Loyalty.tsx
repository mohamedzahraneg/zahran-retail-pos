import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Gift,
  Settings as SettingsIcon,
  Plus,
  Minus,
  Search,
  History,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  loyaltyApi,
  type LoyaltyCustomerRow,
  type LoyaltyConfig,
} from '@/api/loyalty.api';

const EGP = (n: number) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export default function Loyalty() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [adjustTarget, setAdjustTarget] =
    useState<LoyaltyCustomerRow | null>(null);
  const [historyTarget, setHistoryTarget] =
    useState<LoyaltyCustomerRow | null>(null);

  const { data: config } = useQuery({
    queryKey: ['loyalty-config'],
    queryFn: () => loyaltyApi.config(),
  });

  const { data: customers = [] } = useQuery({
    queryKey: ['loyalty-customers', search],
    queryFn: () => loyaltyApi.customers({ q: search || undefined, limit: 300 }),
  });

  const totalPoints = customers.reduce(
    (s, c) => s + Number(c.loyalty_points || 0),
    0,
  );
  const totalEgp = customers.reduce(
    (s, c) => s + Number(c.redeemable_egp || 0),
    0,
  );

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-2 text-slate-800">
            <Gift className="w-7 h-7 text-brand-500" />
            برنامج ولاء العملاء
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            إدارة نقاط ولاء العملاء، تعديل الأرصدة يدويًا، وضبط معدل الكسب
            والاستبدال.
          </p>
        </div>
        <button
          onClick={() => setConfigOpen(true)}
          className="btn-ghost border border-slate-200 flex items-center gap-2"
        >
          <SettingsIcon className="w-4 h-4" />
          إعدادات النقاط
        </button>
      </header>

      {/* KPIs */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="عدد العملاء"
          value={customers.length.toLocaleString('en-US')}
        />
        <KpiCard
          label="إجمالي النقاط"
          value={totalPoints.toLocaleString('en-US')}
        />
        <KpiCard label="قيمة الاستبدال" value={EGP(totalEgp)} />
        {config && (
          <KpiCard
            label="معدل الكسب"
            value={`${config.points_per_egp} ن / ج.م`}
            sub={`استبدال: ${EGP(config.egp_per_point)} / نقطة`}
          />
        )}
      </section>

      {/* Search */}
      <div className="card p-4 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2 flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            className="bg-transparent outline-none flex-1"
            placeholder="بحث بالاسم أو الهاتف…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Customers table */}
      <div className="card p-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-3 text-right">العميل</th>
                <th className="p-3 text-right">الهاتف</th>
                <th className="p-3 text-right">النقاط</th>
                <th className="p-3 text-right">قيمة الاستبدال</th>
                <th className="p-3 text-right">التصنيف</th>
                <th className="p-3 text-right">إجمالي المشتريات</th>
                <th className="p-3 text-right">عدد الزيارات</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {customers.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-400">
                    لا توجد بيانات
                  </td>
                </tr>
              )}
              {customers.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="p-3 font-medium">{c.full_name}</td>
                  <td className="p-3 text-xs font-mono text-slate-600">
                    {c.phone || '—'}
                  </td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold text-xs">
                      {Number(c.loyalty_points || 0).toLocaleString('en-US')}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-emerald-700">
                    {EGP(c.redeemable_egp)}
                  </td>
                  <td className="p-3 text-xs text-slate-600">
                    {c.loyalty_tier || '—'}
                  </td>
                  <td className="p-3 font-mono text-xs text-slate-600">
                    {EGP(Number(c.total_spent || 0))}
                  </td>
                  <td className="p-3 text-xs text-slate-600">
                    {Number(c.visits_count || 0).toLocaleString('en-US')}
                  </td>
                  <td className="p-3 flex items-center gap-1 justify-end">
                    <button
                      onClick={() => setAdjustTarget(c)}
                      className="text-xs text-brand-600 hover:bg-brand-50 rounded px-2 py-1 font-bold"
                    >
                      تعديل النقاط
                    </button>
                    <button
                      onClick={() => setHistoryTarget(c)}
                      className="text-xs text-slate-500 hover:bg-slate-100 rounded px-2 py-1 flex items-center gap-1"
                    >
                      <History className="w-3 h-3" />
                      السجل
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {configOpen && config && (
        <ConfigModal
          current={config}
          onClose={() => setConfigOpen(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['loyalty-config'] });
            qc.invalidateQueries({ queryKey: ['loyalty-customers'] });
            setConfigOpen(false);
          }}
        />
      )}

      {adjustTarget && (
        <AdjustModal
          customer={adjustTarget}
          onClose={() => setAdjustTarget(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['loyalty-customers'] });
            setAdjustTarget(null);
          }}
        />
      )}

      {historyTarget && (
        <HistoryModal
          customer={historyTarget}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-black text-slate-800 mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function AdjustModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: LoyaltyCustomerRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [points, setPoints] = useState(0);
  const [direction, setDirection] = useState<'add' | 'subtract'>('add');
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () =>
      loyaltyApi.adjust(customer.id, {
        delta: direction === 'add' ? Math.abs(points) : -Math.abs(points),
        reason: reason || undefined,
      }),
    onSuccess: (data) => {
      toast.success(
        `تم — الرصيد الجديد: ${data.current.toLocaleString('en-US')} نقطة`,
      );
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'تعذر تعديل النقاط'),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-md space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">تعديل نقاط — {customer.full_name}</h2>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="bg-slate-50 rounded-lg p-3 text-sm flex items-center justify-between">
          <span className="text-slate-600">الرصيد الحالي</span>
          <span className="font-bold text-amber-700">
            {Number(customer.loyalty_points).toLocaleString('en-US')} نقطة
          </span>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 mb-1 block">
            العملية
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setDirection('add')}
              className={`flex-1 py-2 rounded-lg font-bold text-sm flex items-center justify-center gap-1 ${
                direction === 'add'
                  ? 'bg-emerald-500 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              <Plus className="w-4 h-4" /> إضافة
            </button>
            <button
              onClick={() => setDirection('subtract')}
              className={`flex-1 py-2 rounded-lg font-bold text-sm flex items-center justify-center gap-1 ${
                direction === 'subtract'
                  ? 'bg-rose-500 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              <Minus className="w-4 h-4" /> خصم
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 mb-1 block">
            عدد النقاط
          </label>
          <input
            type="number"
            className="input w-full"
            value={points || ''}
            onChange={(e) => setPoints(Number(e.target.value) || 0)}
            min={1}
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 mb-1 block">
            السبب (اختياري)
          </label>
          <input
            className="input w-full"
            placeholder="مثال: بونص ترويجي، تعويض، إلخ"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            disabled={!points || save.isPending}
            onClick={() => save.mutate()}
            className="btn-primary"
          >
            تأكيد
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfigModal({
  current,
  onClose,
  onSaved,
}: {
  current: LoyaltyConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<LoyaltyConfig>(current);

  const save = useMutation({
    mutationFn: () => loyaltyApi.updateConfig(form),
    onSuccess: () => {
      toast.success('تم حفظ الإعدادات');
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'تعذر الحفظ'),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-md space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">إعدادات نقاط الولاء</h2>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>
        <FormRow
          label="نقاط مكتسبة لكل جنيه يُنفَق"
          help="مثال: 0.1 يعني 1 نقطة لكل 10 جنيه"
        >
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={form.points_per_egp}
            onChange={(e) =>
              setForm({ ...form, points_per_egp: Number(e.target.value) })
            }
          />
        </FormRow>
        <FormRow
          label="قيمة النقطة بالجنيه عند الاستبدال"
          help="مثال: 0.05 يعني كل 100 نقطة = 5 ج.م"
        >
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={form.egp_per_point}
            onChange={(e) =>
              setForm({ ...form, egp_per_point: Number(e.target.value) })
            }
          />
        </FormRow>
        <FormRow label="الحد الأدنى للاستبدال (نقطة)">
          <input
            type="number"
            className="input w-full"
            value={form.min_redeem}
            onChange={(e) =>
              setForm({ ...form, min_redeem: Number(e.target.value) })
            }
          />
        </FormRow>
        <FormRow
          label="أقصى نسبة استبدال من قيمة الفاتورة (0–1)"
          help="مثال: 0.9 يعني استبدال أقصاه 90٪ من الفاتورة"
        >
          <input
            type="number"
            step="0.05"
            min={0}
            max={1}
            className="input w-full"
            value={form.max_redeem_ratio}
            onChange={(e) =>
              setForm({ ...form, max_redeem_ratio: Number(e.target.value) })
            }
          />
        </FormRow>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            disabled={save.isPending}
            onClick={() => save.mutate()}
            className="btn-primary"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

function FormRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-600 mb-1 block">
        {label}
      </label>
      {children}
      {help && <div className="text-[11px] text-slate-400 mt-1">{help}</div>}
    </div>
  );
}

function HistoryModal({
  customer,
  onClose,
}: {
  customer: LoyaltyCustomerRow;
  onClose: () => void;
}) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['loyalty-history', customer.id],
    queryFn: () => loyaltyApi.history(customer.id, 200),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-2xl space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">
            سجل النقاط — {customer.full_name}
          </h2>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>
        {isLoading ? (
          <div className="p-6 text-center text-slate-400">جاري التحميل…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-slate-400">
            لا توجد حركات على هذا الحساب
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-2 text-right">الوقت</th>
                <th className="p-2 text-right">العملية</th>
                <th className="p-2 text-right">النقاط</th>
                <th className="p-2 text-right">السبب</th>
                <th className="p-2 text-right">بواسطة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="p-2 text-xs font-mono text-slate-500">
                    {new Date(r.created_at).toLocaleString('en-US')}
                  </td>
                  <td className="p-2 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        r.direction === 'in'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-rose-50 text-rose-700'
                      }`}
                    >
                      {r.direction === 'in' ? 'إضافة' : 'خصم'}
                    </span>
                  </td>
                  <td className="p-2 font-bold">{r.points}</td>
                  <td className="p-2 text-xs text-slate-600">
                    {r.reason || '—'}
                  </td>
                  <td className="p-2 text-xs text-slate-500">
                    {r.full_name || r.username || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
