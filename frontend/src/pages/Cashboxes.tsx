import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Plus,
  X,
  Edit3,
  Trash2,
  Wallet,
  Building2,
  Smartphone,
  FileCheck,
  Phone,
  Mail,
  User,
  Hash,
  MapPin,
  Search,
  Power,
  PowerOff,
  ArrowRightLeft,
} from 'lucide-react';

import {
  cashDeskApi,
  Cashbox,
  CashboxKind,
  FinancialInstitution,
  CreateCashboxPayload,
} from '@/api/cash-desk.api';
import { InstitutionLogo } from '@/components/InstitutionLogo';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const KIND_LABEL: Record<CashboxKind, string> = {
  cash: 'نقدي',
  bank: 'بنكي',
  ewallet: 'محفظة إلكترونية',
  check: 'شيكات',
};

const KIND_ICON: Record<CashboxKind, any> = {
  cash: Wallet,
  bank: Building2,
  ewallet: Smartphone,
  check: FileCheck,
};

const KIND_COLOR: Record<CashboxKind, string> = {
  cash: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  bank: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  ewallet: 'bg-purple-50 border-purple-200 text-purple-800',
  check: 'bg-amber-50 border-amber-200 text-amber-800',
};

export default function Cashboxes() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('cashdesk.manage_accounts');
  const [filter, setFilter] = useState<CashboxKind | ''>('');
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState<CashboxKind | null>(null);
  const [editing, setEditing] = useState<Cashbox | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);

  const { data: boxes = [], isLoading } = useQuery({
    queryKey: ['cashboxes', 'all'],
    queryFn: () => cashDeskApi.cashboxes(true),
  });

  const filtered = useMemo(() => {
    return boxes.filter((b) => {
      if (filter && b.kind !== filter) return false;
      if (q) {
        const s = q.toLowerCase();
        return (
          b.name_ar?.toLowerCase().includes(s) ||
          (b.institution_name || '').toLowerCase().includes(s) ||
          (b.account_number || '').toLowerCase().includes(s) ||
          (b.account_manager_name || '').toLowerCase().includes(s) ||
          (b.bank_branch || '').toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [boxes, filter, q]);

  const totals = useMemo(() => {
    const byKind: Record<CashboxKind, { count: number; balance: number }> = {
      cash: { count: 0, balance: 0 },
      bank: { count: 0, balance: 0 },
      ewallet: { count: 0, balance: 0 },
      check: { count: 0, balance: 0 },
    };
    for (const b of boxes.filter((b) => b.is_active)) {
      byKind[b.kind].count++;
      byKind[b.kind].balance += Number(b.current_balance || 0);
    }
    return byKind;
  }, [boxes]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Wallet className="text-brand-600" /> الخزائن والحسابات البنكية
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            نقدي · حسابات بنكية · محافظ إلكترونية · شيكات
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            className="btn-primary"
            onClick={() => setShowTransfer(true)}
            disabled={boxes.filter((b) => b.is_active).length < 2}
            title="تحويل نقدية بين خزنتين"
          >
            <ArrowRightLeft size={16} /> تحويل بين الخزائن
          </button>
          {canManage &&
            (['cash', 'bank', 'ewallet', 'check'] as CashboxKind[]).map((k) => {
              const Icon = KIND_ICON[k];
              return (
                <button
                  key={k}
                  className="btn-secondary"
                  onClick={() => setShowCreate(k)}
                  title={`إضافة ${KIND_LABEL[k]}`}
                >
                  <Icon size={16} />
                  <Plus size={14} /> {KIND_LABEL[k]}
                </button>
              );
            })}
        </div>
      </div>

      {/* KPI summary */}
      <div className="grid md:grid-cols-4 gap-3">
        {(['cash', 'bank', 'ewallet', 'check'] as CashboxKind[]).map((k) => {
          const Icon = KIND_ICON[k];
          return (
            <div
              key={k}
              className={`card p-4 border-2 ${KIND_COLOR[k]} cursor-pointer transition ${
                filter === k ? 'ring-2 ring-brand-400' : ''
              }`}
              onClick={() => setFilter(filter === k ? '' : k)}
            >
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold">
                  <Icon size={14} className="inline" /> {KIND_LABEL[k]}
                </div>
                <div className="text-[11px] opacity-75">
                  {totals[k].count} خزنة
                </div>
              </div>
              <div className="font-black text-xl mt-1.5 font-mono">
                {EGP(totals[k].balance)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[260px]">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pr-9"
            placeholder="بحث باسم الخزنة / البنك / رقم الحساب / المسؤول..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          className="input w-48"
          value={filter}
          onChange={(e) => setFilter(e.target.value as any)}
        >
          <option value="">كل الأنواع</option>
          <option value="cash">نقدي</option>
          <option value="bank">بنكي</option>
          <option value="ewallet">محفظة إلكترونية</option>
          <option value="check">شيكات</option>
        </select>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-slate-400 border border-dashed border-slate-200 rounded-lg">
          لا توجد خزائن — اضغط زر الإضافة في الأعلى
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((b) => (
            <CashboxCard
              key={b.id}
              box={b}
              canManage={canManage}
              onEdit={() => setEditing(b)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CashboxFormModal
          kind={showCreate}
          onClose={() => setShowCreate(null)}
        />
      )}
      {editing && (
        <CashboxFormModal
          kind={editing.kind}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {showTransfer && (
        <TransferModal
          boxes={boxes.filter((b) => b.is_active)}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  );
}

function TransferModal({
  boxes,
  onClose,
}: {
  boxes: Cashbox[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');

  const from = boxes.find((b) => b.id === fromId);
  const to = boxes.find((b) => b.id === toId);
  const amt = Number(amount) || 0;
  const insufficient = !!from && amt > Number(from.current_balance || 0);

  const mutation = useMutation({
    mutationFn: () =>
      cashDeskApi.transfer({
        from_cashbox_id: fromId,
        to_cashbox_id: toId,
        amount: amt,
        notes: notes || undefined,
      }),
    onSuccess: () => {
      toast.success(`تم تحويل ${amt.toLocaleString('en-US')} ج.م`);
      qc.invalidateQueries({ queryKey: ['cashboxes'] });
      qc.invalidateQueries({ queryKey: ['cashflow-today'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التحويل'),
  });

  const canSubmit =
    fromId && toId && fromId !== toId && amt > 0 && !insufficient;

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <h3 className="font-black text-lg flex items-center gap-2">
            <ArrowRightLeft size={20} /> تحويل نقدية بين الخزائن
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                من خزنة
              </span>
              <select
                className="input"
                value={fromId}
                onChange={(e) => setFromId(e.target.value)}
              >
                <option value="">—</option>
                {boxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name_ar} (
                    {Number(b.current_balance).toLocaleString('en-US')} ج.م)
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                إلى خزنة
              </span>
              <select
                className="input"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
              >
                <option value="">—</option>
                {boxes
                  .filter((b) => b.id !== fromId)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name_ar} (
                      {Number(b.current_balance).toLocaleString('en-US')} ج.م)
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              المبلغ
            </span>
            <input
              type="number"
              step="0.01"
              className="input text-lg font-bold"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </label>
          {insufficient && from && (
            <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded p-2">
              رصيد "{from.name_ar}" غير كافٍ — المتاح{' '}
              {Number(from.current_balance).toLocaleString('en-US')} ج.م
            </div>
          )}

          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              ملاحظات
            </span>
            <textarea
              className="input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="سبب التحويل / مرجع"
            />
          </label>

          {from && to && amt > 0 && !insufficient && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm">
              <div className="font-bold mb-1">ملخص العملية</div>
              <div className="flex items-center justify-between">
                <span>{from.name_ar}:</span>
                <span className="font-mono">
                  {Number(from.current_balance).toLocaleString('en-US')} →{' '}
                  <b className="text-rose-700">
                    {(Number(from.current_balance) - amt).toLocaleString(
                      'en-US',
                    )}
                  </b>
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>{to.name_ar}:</span>
                <span className="font-mono">
                  {Number(to.current_balance).toLocaleString('en-US')} →{' '}
                  <b className="text-emerald-700">
                    {(Number(to.current_balance) + amt).toLocaleString(
                      'en-US',
                    )}
                  </b>
                </span>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-slate-100">
            <button
              className="btn-primary flex-1"
              disabled={!canSubmit || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              تنفيذ التحويل
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

function CashboxCard({
  box,
  canManage,
  onEdit,
}: {
  box: Cashbox;
  canManage: boolean;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => cashDeskApi.removeCashbox(box.id),
    onSuccess: (r: any) => {
      if (r?.soft_deleted) {
        toast.success('تم تعطيل الخزنة (بها حركات سابقة)');
      } else {
        toast.success('تم حذف الخزنة');
      }
      qc.invalidateQueries({ queryKey: ['cashboxes'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحذف'),
  });
  const toggleActive = useMutation({
    mutationFn: () =>
      cashDeskApi.updateCashbox(box.id, { is_active: !box.is_active }),
    onSuccess: () => {
      toast.success(box.is_active ? 'تم تعطيل الخزنة' : 'تم تفعيل الخزنة');
      qc.invalidateQueries({ queryKey: ['cashboxes'] });
    },
  });

  return (
    <div
      className={`card p-4 border-2 ${KIND_COLOR[box.kind]} ${
        !box.is_active ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <InstitutionLogo
          domain={box.institution_domain}
          kind={box.kind}
          color={box.institution_color || box.color || undefined}
          label={box.institution_name || box.name_ar}
          size="lg"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-black text-slate-800 truncate">
                {box.name_ar}
              </div>
              {box.institution_name && (
                <div className="text-xs text-slate-600 truncate">
                  {box.institution_name}
                </div>
              )}
            </div>
            {!box.is_active && (
              <span className="chip bg-slate-200 text-slate-600 text-[10px]">
                معطّل
              </span>
            )}
          </div>
          <div className="font-black font-mono text-xl text-slate-800 mt-1">
            {EGP(box.current_balance)}
          </div>
        </div>
      </div>

      {/* Kind-specific details */}
      <div className="mt-3 space-y-1 text-xs text-slate-700 border-t border-white/50 pt-2">
        {box.kind === 'bank' && (
          <>
            {box.account_number && (
              <InfoRow icon={<Hash size={11} />} label="رقم الحساب" value={box.account_number} mono />
            )}
            {box.iban && (
              <InfoRow icon={<Hash size={11} />} label="IBAN" value={box.iban} mono />
            )}
            {box.bank_branch && (
              <InfoRow icon={<MapPin size={11} />} label="الفرع" value={box.bank_branch} />
            )}
            {box.account_holder_name && (
              <InfoRow icon={<User size={11} />} label="صاحب الحساب" value={box.account_holder_name} />
            )}
            {box.account_manager_name && (
              <InfoRow icon={<User size={11} />} label="مسؤول الحساب" value={box.account_manager_name} />
            )}
            {box.account_manager_phone && (
              <InfoRow icon={<Phone size={11} />} label="هاتف المسؤول" value={box.account_manager_phone} mono />
            )}
            {box.account_manager_email && (
              <InfoRow icon={<Mail size={11} />} label="بريد المسؤول" value={box.account_manager_email} />
            )}
          </>
        )}
        {box.kind === 'ewallet' && (
          <>
            {box.wallet_phone && (
              <InfoRow icon={<Phone size={11} />} label="رقم المحفظة" value={box.wallet_phone} mono />
            )}
            {box.wallet_owner_name && (
              <InfoRow icon={<User size={11} />} label="اسم المالك" value={box.wallet_owner_name} />
            )}
          </>
        )}
        {box.kind === 'check' && box.check_issuer_name && (
          <InfoRow icon={<User size={11} />} label="الجهة المصدرة" value={box.check_issuer_name} />
        )}
      </div>

      {canManage && (
        <div className="flex gap-1 mt-3 pt-2 border-t border-white/50">
          <button
            onClick={onEdit}
            className="flex-1 py-1.5 rounded-md bg-white/60 hover:bg-white text-xs font-bold flex items-center justify-center gap-1"
          >
            <Edit3 size={12} /> تعديل
          </button>
          <button
            onClick={() => toggleActive.mutate()}
            className="flex-1 py-1.5 rounded-md bg-white/60 hover:bg-white text-xs font-bold flex items-center justify-center gap-1"
            disabled={toggleActive.isPending}
          >
            {box.is_active ? (
              <>
                <PowerOff size={12} /> تعطيل
              </>
            ) : (
              <>
                <Power size={12} /> تفعيل
              </>
            )}
          </button>
          <button
            onClick={() => {
              if (confirm(`حذف الخزنة "${box.name_ar}"؟`)) del.mutate();
            }}
            className="py-1.5 px-2 rounded-md bg-rose-100 hover:bg-rose-200 text-rose-700"
            title="حذف"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-slate-500 shrink-0">
        {icon} {label}
      </span>
      <span className={`truncate text-left ${mono ? 'font-mono' : 'font-bold'}`}>
        {value}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Create / Edit modal
// ═══════════════════════════════════════════════════════════════════════

function CashboxFormModal({
  kind,
  editing,
  onClose,
}: {
  kind: CashboxKind;
  editing?: Cashbox;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!editing;

  const [form, setForm] = useState<CreateCashboxPayload>(() => ({
    name_ar: editing?.name_ar || '',
    kind,
    currency: editing?.currency || 'EGP',
    opening_balance: Number(editing?.opening_balance || 0),
    color: editing?.color || '',
    institution_code: editing?.institution_code || '',
    bank_branch: editing?.bank_branch || '',
    account_number: editing?.account_number || '',
    iban: editing?.iban || '',
    swift_code: editing?.swift_code || '',
    account_holder_name: editing?.account_holder_name || '',
    account_manager_name: editing?.account_manager_name || '',
    account_manager_phone: editing?.account_manager_phone || '',
    account_manager_email: editing?.account_manager_email || '',
    wallet_phone: editing?.wallet_phone || '',
    wallet_owner_name: editing?.wallet_owner_name || '',
    check_issuer_name: editing?.check_issuer_name || '',
    notes: editing?.notes || '',
  }));

  const instKind: 'bank' | 'ewallet' | 'check_issuer' | null =
    kind === 'bank'
      ? 'bank'
      : kind === 'ewallet'
        ? 'ewallet'
        : kind === 'check'
          ? 'check_issuer'
          : null;

  const { data: institutions = [] } = useQuery({
    queryKey: ['institutions', instKind],
    queryFn: () => cashDeskApi.institutions(instKind || undefined),
    enabled: !!instKind,
  });

  const selectedInst = institutions.find(
    (i) => i.code === form.institution_code,
  );

  const mutation = useMutation({
    mutationFn: () => {
      const payload: any = { ...form };
      // Strip empty strings so we don't overwrite with blanks.
      for (const k of Object.keys(payload)) {
        if (payload[k] === '') payload[k] = null;
      }
      if (isEdit) {
        return cashDeskApi.updateCashbox(editing!.id, payload);
      }
      return cashDeskApi.createCashbox(payload);
    },
    onSuccess: () => {
      toast.success(isEdit ? 'تم الحفظ' : 'تم إنشاء الخزنة');
      qc.invalidateQueries({ queryKey: ['cashboxes'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const Icon = KIND_ICON[kind];

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800 flex items-center gap-2">
            <Icon size={20} />
            {isEdit ? `تعديل ${editing.name_ar}` : `إضافة ${KIND_LABEL[kind]}`}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Common fields */}
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="اسم الخزنة">
              <input
                className="input"
                value={form.name_ar}
                onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
                placeholder="مثال: الخزينة الرئيسية"
                autoFocus
              />
            </Field>
            <Field label="العملة">
              <select
                className="input"
                value={form.currency || 'EGP'}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              >
                <option value="EGP">جنيه مصري (EGP)</option>
                <option value="USD">دولار (USD)</option>
                <option value="EUR">يورو (EUR)</option>
                <option value="SAR">ريال سعودي (SAR)</option>
              </select>
            </Field>
          </div>

          {!isEdit && (
            <Field label="الرصيد الافتتاحي">
              <input
                type="number"
                step="0.01"
                className="input"
                value={form.opening_balance || 0}
                onChange={(e) =>
                  setForm({
                    ...form,
                    opening_balance: Number(e.target.value) || 0,
                  })
                }
              />
            </Field>
          )}

          {/* Institution picker for bank/wallet */}
          {instKind && (
            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
              <div className="text-sm font-bold mb-2">
                اختر{' '}
                {kind === 'bank'
                  ? 'البنك'
                  : kind === 'ewallet'
                    ? 'المحفظة'
                    : 'الجهة المصدرة'}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-64 overflow-y-auto p-1">
                {institutions.map((inst) => (
                  <button
                    key={inst.code}
                    type="button"
                    onClick={() =>
                      setForm({ ...form, institution_code: inst.code })
                    }
                    className={`p-2 rounded-lg border-2 flex items-center gap-2 text-right transition hover:bg-white ${
                      form.institution_code === inst.code
                        ? 'border-brand-500 bg-white ring-2 ring-brand-200'
                        : 'border-slate-200 bg-white/70'
                    }`}
                  >
                    <InstitutionLogo
                      domain={inst.website_domain}
                      kind={inst.kind}
                      color={inst.color_hex}
                      label={inst.name_en}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold truncate">
                        {inst.name_ar}
                      </div>
                      {inst.short_code && (
                        <div className="text-[10px] text-slate-500 font-mono">
                          {inst.short_code}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              {selectedInst && (
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                  <InstitutionLogo
                    domain={selectedInst.website_domain}
                    kind={selectedInst.kind}
                    color={selectedInst.color_hex}
                    label={selectedInst.name_en}
                    size="sm"
                  />
                  تم اختيار: <b>{selectedInst.name_ar}</b>
                </div>
              )}
            </div>
          )}

          {/* Bank-specific fields */}
          {kind === 'bank' && (
            <>
              <div className="grid md:grid-cols-2 gap-3">
                <Field label="رقم الحساب">
                  <input
                    className="input font-mono"
                    value={form.account_number || ''}
                    onChange={(e) =>
                      setForm({ ...form, account_number: e.target.value })
                    }
                    placeholder="1234567890"
                  />
                </Field>
                <Field label="IBAN">
                  <input
                    className="input font-mono"
                    value={form.iban || ''}
                    onChange={(e) => setForm({ ...form, iban: e.target.value })}
                    placeholder="EG..."
                  />
                </Field>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <Field label="SWIFT / BIC">
                  <input
                    className="input font-mono"
                    value={form.swift_code || ''}
                    onChange={(e) =>
                      setForm({ ...form, swift_code: e.target.value })
                    }
                  />
                </Field>
                <Field label="الفرع">
                  <input
                    className="input"
                    value={form.bank_branch || ''}
                    onChange={(e) =>
                      setForm({ ...form, bank_branch: e.target.value })
                    }
                    placeholder="مثال: فرع المعادي"
                  />
                </Field>
              </div>
              <Field label="اسم صاحب الحساب">
                <input
                  className="input"
                  value={form.account_holder_name || ''}
                  onChange={(e) =>
                    setForm({ ...form, account_holder_name: e.target.value })
                  }
                />
              </Field>
              <div className="border border-slate-200 rounded-lg p-3 space-y-3 bg-slate-50">
                <div className="text-sm font-bold">مسؤول الحساب</div>
                <div className="grid md:grid-cols-2 gap-3">
                  <Field label="الاسم">
                    <input
                      className="input"
                      value={form.account_manager_name || ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          account_manager_name: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label="الهاتف">
                    <input
                      className="input font-mono"
                      value={form.account_manager_phone || ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          account_manager_phone: e.target.value,
                        })
                      }
                      placeholder="01xxxxxxxxx"
                    />
                  </Field>
                </div>
                <Field label="البريد الإلكتروني">
                  <input
                    type="email"
                    className="input"
                    value={form.account_manager_email || ''}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        account_manager_email: e.target.value,
                      })
                    }
                  />
                </Field>
              </div>
            </>
          )}

          {/* Wallet-specific fields */}
          {kind === 'ewallet' && (
            <div className="grid md:grid-cols-2 gap-3">
              <Field label="رقم المحفظة / الهاتف">
                <input
                  className="input font-mono"
                  value={form.wallet_phone || ''}
                  onChange={(e) =>
                    setForm({ ...form, wallet_phone: e.target.value })
                  }
                  placeholder="01xxxxxxxxx"
                />
              </Field>
              <Field label="اسم المالك">
                <input
                  className="input"
                  value={form.wallet_owner_name || ''}
                  onChange={(e) =>
                    setForm({ ...form, wallet_owner_name: e.target.value })
                  }
                />
              </Field>
            </div>
          )}

          {/* Check-specific fields */}
          {kind === 'check' && (
            <Field label="الجهة المصدرة الافتراضية">
              <input
                className="input"
                value={form.check_issuer_name || ''}
                onChange={(e) =>
                  setForm({ ...form, check_issuer_name: e.target.value })
                }
                placeholder="مثال: شيكات بنك CIB"
              />
            </Field>
          )}

          <Field label="ملاحظات">
            <textarea
              className="input"
              rows={2}
              value={form.notes || ''}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>

          <div className="flex gap-2 pt-2 border-t border-slate-100">
            <button
              className="btn-primary flex-1"
              disabled={mutation.isPending || !form.name_ar}
              onClick={() => mutation.mutate()}
            >
              {isEdit ? 'حفظ التعديلات' : 'إنشاء الخزنة'}
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
