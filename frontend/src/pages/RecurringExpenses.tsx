import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Repeat,
  Plus,
  Pause,
  Play,
  Trash2,
  Zap,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  X,
  DollarSign,
} from 'lucide-react';
import {
  recurringExpensesApi,
  RecurringExpense,
  CreateRecurringExpenseInput,
  Frequency,
} from '@/api/recurringExpenses.api';
import { accountingApi } from '@/api/accounting.api';
import { settingsApi } from '@/api/settings.api';

const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'يومي',
  weekly: 'أسبوعي',
  biweekly: 'كل أسبوعين',
  monthly: 'شهري',
  quarterly: 'ربع سنوي',
  semiannual: 'نصف سنوي',
  annual: 'سنوي',
  custom_days: 'مخصص',
};

export default function RecurringExpenses() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RecurringExpense | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['recurring-expenses', statusFilter],
    queryFn: () =>
      recurringExpensesApi.list(statusFilter ? { status: statusFilter } : {}),
  });

  const { data: stats } = useQuery({
    queryKey: ['recurring-expenses-stats'],
    queryFn: recurringExpensesApi.stats,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['recurring-expenses'] });
    qc.invalidateQueries({ queryKey: ['recurring-expenses-stats'] });
  };

  const pauseM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.pause(id),
    onSuccess: () => {
      toast.success('تم الإيقاف المؤقت');
      invalidate();
    },
  });
  const resumeM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.resume(id),
    onSuccess: () => {
      toast.success('تم الاستئناف');
      invalidate();
    },
  });
  const removeM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.remove(id),
    onSuccess: () => {
      toast.success('تم الإنهاء');
      invalidate();
    },
  });
  const runM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.run(id),
    onSuccess: (r: any) => {
      if (r.generated) toast.success('تم توليد المصروف');
      else toast(`${r.reason || 'لم يُولد'}`);
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message || 'فشل التوليد'),
  });
  const processDueM = useMutation({
    mutationFn: () => recurringExpensesApi.processDue(),
    onSuccess: (r) => {
      toast.success(`تم: ${r.ok} نجاح · ${r.failed} فشل (من ${r.total})`);
      invalidate();
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Repeat className="text-brand-600" /> المصروفات الدورية
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            قوالب المصروفات المتكررة (إيجار، رواتب، اشتراكات، كهرباء…) — تُولَّد تلقائياً
            عند حلول الموعد.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            disabled={processDueM.isPending}
            onClick={() => processDueM.mutate()}
          >
            {processDueM.isPending ? (
              <RefreshCw size={16} className="animate-spin" />
            ) : (
              <Zap size={16} />
            )}
            <span>معالجة المستحق</span>
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Plus size={16} /> قالب جديد
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="نشطة" value={stats.active_templates} color="bg-emerald-100 text-emerald-800" icon={<CheckCircle2 size={16} />} />
          <StatCard label="متوقفة" value={stats.paused_templates} color="bg-amber-100 text-amber-800" icon={<Pause size={16} />} />
          <StatCard label="مستحق الآن" value={stats.due_now} color="bg-rose-100 text-rose-800" icon={<AlertTriangle size={16} />} />
          <StatCard label="خلال 7 أيام" value={stats.due_next_7_days} color="bg-sky-100 text-sky-800" icon={<Clock size={16} />} />
          <StatCard
            label="الالتزامات (تقديري)"
            value={Number(stats.monthly_commitment_estimate).toLocaleString('en-EG')}
            color="bg-brand-100 text-brand-800"
            icon={<DollarSign size={16} />}
          />
        </div>
      )}

      {/* Filters */}
      <div className="card p-4 flex gap-2 items-center">
        <span className="text-sm text-slate-500">عرض:</span>
        {[
          { v: '', label: 'الكل (غير المنتهية)' },
          { v: 'active', label: 'نشطة' },
          { v: 'paused', label: 'متوقفة' },
          { v: 'ended', label: 'منتهية' },
        ].map((f) => (
          <button
            key={f.v}
            onClick={() => setStatusFilter(f.v)}
            className={`px-3 py-1 rounded-lg text-sm ${
              statusFilter === f.v
                ? 'bg-brand-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-slate-400">
            <RefreshCw className="animate-spin mx-auto mb-2" />
            جارٍ التحميل…
          </div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-slate-400">لا توجد قوالب</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-right px-3 py-2">الرمز</th>
                <th className="text-right px-3 py-2">الاسم</th>
                <th className="text-right px-3 py-2">الفئة</th>
                <th className="text-right px-3 py-2">التكرار</th>
                <th className="text-right px-3 py-2">المبلغ</th>
                <th className="text-right px-3 py-2">التاريخ القادم</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="text-right px-3 py-2">عدد المرّات</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                  <td className="px-3 py-2 font-bold">{r.name_ar}</td>
                  <td className="px-3 py-2">{r.category_name || '—'}</td>
                  <td className="px-3 py-2">{FREQUENCY_LABEL[r.frequency]}</td>
                  <td className="px-3 py-2 font-mono">
                    {Number(r.amount).toLocaleString('en-EG')} ج.م
                  </td>
                  <td className="px-3 py-2">
                    <DueBadge
                      date={r.next_run_date}
                      status={r.due_status}
                      daysOverdue={r.days_overdue}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-center">{r.runs_count}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 justify-end">
                      <button
                        className="icon-btn"
                        title="توليد الآن"
                        onClick={() => runM.mutate(r.id)}
                        disabled={r.status !== 'active' || runM.isPending}
                      >
                        <Zap size={14} />
                      </button>
                      {r.status === 'active' ? (
                        <button
                          className="icon-btn"
                          title="إيقاف مؤقت"
                          onClick={() => pauseM.mutate(r.id)}
                        >
                          <Pause size={14} />
                        </button>
                      ) : r.status === 'paused' ? (
                        <button
                          className="icon-btn"
                          title="استئناف"
                          onClick={() => resumeM.mutate(r.id)}
                        >
                          <Play size={14} />
                        </button>
                      ) : null}
                      <button
                        className="icon-btn text-rose-600"
                        title="إنهاء"
                        onClick={() => {
                          if (confirm(`إنهاء القالب "${r.name_ar}"؟`)) removeM.mutate(r.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <RecurringExpenseFormModal
          onClose={() => setShowForm(false)}
          editing={editing}
          onSaved={() => {
            invalidate();
            setShowForm(false);
          }}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number | string;
  color: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl p-3 ${color}`}>
      <div className="text-xs opacity-80 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="font-black text-2xl mt-1">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-800',
    paused: 'bg-amber-100 text-amber-800',
    ended: 'bg-slate-200 text-slate-700',
  };
  const label: Record<string, string> = {
    active: 'نشطة',
    paused: 'متوقفة',
    ended: 'منتهية',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${map[status] || ''}`}>
      {label[status] || status}
    </span>
  );
}

function DueBadge({
  date,
  status,
  daysOverdue,
}: {
  date: string;
  status?: string;
  daysOverdue?: number;
}) {
  const cls =
    status === 'due'
      ? 'bg-rose-100 text-rose-800'
      : status === 'upcoming'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-slate-100 text-slate-600';
  return (
    <div>
      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${cls}`}>
        {date}
      </span>
      {status === 'due' && daysOverdue != null && daysOverdue > 0 && (
        <div className="text-[10px] text-rose-700 mt-0.5">
          متأخر {daysOverdue} يوم
        </div>
      )}
    </div>
  );
}

// --------- Form Modal ---------

function RecurringExpenseFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: RecurringExpense | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CreateRecurringExpenseInput>({
    code: editing?.code || '',
    name_ar: editing?.name_ar || '',
    name_en: editing?.name_en || '',
    category_id: editing?.category_id || '',
    warehouse_id: editing?.warehouse_id || '',
    cashbox_id: editing?.cashbox_id || undefined,
    amount: editing?.amount || 0,
    payment_method: editing?.payment_method || 'cash',
    vendor_name: editing?.vendor_name || '',
    description: editing?.description || '',
    frequency: editing?.frequency || 'monthly',
    custom_interval_days: editing?.custom_interval_days,
    day_of_month: editing?.day_of_month,
    start_date: editing?.start_date || new Date().toISOString().slice(0, 10),
    end_date: editing?.end_date,
    auto_post: editing?.auto_post ?? true,
    auto_paid: editing?.auto_paid ?? false,
    notify_days_before: editing?.notify_days_before ?? 3,
    require_approval: editing?.require_approval ?? false,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: accountingApi.categories,
  });

  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: async () => {
      try {
        return await settingsApi.listWarehouses();
      } catch {
        return [];
      }
    },
  });

  const saveM = useMutation({
    mutationFn: () =>
      editing
        ? recurringExpensesApi.update(editing.id, form)
        : recurringExpensesApi.create(form),
    onSuccess: () => {
      toast.success(editing ? 'تم التحديث' : 'تم الإنشاء');
      onSaved();
    },
    onError: (e: any) => toast.error(e?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h3 className="font-black text-lg">
            {editing ? 'تعديل قالب مصروف' : 'قالب مصروف دوري جديد'}
          </h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="الرمز" required>
              <input
                className="input"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="RENT-CAIRO-01"
              />
            </Field>
            <Field label="الاسم بالعربية" required>
              <input
                className="input"
                value={form.name_ar}
                onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="الفئة" required>
              <select
                className="input"
                value={form.category_id}
                onChange={(e) => setForm({ ...form, category_id: e.target.value })}
              >
                <option value="">— اختر —</option>
                {categories.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.name_ar}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="المخزن" required>
              <select
                className="input"
                value={form.warehouse_id}
                onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}
              >
                <option value="">— اختر —</option>
                {warehouses.map((w: any) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="المبلغ" required>
              <input
                type="number"
                className="input"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
              />
            </Field>
            <Field label="طريقة الدفع">
              <select
                className="input"
                value={form.payment_method}
                onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
              >
                <option value="cash">نقدي</option>
                <option value="card">بطاقة</option>
                <option value="instapay">انستاباي</option>
                <option value="wallet">محفظة</option>
                <option value="bank_transfer">حوالة</option>
              </select>
            </Field>
            <Field label="اسم المستفيد">
              <input
                className="input"
                value={form.vendor_name || ''}
                onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="التكرار" required>
              <select
                className="input"
                value={form.frequency}
                onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}
              >
                {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </select>
            </Field>
            {form.frequency === 'custom_days' && (
              <Field label="كل كم يوم؟">
                <input
                  type="number"
                  className="input"
                  value={form.custom_interval_days || ''}
                  onChange={(e) =>
                    setForm({ ...form, custom_interval_days: Number(e.target.value) })
                  }
                />
              </Field>
            )}
            {['monthly', 'quarterly', 'semiannual', 'annual'].includes(form.frequency) && (
              <Field label="يوم الشهر (1..31)">
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="input"
                  value={form.day_of_month || ''}
                  onChange={(e) =>
                    setForm({ ...form, day_of_month: Number(e.target.value) || undefined })
                  }
                />
              </Field>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="تاريخ البداية" required>
              <input
                type="date"
                className="input"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              />
            </Field>
            <Field label="تاريخ الانتهاء (اختياري)">
              <input
                type="date"
                className="input"
                value={form.end_date || ''}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              />
            </Field>
            <Field label="تنبيه قبل (أيام)">
              <input
                type="number"
                className="input"
                value={form.notify_days_before}
                onChange={(e) =>
                  setForm({ ...form, notify_days_before: Number(e.target.value) })
                }
              />
            </Field>
          </div>

          <Field label="الوصف">
            <textarea
              className="input"
              rows={2}
              value={form.description || ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.auto_post}
                onChange={(e) => setForm({ ...form, auto_post: e.target.checked })}
              />
              اعتماد تلقائي عند التوليد
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.auto_paid}
                onChange={(e) => setForm({ ...form, auto_paid: e.target.checked })}
              />
              خصم من الصندوق تلقائياً (فورياً)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.require_approval}
                onChange={(e) => setForm({ ...form, require_approval: e.target.checked })}
              />
              يتطلب اعتماد يدوي
            </label>
          </div>
        </div>

        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>إلغاء</button>
          <button
            className="btn-primary"
            disabled={saveM.isPending || !form.code || !form.name_ar || !form.category_id || !form.warehouse_id}
            onClick={() => saveM.mutate()}
          >
            {saveM.isPending ? 'جارٍ الحفظ…' : editing ? 'تحديث' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-bold text-slate-600 block mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}
