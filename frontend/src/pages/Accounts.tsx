import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  Plus,
  X,
  Trash2,
  Edit3,
  Ban,
  Wallet,
  FileText,
  Lock,
  TreePine,
  Scale,
} from 'lucide-react';

import {
  accountsApi,
  Account,
  AccountType,
  JournalEntry,
  CreateAccountPayload,
  CreateJournalPayload,
} from '@/api/accounts.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'أصل',
  liability: 'خصم',
  equity: 'حقوق ملكية',
  revenue: 'إيراد',
  expense: 'مصروف',
};

const TYPE_COLORS: Record<AccountType, string> = {
  asset: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  liability: 'bg-rose-100 text-rose-800 border-rose-200',
  equity: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  revenue: 'bg-sky-100 text-sky-800 border-sky-200',
  expense: 'bg-amber-100 text-amber-800 border-amber-200',
};

type Tab = 'tree' | 'journal' | 'trial';

export default function Accounts() {
  const [tab, setTab] = useState<Tab>('tree');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <BookOpen className="text-brand-600" /> شجرة الحسابات والقيود
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            هيكل حسابات القيد المزدوج — كل عملية في النظام تُسجَّل مدين/دائن
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="flex flex-wrap gap-2 p-3 border-b border-slate-200">
          <TabBtn
            active={tab === 'tree'}
            onClick={() => setTab('tree')}
            icon={<TreePine className="w-4 h-4" />}
            label="شجرة الحسابات"
          />
          <TabBtn
            active={tab === 'journal'}
            onClick={() => setTab('journal')}
            icon={<FileText className="w-4 h-4" />}
            label="القيود اليومية"
          />
          <TabBtn
            active={tab === 'trial'}
            onClick={() => setTab('trial')}
            icon={<Scale className="w-4 h-4" />}
            label="ميزان المراجعة"
          />
        </div>
        <div className="p-4">
          {tab === 'tree' && <ChartTree />}
          {tab === 'journal' && <JournalTab />}
          {tab === 'trial' && <TrialBalanceTab />}
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
//  Chart of Accounts — tree view
// ═══════════════════════════════════════════════════════════════════════

function ChartTree() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('accounts.chart.manage');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createFor, setCreateFor] = useState<Account | null | 'root'>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [filterType, setFilterType] = useState<AccountType | ''>('');
  const [q, setQ] = useState('');

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['coa', includeInactive],
    queryFn: () => accountsApi.list(includeInactive),
  });

  // Build tree (accounts flat → map by parent_id)
  const tree = useMemo(() => {
    const byParent: Record<string, Account[]> = {};
    const ids = new Set<string>();
    const filtered = accounts.filter((a) => {
      if (filterType && a.account_type !== filterType) return false;
      if (q) {
        const s = q.toLowerCase();
        return (
          a.code.toLowerCase().includes(s) ||
          a.name_ar.toLowerCase().includes(s) ||
          (a.name_en || '').toLowerCase().includes(s)
        );
      }
      return true;
    });
    filtered.forEach((a) => ids.add(a.id));
    filtered.forEach((a) => {
      const key = a.parent_id && ids.has(a.parent_id) ? a.parent_id : '__root__';
      (byParent[key] ||= []).push(a);
    });
    // sort by code
    for (const k of Object.keys(byParent)) {
      byParent[k].sort((a, b) => a.code.localeCompare(b.code));
    }
    return byParent;
  }, [accounts, filterType, q]);

  // Default-expand top-level on first load
  useMemo(() => {
    if (accounts.length && expanded.size === 0) {
      const top = accounts.filter((a) => a.level === 1).map((a) => a.id);
      setExpanded(new Set(top));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length]);

  const toggle = (id: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  if (isLoading) {
    return (
      <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          className="input flex-1 min-w-[200px]"
          placeholder="بحث بالكود أو الاسم..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="input w-48"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as any)}
        >
          <option value="">كل الأنواع</option>
          <option value="asset">أصول</option>
          <option value="liability">خصوم</option>
          <option value="equity">حقوق ملكية</option>
          <option value="revenue">إيرادات</option>
          <option value="expense">مصروفات</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          إظهار المعطّل
        </label>
        {canManage && (
          <button
            className="btn-primary"
            onClick={() => setCreateFor('root')}
          >
            <Plus size={16} /> حساب رئيسي
          </button>
        )}
      </div>

      {/* Tree */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        {(tree['__root__'] || []).map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            childrenByParent={tree}
            expanded={expanded}
            toggle={toggle}
            canManage={canManage}
            onAddChild={(p) => setCreateFor(p)}
            onEdit={(a) => setEditing(a)}
          />
        ))}
        {(tree['__root__'] || []).length === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm">
            لا توجد حسابات تطابق البحث
          </div>
        )}
      </div>

      {/* Create modal */}
      {createFor !== null && (
        <AccountFormModal
          parent={createFor === 'root' ? null : createFor}
          onClose={() => setCreateFor(null)}
        />
      )}
      {editing && (
        <AccountEditModal
          account={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AccountRow({
  account,
  childrenByParent,
  expanded,
  toggle,
  canManage,
  onAddChild,
  onEdit,
}: {
  account: Account;
  childrenByParent: Record<string, Account[]>;
  expanded: Set<string>;
  toggle: (id: string) => void;
  canManage: boolean;
  onAddChild: (a: Account) => void;
  onEdit: (a: Account) => void;
}) {
  const qc = useQueryClient();
  const kids = childrenByParent[account.id] || [];
  const isOpen = expanded.has(account.id);
  const hasKids = kids.length > 0;

  const del = useMutation({
    mutationFn: () => accountsApi.remove(account.id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['coa'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحذف'),
  });

  const indent = (account.level - 1) * 20;
  const balance = Number(account.balance || 0);
  const badge = TYPE_COLORS[account.account_type];

  return (
    <>
      <div
        className={`flex items-center gap-2 py-2.5 px-3 border-b border-slate-100 hover:bg-slate-50/60 transition ${
          account.is_active ? '' : 'opacity-60'
        }`}
        style={{ paddingInlineStart: 12 + indent }}
      >
        {hasKids ? (
          <button
            onClick={() => toggle(account.id)}
            className="p-0.5 rounded hover:bg-slate-200 text-slate-500 shrink-0"
          >
            {isOpen ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronLeft size={14} />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        <span className="font-mono font-bold text-slate-600 text-sm min-w-[60px]">
          {account.code}
        </span>
        <span className="font-bold text-slate-800 text-sm truncate flex-1">
          {account.name_ar}
        </span>
        <span className={`chip text-[10px] ${badge}`}>
          {TYPE_LABELS[account.account_type]}
        </span>
        {account.is_system && (
          <span
            className="chip bg-slate-100 text-slate-600 text-[10px]"
            title="حساب نظامي — لا يمكن حذفه"
          >
            <Lock size={10} /> نظامي
          </span>
        )}
        {account.cashbox_id && (
          <span className="chip bg-brand-50 text-brand-700 text-[10px]">
            <Wallet size={10} /> {account.cashbox_name || 'خزنة'}
          </span>
        )}
        <span
          className={`font-mono font-bold text-sm tabular-nums min-w-[120px] text-left ${
            balance > 0
              ? 'text-emerald-700'
              : balance < 0
                ? 'text-rose-700'
                : 'text-slate-400'
          }`}
        >
          {EGP(balance)}
        </span>
        {canManage && (
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => onAddChild(account)}
              className="p-1 hover:bg-slate-200 rounded text-slate-500"
              title="إضافة حساب فرعي"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => onEdit(account)}
              className="p-1 hover:bg-slate-200 rounded text-slate-500"
              title="تعديل"
            >
              <Edit3 size={14} />
            </button>
            {!account.is_system && (
              <button
                onClick={() => {
                  if (confirm(`حذف الحساب "${account.name_ar}"؟`)) {
                    del.mutate();
                  }
                }}
                className="p-1 hover:bg-rose-100 rounded text-rose-600"
                title="حذف"
                disabled={del.isPending}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>
      {isOpen &&
        kids.map((kid) => (
          <AccountRow
            key={kid.id}
            account={kid}
            childrenByParent={childrenByParent}
            expanded={expanded}
            toggle={toggle}
            canManage={canManage}
            onAddChild={onAddChild}
            onEdit={onEdit}
          />
        ))}
    </>
  );
}

function AccountFormModal({
  parent,
  onClose,
}: {
  parent: Account | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CreateAccountPayload>({
    code: '',
    name_ar: '',
    name_en: '',
    account_type: parent?.account_type || 'asset',
    parent_id: parent?.id,
  });

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
  });

  const mutation = useMutation({
    mutationFn: () => accountsApi.create(form),
    onSuccess: () => {
      toast.success('تم إضافة الحساب');
      qc.invalidateQueries({ queryKey: ['coa'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإضافة'),
  });

  return (
    <Modal
      title={parent ? `حساب فرعي تحت "${parent.name_ar}"` : 'حساب رئيسي جديد'}
      onClose={onClose}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="الكود">
            <input
              className="input"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder={parent ? `${parent.code}X` : '1, 2, ...'}
              autoFocus
            />
          </Field>
          <Field label="النوع">
            <select
              className="input"
              value={form.account_type}
              onChange={(e) =>
                setForm({ ...form, account_type: e.target.value as any })
              }
              disabled={!!parent}
            >
              <option value="asset">أصل</option>
              <option value="liability">خصم</option>
              <option value="equity">حقوق ملكية</option>
              <option value="revenue">إيراد</option>
              <option value="expense">مصروف</option>
            </select>
          </Field>
        </div>
        <Field label="الاسم بالعربية">
          <input
            className="input"
            value={form.name_ar}
            onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
          />
        </Field>
        <Field label="الاسم بالإنجليزية (اختياري)">
          <input
            className="input"
            value={form.name_en || ''}
            onChange={(e) => setForm({ ...form, name_en: e.target.value })}
          />
        </Field>
        <Field label="ربط بخزنة (اختياري)">
          <select
            className="input"
            value={form.cashbox_id || ''}
            onChange={(e) =>
              setForm({ ...form, cashbox_id: e.target.value || undefined })
            }
          >
            <option value="">—</option>
            {cashboxes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="وصف">
          <textarea
            className="input"
            rows={2}
            value={form.description || ''}
            onChange={(e) =>
              setForm({ ...form, description: e.target.value })
            }
          />
        </Field>
        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !form.code || !form.name_ar}
          >
            حفظ
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AccountEditModal({
  account,
  onClose,
}: {
  account: Account;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name_ar: account.name_ar,
    name_en: account.name_en || '',
    description: account.description || '',
    is_active: account.is_active,
    cashbox_id: account.cashbox_id,
  });
  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
  });

  const mutation = useMutation({
    mutationFn: () =>
      accountsApi.update(account.id, {
        name_ar: form.name_ar,
        name_en: form.name_en,
        description: form.description,
        is_active: form.is_active,
        cashbox_id: form.cashbox_id,
      }),
    onSuccess: () => {
      toast.success('تم الحفظ');
      qc.invalidateQueries({ queryKey: ['coa'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <Modal title={`تعديل "${account.name_ar}"`} onClose={onClose}>
      <div className="space-y-3">
        {account.is_system && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex gap-2">
            <Lock size={14} /> حساب نظامي — الاسم العربي والتعطيل معطّلان
          </div>
        )}
        <Field label="الاسم بالعربية">
          <input
            className="input"
            value={form.name_ar}
            onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
            disabled={account.is_system}
          />
        </Field>
        <Field label="الاسم بالإنجليزية">
          <input
            className="input"
            value={form.name_en}
            onChange={(e) => setForm({ ...form, name_en: e.target.value })}
          />
        </Field>
        <Field label="ربط بخزنة (اختياري)">
          <select
            className="input"
            value={form.cashbox_id || ''}
            onChange={(e) =>
              setForm({ ...form, cashbox_id: e.target.value || null })
            }
          >
            <option value="">—</option>
            {cashboxes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="وصف">
          <textarea
            className="input"
            rows={2}
            value={form.description}
            onChange={(e) =>
              setForm({ ...form, description: e.target.value })
            }
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.is_active}
            disabled={account.is_system}
            onChange={(e) =>
              setForm({ ...form, is_active: e.target.checked })
            }
          />
          مفعّل
        </label>
        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            حفظ
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Journal Entries
// ═══════════════════════════════════════════════════════════════════════

function JournalTab() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canPost = hasPermission('accounts.journal.post');
  const canVoid = hasPermission('accounts.journal.void');
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthStart = todayISO.slice(0, 7) + '-01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState<JournalEntry | null>(null);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['journal', from, to],
    queryFn: () => accountsApi.listJournal({ from, to, limit: 300 }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-slate-600">من</label>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="input w-40"
        />
        <label className="text-sm text-slate-600">إلى</label>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="input w-40"
        />
        {canPost && (
          <button
            className="btn-primary mr-auto"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={16} /> قيد جديد
          </button>
        )}
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50/60 text-slate-600 text-xs font-bold">
              <tr>
                <th className="text-right px-3 py-2">رقم القيد</th>
                <th className="text-right px-3 py-2">التاريخ</th>
                <th className="text-right px-3 py-2">الوصف</th>
                <th className="text-right px-3 py-2">المصدر</th>
                <th className="text-right px-3 py-2">مدين</th>
                <th className="text-right px-3 py-2">دائن</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="text-right px-3 py-2">المستخدم</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400">
                    جارٍ التحميل...
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400">
                    لا توجد قيود في هذه الفترة
                  </td>
                </tr>
              ) : (
                entries.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                    onClick={() => setViewing(e)}
                  >
                    <td className="px-3 py-2 font-mono font-bold text-brand-700">
                      {e.entry_no}
                    </td>
                    <td className="px-3 py-2 text-xs">{e.entry_date}</td>
                    <td className="px-3 py-2 max-w-xs truncate">
                      {e.description || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {e.reference_type || 'يدوي'}
                    </td>
                    <td className="px-3 py-2 font-mono font-bold text-emerald-700">
                      {EGP(e.total_debit || 0)}
                    </td>
                    <td className="px-3 py-2 font-mono font-bold text-rose-700">
                      {EGP(e.total_credit || 0)}
                    </td>
                    <td className="px-3 py-2">
                      {e.is_void ? (
                        <span className="chip bg-rose-100 text-rose-700">
                          ملغى
                        </span>
                      ) : e.is_posted ? (
                        <span className="chip bg-emerald-100 text-emerald-700">
                          مُرحّل
                        </span>
                      ) : (
                        <span className="chip bg-slate-100 text-slate-600">
                          مسوّدة
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {e.created_by_name || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <JournalCreateModal onClose={() => setShowCreate(false)} />
      )}
      {viewing && (
        <JournalViewModal
          entry={viewing}
          canVoid={canVoid}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function JournalCreateModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const todayISO = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<CreateJournalPayload>({
    entry_date: todayISO,
    description: '',
    lines: [
      { account_id: '', debit: 0, credit: 0 },
      { account_id: '', debit: 0, credit: 0 },
    ],
    post_immediately: true,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['coa', false],
    queryFn: () => accountsApi.list(false),
  });
  const leaves = useMemo(
    () => accounts.filter((a) => a.is_leaf && a.is_active),
    [accounts],
  );

  const updateLine = (i: number, patch: any) => {
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));
  };
  const addLine = () =>
    setForm((f) => ({
      ...f,
      lines: [...f.lines, { account_id: '', debit: 0, credit: 0 }],
    }));
  const removeLine = (i: number) =>
    setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }));

  const totalDebit = form.lines.reduce(
    (s, l) => s + Number(l.debit || 0),
    0,
  );
  const totalCredit = form.lines.reduce(
    (s, l) => s + Number(l.credit || 0),
    0,
  );
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  const mutation = useMutation({
    mutationFn: () => accountsApi.createJournal(form),
    onSuccess: () => {
      toast.success('تم حفظ القيد');
      qc.invalidateQueries({ queryKey: ['journal'] });
      qc.invalidateQueries({ queryKey: ['coa'] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل حفظ القيد'),
  });

  return (
    <Modal title="قيد يومي جديد" onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="التاريخ">
            <input
              type="date"
              className="input"
              value={form.entry_date}
              onChange={(e) =>
                setForm({ ...form, entry_date: e.target.value })
              }
            />
          </Field>
          <Field label="الوصف">
            <input
              className="input"
              value={form.description || ''}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="موضوع القيد..."
            />
          </Field>
        </div>

        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="bg-slate-50 px-3 py-2 font-bold text-sm">
            سطور القيد
          </div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="text-right px-2 py-1.5">الحساب</th>
                <th className="text-right px-2 py-1.5">البيان</th>
                <th className="text-right px-2 py-1.5 w-28">مدين</th>
                <th className="text-right px-2 py-1.5 w-28">دائن</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {form.lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-2 py-1">
                    <select
                      className="input text-xs"
                      value={l.account_id}
                      onChange={(e) =>
                        updateLine(i, { account_id: e.target.value })
                      }
                    >
                      <option value="">—</option>
                      {leaves.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name_ar}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className="input text-xs"
                      value={l.description || ''}
                      onChange={(e) =>
                        updateLine(i, { description: e.target.value })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      step="0.01"
                      className="input text-xs"
                      value={l.debit || ''}
                      onChange={(e) =>
                        updateLine(i, {
                          debit: Number(e.target.value) || 0,
                          credit: 0,
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      step="0.01"
                      className="input text-xs"
                      value={l.credit || ''}
                      onChange={(e) =>
                        updateLine(i, {
                          credit: Number(e.target.value) || 0,
                          debit: 0,
                        })
                      }
                    />
                  </td>
                  <td className="px-1 py-1">
                    {form.lines.length > 2 && (
                      <button
                        onClick={() => removeLine(i)}
                        className="p-1 hover:bg-rose-100 rounded text-rose-600"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-2 flex items-center justify-between border-t border-slate-200 bg-slate-50">
            <button
              type="button"
              className="text-xs text-brand-600 hover:underline"
              onClick={addLine}
            >
              + إضافة سطر
            </button>
            <div className="flex items-center gap-4 text-xs font-bold">
              <span>
                مدين:{' '}
                <span className="text-emerald-700">{EGP(totalDebit)}</span>
              </span>
              <span>
                دائن:{' '}
                <span className="text-rose-700">{EGP(totalCredit)}</span>
              </span>
              <span
                className={
                  balanced ? 'text-emerald-700' : 'text-rose-700'
                }
              >
                {balanced
                  ? '✓ متوازن'
                  : `فرق ${EGP(Math.abs(totalDebit - totalCredit))}`}
              </span>
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.post_immediately ?? true}
            onChange={(e) =>
              setForm({ ...form, post_immediately: e.target.checked })
            }
          />
          ترحيل القيد فوراً (إذا ألغيت يُحفظ كمسوّدة)
        </label>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            disabled={mutation.isPending || !balanced}
            onClick={() => mutation.mutate()}
          >
            حفظ القيد
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function JournalViewModal({
  entry,
  canVoid,
  onClose,
}: {
  entry: JournalEntry;
  canVoid: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: full } = useQuery({
    queryKey: ['journal', entry.id],
    queryFn: () => accountsApi.getJournal(entry.id),
  });

  const voidMut = useMutation({
    mutationFn: (reason: string) => accountsApi.voidJournal(entry.id, reason),
    onSuccess: () => {
      toast.success('تم إلغاء القيد');
      qc.invalidateQueries({ queryKey: ['journal'] });
      qc.invalidateQueries({ queryKey: ['coa'] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  const e = full || entry;
  const totalD =
    e.lines?.reduce((s, l) => s + Number(l.debit || 0), 0) ?? 0;
  const totalC =
    e.lines?.reduce((s, l) => s + Number(l.credit || 0), 0) ?? 0;

  return (
    <Modal title={`قيد ${e.entry_no}`} onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">التاريخ</div>
            <div className="font-bold">{e.entry_date}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">المصدر</div>
            <div className="font-bold">{e.reference_type || 'يدوي'}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">الحالة</div>
            <div>
              {e.is_void ? (
                <span className="chip bg-rose-100 text-rose-700">ملغى</span>
              ) : e.is_posted ? (
                <span className="chip bg-emerald-100 text-emerald-700">
                  مُرحّل
                </span>
              ) : (
                <span className="chip bg-slate-100 text-slate-600">
                  مسوّدة
                </span>
              )}
            </div>
          </div>
        </div>

        {e.description && (
          <div className="text-sm border border-slate-200 rounded p-3 bg-slate-50">
            {e.description}
          </div>
        )}

        <table className="min-w-full text-sm border border-slate-200 rounded">
          <thead className="bg-slate-50 text-xs">
            <tr>
              <th className="text-right px-3 py-2">الحساب</th>
              <th className="text-right px-3 py-2">البيان</th>
              <th className="text-right px-3 py-2">مدين</th>
              <th className="text-right px-3 py-2">دائن</th>
            </tr>
          </thead>
          <tbody>
            {(e.lines || []).map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <span className="font-mono text-xs text-slate-500">
                    {l.account_code}
                  </span>{' '}
                  {l.account_name}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {l.description || '—'}
                </td>
                <td className="px-3 py-2 font-mono font-bold text-emerald-700">
                  {Number(l.debit) > 0 ? EGP(l.debit) : '—'}
                </td>
                <td className="px-3 py-2 font-mono font-bold text-rose-700">
                  {Number(l.credit) > 0 ? EGP(l.credit) : '—'}
                </td>
              </tr>
            ))}
            <tr className="bg-slate-50 border-t-2 border-slate-300 font-bold">
              <td colSpan={2} className="px-3 py-2 text-left">
                الإجمالي
              </td>
              <td className="px-3 py-2 font-mono text-emerald-700">
                {EGP(totalD)}
              </td>
              <td className="px-3 py-2 font-mono text-rose-700">
                {EGP(totalC)}
              </td>
            </tr>
          </tbody>
        </table>

        {e.is_void && e.void_reason && (
          <div className="p-3 rounded bg-rose-50 border border-rose-200 text-sm text-rose-800">
            <div className="font-bold">سبب الإلغاء</div>
            <div>{e.void_reason}</div>
          </div>
        )}

        {!e.is_void && e.is_posted && canVoid && (
          <div className="pt-2">
            <button
              className="w-full py-2 bg-rose-600 text-white rounded-lg font-bold hover:bg-rose-700 flex items-center justify-center gap-2 disabled:opacity-50"
              disabled={voidMut.isPending}
              onClick={() => {
                const reason = prompt('سبب الإلغاء:');
                if (reason && reason.length >= 3) voidMut.mutate(reason);
              }}
            >
              <Ban size={16} /> إلغاء/عكس القيد
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Trial Balance
// ═══════════════════════════════════════════════════════════════════════

function TrialBalanceTab() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['trial-balance'],
    queryFn: () => accountsApi.trialBalance(),
  });

  const totals = useMemo(() => {
    let d = 0;
    let c = 0;
    for (const r of rows) {
      d += Number(r.total_debit || 0);
      c += Number(r.total_credit || 0);
    }
    return { d, c, balanced: Math.abs(d - c) < 0.01 };
  }, [rows]);

  if (isLoading)
    return (
      <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-4 text-sm">
        <span>
          إجمالي المدين:{' '}
          <span className="font-bold text-emerald-700">
            {EGP(totals.d)}
          </span>
        </span>
        <span>
          إجمالي الدائن:{' '}
          <span className="font-bold text-rose-700">{EGP(totals.c)}</span>
        </span>
        <span
          className={`chip ${
            totals.balanced
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-rose-100 text-rose-700'
          }`}
        >
          {totals.balanced
            ? '✓ ميزان متوازن'
            : `فرق ${EGP(Math.abs(totals.d - totals.c))}`}
        </span>
      </div>
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50/60 text-xs font-bold text-slate-600">
            <tr>
              <th className="text-right px-3 py-2">الكود</th>
              <th className="text-right px-3 py-2">الحساب</th>
              <th className="text-right px-3 py-2">النوع</th>
              <th className="text-right px-3 py-2">مدين</th>
              <th className="text-right px-3 py-2">دائن</th>
              <th className="text-right px-3 py-2">الرصيد</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-t border-slate-100 hover:bg-slate-50/60"
              >
                <td className="px-3 py-2 font-mono text-xs font-bold text-slate-600">
                  {r.code}
                </td>
                <td className="px-3 py-2">{r.name_ar}</td>
                <td className="px-3 py-2">
                  <span
                    className={`chip text-[10px] ${TYPE_COLORS[r.account_type]}`}
                  >
                    {TYPE_LABELS[r.account_type]}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-emerald-700">
                  {EGP(r.total_debit)}
                </td>
                <td className="px-3 py-2 font-mono text-rose-700">
                  {EGP(r.total_credit)}
                </td>
                <td className="px-3 py-2 font-mono font-bold">
                  {EGP(r.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Shared helpers
// ═══════════════════════════════════════════════════════════════════════

function Modal({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'md' | 'lg';
}) {
  const w = size === 'lg' ? 'max-w-4xl' : 'max-w-xl';
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div
        className={`bg-white rounded-2xl w-full ${w} max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}
