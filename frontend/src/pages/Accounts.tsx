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
  TrendingUp,
  PieChart,
  Eye,
} from 'lucide-react';

import {
  accountsApi,
  Account,
  AccountType,
  JournalEntry,
  CreateAccountPayload,
  CreateJournalPayload,
} from '@/api/accounts.api';
import { exportToExcel } from '@/lib/exportExcel';
import { Download } from 'lucide-react';
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

type Tab =
  | 'tree'
  | 'journal'
  | 'trial'
  | 'income'
  | 'balance'
  | 'aging'
  | 'vat'
  | 'assets'
  | 'closing';

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
          <TabBtn
            active={tab === 'income'}
            onClick={() => setTab('income')}
            icon={<TrendingUp className="w-4 h-4" />}
            label="قائمة الدخل"
          />
          <TabBtn
            active={tab === 'balance'}
            onClick={() => setTab('balance')}
            icon={<PieChart className="w-4 h-4" />}
            label="الميزانية العمومية"
          />
          <TabBtn
            active={tab === 'aging'}
            onClick={() => setTab('aging')}
            icon={<Scale className="w-4 h-4" />}
            label="أعمار الديون"
          />
          <TabBtn
            active={tab === 'vat'}
            onClick={() => setTab('vat')}
            icon={<Scale className="w-4 h-4" />}
            label="إقرار القيمة المضافة"
          />
          <TabBtn
            active={tab === 'assets'}
            onClick={() => setTab('assets')}
            icon={<Lock className="w-4 h-4" />}
            label="الأصول الثابتة"
          />
          <TabBtn
            active={tab === 'closing'}
            onClick={() => setTab('closing')}
            icon={<Ban className="w-4 h-4" />}
            label="إقفال السنة"
          />
        </div>
        <div className="p-4">
          {tab === 'tree' && <ChartTree />}
          {tab === 'journal' && <JournalTab />}
          {tab === 'trial' && <TrialBalanceTab />}
          {tab === 'income' && <IncomeStatementTab />}
          {tab === 'balance' && <BalanceSheetTab />}
          {tab === 'aging' && <AgingTab />}
          {tab === 'vat' && <VatReturnTab />}
          {tab === 'assets' && <FixedAssetsTab />}
          {tab === 'closing' && <ClosingTab />}
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
  const [ledgerFor, setLedgerFor] = useState<Account | null>(null);
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
            onView={(a) => setLedgerFor(a)}
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
      {ledgerFor && (
        <AccountLedgerDrawer
          accountId={ledgerFor.id}
          accountCode={ledgerFor.code}
          accountName={ledgerFor.name_ar}
          onClose={() => setLedgerFor(null)}
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
  onView,
}: {
  account: Account;
  childrenByParent: Record<string, Account[]>;
  expanded: Set<string>;
  toggle: (id: string) => void;
  canManage: boolean;
  onAddChild: (a: Account) => void;
  onEdit: (a: Account) => void;
  onView: (a: Account) => void;
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
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => onView(account)}
            className="p-1 hover:bg-slate-200 rounded text-slate-500"
            title="كشف حساب"
          >
            <Eye size={14} />
          </button>
          {canManage && (
            <>
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
            </>
          )}
        </div>
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
            onView={onView}
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
          <div className="flex gap-2 mr-auto flex-wrap">
            <button
              className="btn-primary"
              onClick={() => setShowCreate(true)}
            >
              <Plus size={16} /> قيد جديد
            </button>
          </div>
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
                <th className="text-right px-3 py-2">المبلغ</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="text-right px-3 py-2">المستخدم</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-slate-400">
                    جارٍ التحميل...
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-slate-400">
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
                    <td
                      className="px-3 py-2 font-mono font-bold text-slate-800"
                      title="الإجمالي — في القيد المزدوج يساوي المدين = الدائن"
                    >
                      {EGP(e.total_debit || 0)}
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

// Admin / maintenance buttons were removed per the user's explicit
// instruction: "الغي الزرار وجود الزرار مش صح" (remove the buttons —
// their existence is wrong). The repairs those buttons used to trigger
// (dedupe journal, dedupe cashbox txns, recompute cashbox / customer /
// supplier balances) now run automatically on backend boot via
// database/migrations/056_auto_accounts_repair.sql — idempotent, safe,
// non-destructive. Users who genuinely want a fresh slate go through
// the /opening-balance wizard in the sidebar.

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
//  Income Statement
// ═══════════════════════════════════════════════════════════════════════

function IncomeStatementTab() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthStart = todayISO.slice(0, 7) + '-01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);

  const { data, isLoading } = useQuery({
    queryKey: ['income-statement', from, to],
    queryFn: () => accountsApi.incomeStatement({ from, to }),
  });

  const exportPL = () => {
    if (!data) return;
    exportToExcel(
      `income-statement-${from}-to-${to}`,
      data.accounts.map((a) => ({
        الكود: a.code,
        الحساب: a.name_ar,
        النوع: a.account_type === 'revenue' ? 'إيراد' : 'مصروف',
        القيمة: a.amount,
      })),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm">من</label>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="input w-40"
        />
        <label className="text-sm">إلى</label>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="input w-40"
        />
        {data && (
          <button className="btn-secondary mr-auto" onClick={exportPL}>
            <Download size={14} /> Excel
          </button>
        )}
      </div>
      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : !data ? null : (
        <>
          <div className="grid md:grid-cols-3 gap-3">
            <KpiTile
              label="إجمالي الإيرادات"
              value={EGP(data.total_revenue)}
              color="emerald"
            />
            <KpiTile
              label="إجمالي المصروفات"
              value={EGP(data.total_expenses)}
              color="rose"
            />
            <KpiTile
              label={data.net_profit >= 0 ? 'صافي الربح' : 'صافي الخسارة'}
              value={EGP(Math.abs(data.net_profit))}
              color={data.net_profit >= 0 ? 'indigo' : 'rose'}
            />
          </div>

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <ReportTree
              nodes={data.accounts.filter((a) => a.account_type === 'revenue')}
              heading="الإيرادات"
              color="text-emerald-700"
            />
            <ReportTree
              nodes={data.accounts.filter((a) => a.account_type === 'expense')}
              heading="المصروفات"
              color="text-rose-700"
            />
            <div className="p-3 bg-slate-50 border-t-2 border-slate-300 flex items-center justify-between font-black">
              <span>صافي الربح / (الخسارة)</span>
              <span
                className={`font-mono ${
                  data.net_profit >= 0 ? 'text-indigo-700' : 'text-rose-700'
                }`}
              >
                {data.net_profit >= 0 ? '' : '('}
                {EGP(Math.abs(data.net_profit))}
                {data.net_profit >= 0 ? '' : ')'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Balance Sheet
// ═══════════════════════════════════════════════════════════════════════

function BalanceSheetTab() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(todayISO);

  const { data, isLoading } = useQuery({
    queryKey: ['balance-sheet', asOf],
    queryFn: () => accountsApi.balanceSheet({ as_of: asOf }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm">بتاريخ</label>
        <input
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          className="input w-40"
        />
        {data && (
          <span
            className={`chip mr-auto ${
              data.balanced
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-rose-100 text-rose-700'
            }`}
          >
            {data.balanced ? '✓ الميزانية متوازنة' : '⚠ الميزانية غير متوازنة'}
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : !data ? null : (
        <>
          <div className="grid md:grid-cols-3 gap-3">
            <KpiTile label="إجمالي الأصول" value={EGP(data.total_assets)} color="emerald" />
            <KpiTile label="إجمالي الخصوم" value={EGP(data.total_liabilities)} color="rose" />
            <KpiTile
              label="إجمالي حقوق الملكية"
              value={EGP(data.total_equity)}
              color="indigo"
              hint={`منها ربح/خسارة الفترة: ${EGP(data.period_net_profit)}`}
            />
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <ReportTree
                nodes={data.accounts.filter((a) => a.account_type === 'asset')}
                heading="الأصول"
                color="text-emerald-700"
              />
            </div>
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <ReportTree
                nodes={data.accounts.filter((a) => a.account_type === 'liability')}
                heading="الخصوم"
                color="text-rose-700"
              />
              <ReportTree
                nodes={data.accounts.filter((a) => a.account_type === 'equity')}
                heading="حقوق الملكية"
                color="text-indigo-700"
                extraRows={[
                  {
                    label: 'ربح / خسارة الفترة',
                    amount: data.period_net_profit,
                  },
                ]}
              />
              <div className="p-3 bg-slate-50 border-t-2 border-slate-300 flex items-center justify-between font-black text-sm">
                <span>الخصوم + حقوق الملكية</span>
                <span className="font-mono">
                  {EGP(data.total_liabilities + data.total_equity)}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Shared report widgets
// ═══════════════════════════════════════════════════════════════════════

function KpiTile({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: string;
  color: 'emerald' | 'rose' | 'indigo';
  hint?: string;
}) {
  const cls = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    rose: 'bg-rose-50 border-rose-200 text-rose-800',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  }[color];
  return (
    <div className={`card p-4 border-2 ${cls}`}>
      <div className="text-xs font-bold opacity-80">{label}</div>
      <div className="font-black text-2xl font-mono mt-1">{value}</div>
      {hint && <div className="text-[11px] opacity-70 mt-0.5">{hint}</div>}
    </div>
  );
}

function ReportTree({
  nodes,
  heading,
  color,
  extraRows,
}: {
  nodes: Array<{
    id: string;
    code: string;
    name_ar: string;
    parent_id: string | null;
    is_leaf: boolean;
    amount: number;
  }>;
  heading: string;
  color: string;
  extraRows?: Array<{ label: string; amount: number }>;
}) {
  const [ledgerFor, setLedgerFor] = useState<{
    id: string;
    code: string;
    name: string;
  } | null>(null);
  const byParent: Record<string, any[]> = {};
  const idSet = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const key =
      n.parent_id && idSet.has(n.parent_id) ? n.parent_id : '__root__';
    (byParent[key] ||= []).push(n);
  }

  const total = (byParent['__root__'] || []).reduce(
    (s, n) => s + Number(n.amount || 0),
    0,
  );
  const extraSum =
    extraRows?.reduce((s, r) => s + Number(r.amount || 0), 0) || 0;

  const Row = ({ node, level }: { node: any; level: number }) => {
    const kids = byParent[node.id] || [];
    return (
      <>
        <div
          className={`flex items-center gap-2 py-1.5 px-3 border-b border-slate-100 hover:bg-slate-50 text-sm ${
            node.is_leaf ? 'cursor-pointer' : ''
          }`}
          style={{ paddingInlineStart: 12 + level * 20 }}
          onClick={() =>
            node.is_leaf &&
            setLedgerFor({ id: node.id, code: node.code, name: node.name_ar })
          }
        >
          <span className="font-mono text-xs text-slate-500 w-12">
            {node.code}
          </span>
          <span className={`flex-1 ${node.is_leaf ? '' : 'font-bold'}`}>
            {node.name_ar}
          </span>
          {node.is_leaf && (
            <Eye size={12} className="text-slate-400 opacity-0 group-hover:opacity-100" />
          )}
          <span
            className={`font-mono font-bold tabular-nums ${
              node.is_leaf ? '' : color
            }`}
          >
            {EGP(node.amount)}
          </span>
        </div>
        {kids.map((k) => (
          <Row key={k.id} node={k} level={level + 1} />
        ))}
      </>
    );
  };

  return (
    <>
      <div className="p-3 bg-slate-50 font-black text-sm border-b border-slate-200">
        {heading}
      </div>
      {(byParent['__root__'] || []).map((n) => (
        <Row key={n.id} node={n} level={0} />
      ))}
      {extraRows?.map((r, i) => (
        <div
          key={i}
          className="flex items-center justify-between py-1.5 px-3 border-b border-slate-100 text-sm italic text-slate-600"
          style={{ paddingInlineStart: 32 }}
        >
          <span>{r.label}</span>
          <span className="font-mono">{EGP(r.amount)}</span>
        </div>
      ))}
      <div
        className={`flex items-center justify-between py-2 px-3 bg-slate-50 border-t border-slate-300 font-black ${color}`}
      >
        <span>الإجمالي</span>
        <span className="font-mono">{EGP(total + extraSum)}</span>
      </div>

      {ledgerFor && (
        <AccountLedgerDrawer
          accountId={ledgerFor.id}
          accountCode={ledgerFor.code}
          accountName={ledgerFor.name}
          onClose={() => setLedgerFor(null)}
        />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Account Ledger drawer
// ═══════════════════════════════════════════════════════════════════════

function AccountLedgerDrawer({
  accountId,
  accountCode,
  accountName,
  onClose,
}: {
  accountId: string;
  accountCode: string;
  accountName: string;
  onClose: () => void;
}) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthStart = todayISO.slice(0, 7) + '-01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', accountId, from, to],
    queryFn: () => accountsApi.accountLedger(accountId, { from, to }),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800">
            كشف حساب: <span className="font-mono">{accountCode}</span>{' '}
            {accountName}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm">من</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="input w-40"
            />
            <label className="text-sm">إلى</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="input w-40"
            />
          </div>

          {isLoading ? (
            <div className="py-12 text-center text-slate-400">
              جارٍ التحميل...
            </div>
          ) : !data ? null : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="card p-3 border border-slate-200 bg-slate-50">
                  <div className="text-xs text-slate-500">الرصيد الافتتاحي</div>
                  <div className="font-mono font-bold">
                    {EGP(data.opening_balance)}
                  </div>
                </div>
                <div className="card p-3 border border-slate-200 bg-emerald-50">
                  <div className="text-xs text-slate-500">إجمالي مدين</div>
                  <div className="font-mono font-bold text-emerald-700">
                    {EGP(data.total_debit)}
                  </div>
                </div>
                <div className="card p-3 border border-slate-200 bg-rose-50">
                  <div className="text-xs text-slate-500">إجمالي دائن</div>
                  <div className="font-mono font-bold text-rose-700">
                    {EGP(data.total_credit)}
                  </div>
                </div>
                <div className="card p-3 border-2 border-indigo-300 bg-indigo-50">
                  <div className="text-xs text-slate-500">الرصيد الختامي</div>
                  <div className="font-mono font-black text-indigo-700">
                    {EGP(data.closing_balance)}
                  </div>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-600">
                    <tr>
                      <th className="text-right px-3 py-2">التاريخ</th>
                      <th className="text-right px-3 py-2">رقم القيد</th>
                      <th className="text-right px-3 py-2">البيان</th>
                      <th className="text-right px-3 py-2">المصدر</th>
                      <th className="text-right px-3 py-2">مدين</th>
                      <th className="text-right px-3 py-2">دائن</th>
                      <th className="text-right px-3 py-2">الرصيد</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td colSpan={6} className="px-3 py-2 font-bold text-xs text-slate-500">
                        الرصيد الافتتاحي
                      </td>
                      <td className="px-3 py-2 font-mono font-bold">
                        {EGP(data.opening_balance)}
                      </td>
                    </tr>
                    {data.lines.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="text-center py-10 text-slate-400"
                        >
                          لا توجد حركات في هذه الفترة
                        </td>
                      </tr>
                    ) : (
                      data.lines.map((l) => (
                        <tr
                          key={l.id}
                          className="border-t border-slate-100 hover:bg-slate-50/60"
                        >
                          <td className="px-3 py-2 text-xs font-mono">
                            {l.entry_date}
                          </td>
                          <td className="px-3 py-2 font-mono font-bold text-brand-700">
                            {l.entry_no}
                          </td>
                          <td className="px-3 py-2 max-w-xs truncate">
                            {l.description || l.entry_description || '—'}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">
                            {l.reference_type || '—'}
                          </td>
                          <td className="px-3 py-2 font-mono font-bold text-emerald-700">
                            {l.debit > 0 ? EGP(l.debit) : '—'}
                          </td>
                          <td className="px-3 py-2 font-mono font-bold text-rose-700">
                            {l.credit > 0 ? EGP(l.credit) : '—'}
                          </td>
                          <td className="px-3 py-2 font-mono font-bold">
                            {EGP(l.running_balance)}
                          </td>
                        </tr>
                      ))
                    )}
                    <tr className="bg-slate-50 border-t-2 border-slate-300 font-black">
                      <td colSpan={4} className="px-3 py-2">
                        الإجمالي
                      </td>
                      <td className="px-3 py-2 font-mono text-emerald-700">
                        {EGP(data.total_debit)}
                      </td>
                      <td className="px-3 py-2 font-mono text-rose-700">
                        {EGP(data.total_credit)}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {EGP(data.closing_balance)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Aging (receivable / payable)
// ═══════════════════════════════════════════════════════════════════════

function AgingTab() {
  const [type, setType] = useState<'receivable' | 'payable'>('receivable');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(todayISO);
  const { data, isLoading } = useQuery({
    queryKey: ['aging', type, asOf],
    queryFn: () => accountsApi.aging({ type, as_of: asOf }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          <button
            onClick={() => setType('receivable')}
            className={`px-3 py-1 rounded-md text-sm font-bold ${
              type === 'receivable'
                ? 'bg-white shadow text-indigo-700'
                : 'text-slate-600'
            }`}
          >
            مستحقات على العملاء
          </button>
          <button
            onClick={() => setType('payable')}
            className={`px-3 py-1 rounded-md text-sm font-bold ${
              type === 'payable'
                ? 'bg-white shadow text-indigo-700'
                : 'text-slate-600'
            }`}
          >
            مستحقات للموردين
          </button>
        </div>
        <label className="text-sm">بتاريخ</label>
        <input
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          className="input w-40"
        />
      </div>
      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : !data ? null : (
        <>
          <div className="grid md:grid-cols-5 gap-3">
            {data.buckets.map((b) => (
              <div
                key={b}
                className="card p-3 border border-slate-200 bg-slate-50"
              >
                <div className="text-xs text-slate-500">{b} يوم</div>
                <div className="font-mono font-bold text-slate-800 mt-1">
                  {EGP(data.totals[b] || 0)}
                </div>
              </div>
            ))}
            <div className="card p-3 border-2 border-indigo-300 bg-indigo-50">
              <div className="text-xs text-slate-500">الإجمالي</div>
              <div className="font-mono font-black text-indigo-700 mt-1">
                {EGP(data.totals.total || 0)}
              </div>
            </div>
          </div>

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs font-bold text-slate-600">
                <tr>
                  <th className="text-right px-3 py-2">الكود</th>
                  <th className="text-right px-3 py-2">
                    {type === 'receivable' ? 'العميل' : 'المورد'}
                  </th>
                  {data.buckets.map((b) => (
                    <th key={b} className="text-right px-3 py-2">
                      {b}
                    </th>
                  ))}
                  <th className="text-right px-3 py-2">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {data.parties.length === 0 ? (
                  <tr>
                    <td
                      colSpan={data.buckets.length + 3}
                      className="text-center py-10 text-slate-400"
                    >
                      مفيش مستحقات
                    </td>
                  </tr>
                ) : (
                  data.parties.map((p) => (
                    <tr
                      key={p.id}
                      className="border-t border-slate-100 hover:bg-slate-50"
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        {p.code}
                      </td>
                      <td className="px-3 py-2 font-bold">{p.name}</td>
                      {data.buckets.map((b) => (
                        <td
                          key={b}
                          className="px-3 py-2 font-mono"
                        >
                          {p.buckets[b] > 0 ? EGP(p.buckets[b]) : '—'}
                        </td>
                      ))}
                      <td className="px-3 py-2 font-mono font-black">
                        {EGP(p.total)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Fixed Assets + Depreciation
// ═══════════════════════════════════════════════════════════════════════

function FixedAssetsTab() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('accounts.depreciation');
  const [showCreate, setShowCreate] = useState(false);

  const { data: assets = [], isLoading } = useQuery({
    queryKey: ['fixed-assets'],
    queryFn: () => accountsApi.listFixedAssets(),
  });

  const runMut = useMutation({
    mutationFn: () => accountsApi.runDepreciation(),
    onSuccess: (r) => {
      toast.success(`تم ترحيل ${r.posted_count} قسط إهلاك`);
      qc.invalidateQueries({ queryKey: ['fixed-assets'] });
      qc.invalidateQueries({ queryKey: ['journal'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الترحيل'),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-slate-600">
          إجمالي الأصول النشطة: {assets.filter((a) => a.is_active).length}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              onClick={() => {
                if (confirm('تشغيل ترحيل الإهلاك لهذا الشهر يدوياً؟'))
                  runMut.mutate();
              }}
              disabled={runMut.isPending}
            >
              {runMut.isPending ? '⏳ جاري الترحيل' : '🔄 ترحيل إهلاك الشهر'}
            </button>
            <button
              className="btn-primary"
              onClick={() => setShowCreate(true)}
            >
              <Plus size={16} /> إضافة أصل ثابت
            </button>
          </div>
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
                <th className="text-right px-3 py-2">الحساب</th>
                <th className="text-right px-3 py-2">التكلفة</th>
                <th className="text-right px-3 py-2">العمر (شهر)</th>
                <th className="text-right px-3 py-2">القسط الشهري</th>
                <th className="text-right px-3 py-2">تاريخ البدء</th>
                <th className="text-right px-3 py-2">آخر شهر</th>
                <th className="text-right px-3 py-2">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-10 text-slate-400">
                    لا توجد أصول — اضغط "إضافة أصل ثابت"
                  </td>
                </tr>
              ) : (
                assets.map((a) => {
                  const cost = Number(a.cost);
                  const salvage = Number(a.salvage_value);
                  const monthly =
                    a.useful_life_months > 0
                      ? (cost - salvage) / a.useful_life_months
                      : 0;
                  return (
                    <tr
                      key={a.id}
                      className={`border-t border-slate-100 ${
                        a.is_active ? '' : 'opacity-60'
                      }`}
                    >
                      <td className="px-3 py-2 font-bold">{a.name_ar}</td>
                      <td className="px-3 py-2 text-xs">
                        <span className="font-mono">{a.account_code}</span>{' '}
                        {a.account_name}
                      </td>
                      <td className="px-3 py-2 font-mono">{EGP(cost)}</td>
                      <td className="px-3 py-2">{a.useful_life_months}</td>
                      <td className="px-3 py-2 font-mono text-indigo-700">
                        {EGP(monthly)}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {a.start_date}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {a.last_posted_month || '—'}
                      </td>
                      <td className="px-3 py-2">
                        {a.is_active ? (
                          <span className="chip bg-emerald-100 text-emerald-700">
                            نشط
                          </span>
                        ) : (
                          <span className="chip bg-slate-100 text-slate-600">
                            معطّل
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <FixedAssetModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}

function FixedAssetModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const todayISO = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    name_ar: '',
    account_id: '',
    accum_dep_account_id: '',
    cost: 0,
    salvage_value: 0,
    useful_life_months: 60,
    start_date: todayISO,
    notes: '',
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['coa', false],
    queryFn: () => accountsApi.list(false),
  });
  const fixedAccounts = accounts.filter(
    (a) =>
      a.account_type === 'asset' &&
      a.is_leaf &&
      (a.code.startsWith('12') ||
        a.code.startsWith('121') ||
        a.code.startsWith('122')),
  );
  const accumAccounts = accounts.filter(
    (a) =>
      a.account_type === 'asset' &&
      a.is_leaf &&
      a.code.startsWith('123'),
  );

  const mut = useMutation({
    mutationFn: () =>
      accountsApi.createFixedAsset({
        name_ar: form.name_ar,
        account_id: form.account_id,
        accum_dep_account_id: form.accum_dep_account_id || undefined,
        cost: form.cost,
        salvage_value: form.salvage_value,
        useful_life_months: form.useful_life_months,
        start_date: form.start_date,
        notes: form.notes || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إضافة الأصل الثابت');
      qc.invalidateQueries({ queryKey: ['fixed-assets'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const monthly =
    form.useful_life_months > 0
      ? (form.cost - form.salvage_value) / form.useful_life_months
      : 0;

  return (
    <Modal title="أصل ثابت جديد" onClose={onClose}>
      <div className="space-y-3">
        <Field label="اسم الأصل">
          <input
            className="input"
            value={form.name_ar}
            onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
            placeholder="مثال: كمبيوتر لاب توب Dell"
            autoFocus
          />
        </Field>
        <Field label="حساب الأصل">
          <select
            className="input"
            value={form.account_id}
            onChange={(e) => setForm({ ...form, account_id: e.target.value })}
          >
            <option value="">—</option>
            {fixedAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name_ar}
              </option>
            ))}
          </select>
        </Field>
        <Field label="حساب مجمع الإهلاك (اختياري — الافتراضي: 123)">
          <select
            className="input"
            value={form.accum_dep_account_id}
            onChange={(e) =>
              setForm({ ...form, accum_dep_account_id: e.target.value })
            }
          >
            <option value="">افتراضي (123)</option>
            {accumAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name_ar}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="التكلفة">
            <input
              type="number"
              step="0.01"
              className="input"
              value={form.cost}
              onChange={(e) =>
                setForm({ ...form, cost: Number(e.target.value) })
              }
            />
          </Field>
          <Field label="قيمة الخردة">
            <input
              type="number"
              step="0.01"
              className="input"
              value={form.salvage_value}
              onChange={(e) =>
                setForm({ ...form, salvage_value: Number(e.target.value) })
              }
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="العمر الإنتاجي (شهر)">
            <input
              type="number"
              min={1}
              className="input"
              value={form.useful_life_months}
              onChange={(e) =>
                setForm({
                  ...form,
                  useful_life_months: Number(e.target.value) || 1,
                })
              }
            />
          </Field>
          <Field label="تاريخ البدء">
            <input
              type="date"
              className="input"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
            />
          </Field>
        </div>
        <div className="p-3 bg-indigo-50 border border-indigo-200 rounded text-sm">
          القسط الشهري المحسوب:{' '}
          <span className="font-mono font-bold text-indigo-700">
            {EGP(monthly)}
          </span>
        </div>
        <Field label="ملاحظات">
          <textarea
            className="input"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </Field>
        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={() => mut.mutate()}
            disabled={
              mut.isPending ||
              !form.name_ar ||
              !form.account_id ||
              form.cost <= 0
            }
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
//  Year-end Closing
// ═══════════════════════════════════════════════════════════════════════

function ClosingTab() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canClose = hasPermission('accounts.close_year');
  const year = new Date().getFullYear() - 1;
  const [fye, setFye] = useState(`${year}-12-31`);

  const mut = useMutation({
    mutationFn: () => accountsApi.closeYear(fye),
    onSuccess: (r: any) => {
      if (r?.skipped) {
        toast(`تم التجاهل: ${r.reason || ''}`, { icon: 'ℹ️' });
      } else {
        toast.success('تم إقفال السنة');
      }
      qc.invalidateQueries({ queryKey: ['journal'] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
      qc.invalidateQueries({ queryKey: ['balance-sheet'] });
      qc.invalidateQueries({ queryKey: ['income-statement'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإقفال'),
  });

  if (!canClose) {
    return (
      <div className="p-6 text-center text-slate-500">
        صلاحية إقفال السنة غير متاحة لك
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-xl">
      <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
        <div className="font-bold mb-1">⚠ تنبيه مهم</div>
        <ul className="list-disc pr-5 space-y-0.5">
          <li>قيد الإقفال يصفّر كل حسابات الإيرادات والمصروفات.</li>
          <li>الربح الصافي يُرحَّل إلى "الأرباح المحتجزة" (٣٢).</li>
          <li>
            العملية idempotent — لو شغّلتها تاني لنفس السنة مايحصلش تكرار.
          </li>
          <li>
            يُنفَّذ عادة في آخر يوم من السنة المالية (٣١ ديسمبر بالمصرية).
          </li>
        </ul>
      </div>

      <Field label="نهاية السنة المالية">
        <input
          type="date"
          className="input"
          value={fye}
          onChange={(e) => setFye(e.target.value)}
        />
      </Field>

      <button
        className="btn-primary w-full bg-rose-600 hover:bg-rose-700"
        disabled={mut.isPending}
        onClick={() => {
          if (
            confirm(
              `تأكيد إقفال السنة المنتهية في ${fye}؟\n\nسيتم ترحيل صافي النتيجة إلى الأرباح المحتجزة.`,
            )
          )
            mut.mutate();
        }}
      >
        {mut.isPending ? '⏳ جاري الإقفال...' : '🔒 تأكيد إقفال السنة'}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  VAT Return (إقرار ضريبة القيمة المضافة)
// ═══════════════════════════════════════════════════════════════════════

function VatReturnTab() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthStart = todayISO.slice(0, 7) + '-01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);

  const { data, isLoading } = useQuery({
    queryKey: ['vat-return', from, to],
    queryFn: () => accountsApi.vatReturn({ from, to }),
  });

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm">من</label>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="input w-40"
        />
        <label className="text-sm">إلى</label>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="input w-40"
        />
        {data && (
          <button
            className="btn-secondary mr-auto"
            onClick={() => {
              const rows = [
                { البيان: 'مبيعات خاضعة للضريبة', القيمة: data.taxable_sales },
                { البيان: 'ضريبة المبيعات (Output VAT)', القيمة: data.output_vat },
                { البيان: 'ضريبة مرتجعات مبيعات', القيمة: data.output_vat_refunded },
                { البيان: 'صافي ضريبة المبيعات', القيمة: data.net_output_vat },
                { البيان: 'مشتريات خاضعة للضريبة', القيمة: data.taxable_purchases },
                { البيان: 'ضريبة المشتريات (Input VAT)', القيمة: data.input_vat },
                { البيان: 'صافي المستحق', القيمة: data.net_vat_due },
              ];
              import('@/lib/exportExcel').then((m) =>
                m.exportToExcel(`vat-return-${from}-${to}`, rows, 'VAT'),
              );
            }}
          >
            تصدير Excel
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : !data ? null : (
        <>
          <div className="grid md:grid-cols-3 gap-3">
            <KpiTile
              label="ضريبة المبيعات"
              value={EGP(data.output_vat)}
              color="emerald"
              hint={`من ${data.invoice_count} فاتورة`}
            />
            <KpiTile
              label="ضريبة المشتريات"
              value={EGP(data.input_vat)}
              color="rose"
              hint={`من ${data.purchase_count} فاتورة`}
            />
            <KpiTile
              label={data.net_vat_due >= 0 ? 'مستحق للمصلحة' : 'استرداد'}
              value={EGP(Math.abs(data.net_vat_due))}
              color={data.net_vat_due >= 0 ? 'rose' : 'emerald'}
              hint={data.status}
            />
          </div>

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs font-bold text-slate-600">
                <tr>
                  <th className="text-right px-3 py-2">البند</th>
                  <th className="text-right px-3 py-2">القيمة</th>
                </tr>
              </thead>
              <tbody>
                <VatRow label="مبيعات خاضعة للضريبة (بدون ضريبة)" value={data.taxable_sales} />
                <VatRow label="ضريبة المبيعات المحصَّلة" value={data.output_vat} color="text-emerald-700" />
                <VatRow label="ضريبة مرتجعات مبيعات (تخصم)" value={-data.output_vat_refunded} color="text-slate-500" />
                <VatRow label="صافي ضريبة المبيعات" value={data.net_output_vat} bold />
                <VatRow label="مشتريات خاضعة للضريبة (بدون ضريبة)" value={data.taxable_purchases} />
                <VatRow label="ضريبة المشتريات القابلة للخصم" value={-data.input_vat} color="text-rose-700" />
                <VatRow label="صافي المستحق للمصلحة" value={data.net_vat_due} bold highlight />
              </tbody>
            </table>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
            💡 هذا الإقرار يجمّع الضريبة من حساب <b>(214) ضرائب مستحقة</b> مباشرة
            من القيود المرحَّلة. للاعتماد الرسمي لدى مصلحة الضرائب، صدّر Excel
            واستخدمه مع نموذج الإقرار الشهري.
          </div>
        </>
      )}
    </div>
  );
}

function VatRow({
  label,
  value,
  color,
  bold,
  highlight,
}: {
  label: string;
  value: number;
  color?: string;
  bold?: boolean;
  highlight?: boolean;
}) {
  return (
    <tr
      className={`border-t border-slate-100 ${
        highlight ? 'bg-amber-50 font-black' : bold ? 'bg-slate-50 font-bold' : ''
      }`}
    >
      <td className="px-3 py-2">{label}</td>
      <td
        className={`px-3 py-2 font-mono ${color || 'text-slate-800'} ${
          bold ? 'font-black' : ''
        }`}
      >
        {EGP(Math.abs(value))}
      </td>
    </tr>
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
