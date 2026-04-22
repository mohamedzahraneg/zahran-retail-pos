import { useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  DollarSign,
  Inbox,
  ShieldCheck,
  Plus,
  Trash2,
  Check,
  X as XIcon,
  Banknote,
  Edit3,
} from 'lucide-react';

import { accountsApi, CurrencyRate } from '@/api/accounts.api';
import {
  accountingApi,
  ApprovalRule,
  ApprovalInboxItem,
  CreateApprovalRulePayload,
} from '@/api/accounting.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

type Tab = 'fx' | 'inbox' | 'rules';

/**
 * Financial controls: FX rates + monthly revaluation, expense
 * approval inbox, and the rule configuration for the workflow engine.
 */
export default function FinancialControls() {
  const [tab, setTab] = useState<Tab>('inbox');

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
          <ShieldCheck className="text-brand-600" /> ضوابط مالية
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          اعتمادات المصروفات · أسعار الصرف · إعادة التقييم
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="flex flex-wrap gap-2 p-3 border-b border-slate-200">
          <TabBtn
            active={tab === 'inbox'}
            onClick={() => setTab('inbox')}
            icon={<Inbox className="w-4 h-4" />}
            label="صندوق الاعتمادات"
          />
          <TabBtn
            active={tab === 'rules'}
            onClick={() => setTab('rules')}
            icon={<ShieldCheck className="w-4 h-4" />}
            label="قواعد الاعتماد"
          />
          <TabBtn
            active={tab === 'fx'}
            onClick={() => setTab('fx')}
            icon={<DollarSign className="w-4 h-4" />}
            label="أسعار الصرف"
          />
        </div>
        <div className="p-4">
          {tab === 'inbox' && <InboxTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'fx' && <FxTab />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 transition ${
        active
          ? 'bg-indigo-600 text-white shadow'
          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Approval Inbox
// ═══════════════════════════════════════════════════════════════════════

function InboxTab() {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['approval-inbox'],
    queryFn: () => accountingApi.approvalInbox(),
    refetchInterval: 30_000,
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => accountingApi.approveApproval(id),
    onSuccess: () => {
      toast.success('تم الاعتماد');
      qc.invalidateQueries({ queryKey: ['approval-inbox'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الاعتماد'),
  });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      accountingApi.rejectApproval(id, reason),
    onSuccess: () => {
      toast.success('تم الرفض');
      qc.invalidateQueries({ queryKey: ['approval-inbox'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الرفض'),
  });

  if (isLoading) {
    return (
      <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="py-12 text-center">
        <Inbox size={40} className="mx-auto text-slate-300 mb-3" />
        <div className="text-slate-500">لا توجد اعتمادات منتظرة</div>
        <div className="text-xs text-slate-400 mt-1">
          أي مصروف يتجاوز حد قاعدة اعتماد نشطة سيظهر هنا
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-600">
        {items.length} اعتماد منتظر قرارك
      </div>
      <div className="grid lg:grid-cols-2 gap-3">
        {items.map((it) => (
          <ApprovalCard
            key={it.id}
            item={it}
            onApprove={() => approveMut.mutate(it.id)}
            onReject={() => {
              const r = prompt('سبب الرفض:');
              if (r && r.trim().length >= 3) {
                rejectMut.mutate({ id: it.id, reason: r });
              }
            }}
            pending={approveMut.isPending || rejectMut.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({
  item,
  onApprove,
  onReject,
  pending,
}: {
  item: ApprovalInboxItem;
  onApprove: () => void;
  onReject: () => void;
  pending: boolean;
}) {
  return (
    <div className="card p-4 border-2 border-amber-200 bg-amber-50/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-brand-700">
              {item.expense_no}
            </span>
            <span className="chip bg-amber-100 text-amber-800 text-[10px]">
              المستوى {item.level}
            </span>
            <span className="chip bg-slate-100 text-slate-600 text-[10px]">
              {item.rule_name}
            </span>
          </div>
          <div className="font-black text-lg mt-1">
            {EGP(item.amount)}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            {item.category_name || 'بدون تصنيف'}
            {item.warehouse_name && ` · ${item.warehouse_name}`}
            {item.vendor_name && ` · المورد: ${item.vendor_name}`}
          </div>
          {item.description && (
            <div className="text-xs text-slate-500 mt-1">{item.description}</div>
          )}
          <div className="text-[11px] text-slate-400 mt-2">
            أنشأها {item.created_by_name || '—'} ·{' '}
            {new Date(item.created_at).toLocaleDateString('en-GB', {
              timeZone: 'Africa/Cairo',
            })}
          </div>
        </div>
      </div>
      <div className="flex gap-2 mt-3 pt-3 border-t border-amber-200">
        <button
          className="flex-1 py-2 rounded-lg bg-emerald-600 text-white font-bold hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-1"
          onClick={onApprove}
          disabled={pending}
        >
          <Check size={14} /> اعتماد
        </button>
        <button
          className="flex-1 py-2 rounded-lg bg-rose-600 text-white font-bold hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-1"
          onClick={onReject}
          disabled={pending}
        >
          <XIcon size={14} /> رفض
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Approval Rules
// ═══════════════════════════════════════════════════════════════════════

function RulesTab() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('accounts.approval.manage');
  const [editing, setEditing] = useState<ApprovalRule | 'new' | null>(null);

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['approval-rules'],
    queryFn: () => accountingApi.listApprovalRules(),
  });

  const del = useMutation({
    mutationFn: (id: string) => accountingApi.removeApprovalRule(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['approval-rules'] });
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-slate-600">
          {rules.length} قاعدة
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing('new')}>
            <Plus size={14} /> قاعدة جديدة
          </button>
        )}
      </div>
      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-bold text-slate-600">
              <tr>
                <th className="text-right px-3 py-2">الاسم</th>
                <th className="text-right px-3 py-2">الحد الأدنى</th>
                <th className="text-right px-3 py-2">الحد الأقصى</th>
                <th className="text-right px-3 py-2">الدور المطلوب</th>
                <th className="text-right px-3 py-2">المستوى</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.id}
                  className={`border-t border-slate-100 hover:bg-slate-50 ${
                    r.is_active ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2 font-bold">{r.name_ar}</td>
                  <td className="px-3 py-2 font-mono">
                    {EGP(r.min_amount)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {r.max_amount ? EGP(r.max_amount) : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className="chip bg-indigo-100 text-indigo-700">
                      {r.required_role}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">{r.level}</td>
                  <td className="px-3 py-2">
                    {r.is_active ? (
                      <span className="chip bg-emerald-100 text-emerald-700">
                        نشطة
                      </span>
                    ) : (
                      <span className="chip bg-slate-100 text-slate-600">
                        معطّلة
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {canManage && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => setEditing(r)}
                          className="p-1 hover:bg-slate-200 rounded text-slate-500"
                        >
                          <Edit3 size={12} />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`حذف "${r.name_ar}"؟`)) {
                              del.mutate(r.id);
                            }
                          }}
                          className="p-1 hover:bg-rose-100 rounded text-rose-600"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    لا توجد قواعد. المصروفات ستعتمد تلقائياً بدون سير اعتماد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  onClose,
}: {
  rule: ApprovalRule | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = !rule;
  const [form, setForm] = useState<CreateApprovalRulePayload & { is_active?: boolean }>({
    name_ar: rule?.name_ar || '',
    min_amount: Number(rule?.min_amount || 0),
    max_amount: rule?.max_amount ? Number(rule.max_amount) : null,
    required_role: rule?.required_role || 'manager',
    level: rule?.level || 1,
    notes: rule?.notes || '',
    is_active: rule?.is_active ?? true,
  });

  const mut = useMutation({
    mutationFn: () => {
      const payload = { ...form };
      if (isNew) return accountingApi.createApprovalRule(payload);
      return accountingApi.updateApprovalRule(rule!.id, payload);
    },
    onSuccess: () => {
      toast.success('تم الحفظ');
      qc.invalidateQueries({ queryKey: ['approval-rules'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <h3 className="font-black text-lg">
            {isNew ? 'قاعدة اعتماد جديدة' : `تعديل ${rule?.name_ar}`}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
          >
            <XIcon size={20} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              الاسم
            </span>
            <input
              className="input"
              value={form.name_ar}
              onChange={(e) =>
                setForm({ ...form, name_ar: e.target.value })
              }
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                الحد الأدنى (ج.م)
              </span>
              <input
                type="number"
                step="0.01"
                min={0}
                className="input"
                value={form.min_amount}
                onChange={(e) =>
                  setForm({
                    ...form,
                    min_amount: Number(e.target.value) || 0,
                  })
                }
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                الحد الأقصى (اختياري)
              </span>
              <input
                type="number"
                step="0.01"
                min={0}
                className="input"
                value={form.max_amount ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    max_amount: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                الدور المطلوب
              </span>
              <select
                className="input"
                value={form.required_role}
                onChange={(e) =>
                  setForm({ ...form, required_role: e.target.value })
                }
              >
                <option value="manager">مدير</option>
                <option value="admin">admin</option>
                <option value="accountant">محاسب</option>
                <option value="owner">المالك</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                المستوى
              </span>
              <input
                type="number"
                min={1}
                max={5}
                className="input"
                value={form.level}
                onChange={(e) =>
                  setForm({ ...form, level: Number(e.target.value) || 1 })
                }
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.is_active}
              onChange={(e) =>
                setForm({ ...form, is_active: e.target.checked })
              }
            />
            نشطة
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              ملاحظات
            </span>
            <textarea
              className="input"
              rows={2}
              value={form.notes || ''}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          <div className="flex gap-2 pt-2 border-t border-slate-100">
            <button
              className="btn-primary flex-1"
              onClick={() => mut.mutate()}
              disabled={mut.isPending || !form.name_ar}
            >
              حفظ
            </button>
            <button className="btn-secondary" onClick={onClose}>
              إلغاء
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  FX Rates
// ═══════════════════════════════════════════════════════════════════════

function FxTab() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('accounts.fx');
  const [currency, setCurrency] = useState('');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [newRate, setNewRate] = useState({
    currency: 'USD',
    rate_date: todayISO,
    rate_to_egp: 0,
    source: 'CBE',
  });

  const { data: rates = [] } = useQuery({
    queryKey: ['fx-rates', currency],
    queryFn: () =>
      accountsApi.listRates({ currency: currency || undefined, limit: 200 }),
  });

  const upsertMut = useMutation({
    mutationFn: () => accountsApi.upsertRate(newRate),
    onSuccess: () => {
      toast.success('تم الحفظ');
      setNewRate({ ...newRate, rate_to_egp: 0 });
      qc.invalidateQueries({ queryKey: ['fx-rates'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const revalueMut = useMutation({
    mutationFn: (d: string) => accountsApi.revalue(d),
    onSuccess: (r) => {
      const posted = r.results.filter((x) => x.posted).length;
      const skipped = r.results.filter((x) => x.skipped).length;
      toast.success(`تم الترحيل لعدد ${posted} خزنة · تم تخطي ${skipped}`);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الترحيل'),
  });

  const del = useMutation({
    mutationFn: (id: string) => accountsApi.removeRate(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['fx-rates'] });
    },
  });

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="card p-4 border-2 border-indigo-200 bg-indigo-50/50">
          <div className="flex items-center gap-2 mb-3 font-bold text-sm">
            <Banknote size={16} /> تسجيل سعر صرف جديد
          </div>
          <div className="grid md:grid-cols-5 gap-3">
            <label className="block">
              <span className="text-xs text-slate-600 mb-1 block">العملة</span>
              <select
                className="input"
                value={newRate.currency}
                onChange={(e) =>
                  setNewRate({ ...newRate, currency: e.target.value })
                }
              >
                <option value="USD">دولار USD</option>
                <option value="EUR">يورو EUR</option>
                <option value="SAR">ريال SAR</option>
                <option value="AED">درهم AED</option>
                <option value="GBP">إسترليني GBP</option>
                <option value="KWD">دينار كويتي KWD</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-600 mb-1 block">التاريخ</span>
              <input
                type="date"
                className="input"
                value={newRate.rate_date}
                onChange={(e) =>
                  setNewRate({ ...newRate, rate_date: e.target.value })
                }
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-600 mb-1 block">
                السعر مقابل ج.م
              </span>
              <input
                type="number"
                step="0.0001"
                className="input"
                value={newRate.rate_to_egp}
                onChange={(e) =>
                  setNewRate({
                    ...newRate,
                    rate_to_egp: Number(e.target.value),
                  })
                }
                placeholder="مثال: 50.25"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-600 mb-1 block">المصدر</span>
              <select
                className="input"
                value={newRate.source}
                onChange={(e) =>
                  setNewRate({ ...newRate, source: e.target.value })
                }
              >
                <option value="CBE">البنك المركزي</option>
                <option value="bank">بنك تجاري</option>
                <option value="manual">يدوي</option>
                <option value="market">السوق الموازية</option>
              </select>
            </label>
            <button
              className="btn-primary self-end"
              disabled={upsertMut.isPending || !newRate.rate_to_egp}
              onClick={() => upsertMut.mutate()}
            >
              حفظ السعر
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              className="btn-secondary"
              disabled={revalueMut.isPending}
              onClick={() => {
                if (
                  confirm(
                    `إعادة تقييم كل الخزائن الأجنبية بأسعار اليوم (${todayISO})؟\n\nسيتم ترحيل قيد فرق صرف تلقائياً لكل خزنة.`,
                  )
                ) {
                  revalueMut.mutate(todayISO);
                }
              }}
            >
              🔄 إعادة تقييم الآن (اليوم)
            </button>
            <span className="text-xs text-slate-500">
              أو انتظر آخر يوم في الشهر للترحيل التلقائي
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="text-sm">تصفية بالعملة:</label>
        <select
          className="input w-40"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        >
          <option value="">الكل</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="SAR">SAR</option>
          <option value="AED">AED</option>
          <option value="GBP">GBP</option>
          <option value="KWD">KWD</option>
        </select>
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs font-bold text-slate-600">
            <tr>
              <th className="text-right px-3 py-2">التاريخ</th>
              <th className="text-right px-3 py-2">العملة</th>
              <th className="text-right px-3 py-2">السعر مقابل ج.م</th>
              <th className="text-right px-3 py-2">المصدر</th>
              <th className="text-right px-3 py-2">بواسطة</th>
              <th className="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r: CurrencyRate) => (
              <tr
                key={r.id}
                className="border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-3 py-2 font-mono text-xs">{r.rate_date}</td>
                <td className="px-3 py-2 font-bold">{r.currency}</td>
                <td className="px-3 py-2 font-mono">
                  {Number(r.rate_to_egp).toFixed(4)}
                </td>
                <td className="px-3 py-2 text-xs">{r.source || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {r.created_by_name || '—'}
                </td>
                <td className="px-3 py-2">
                  {canManage && (
                    <button
                      onClick={() => {
                        if (confirm('حذف هذا السعر؟')) del.mutate(r.id);
                      }}
                      className="p-1 hover:bg-rose-100 rounded text-rose-600"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rates.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-10 text-slate-400">
                  لا توجد أسعار مسجلة — ابدأ بإدخال سعر العملة اليوم
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
