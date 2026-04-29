/**
 * PaymentAccounts — PR-FIN-PAYACCT-4B
 * ───────────────────────────────────────────────────────────────────
 *
 * Dedicated admin page for managing `payment_accounts` rows.
 *
 * Layout (matches the approved design):
 *   • Top header: title / breadcrumb / primary "إضافة حساب دفع" / refresh
 *   • Right rail (sticky): cash-summary card, quick-actions, alerts
 *   • Main column: 6 KPI cards, warning strips, filters, dense table,
 *     bottom summary cards
 *   • Click row → details panel slides in (same column shift as design)
 *
 * Reads:
 *   • GET /payment-providers
 *   • GET /payment-accounts/balances  (PR-4B endpoint)
 *   • GET /cash-desk/cashboxes
 *   • GET /cash-desk/gl-drift         (PR-4B endpoint)
 *
 * Writes (via existing endpoints):
 *   • POST /payment-accounts                      (create)
 *   • PATCH /payment-accounts/:id                 (edit)
 *   • PATCH /payment-accounts/:id/set-default     (default flip)
 *   • POST  /payment-accounts/:id/toggle-active   (toggle active)
 *   • DELETE /payment-accounts/:id                (soft/hard delete)
 *
 * Permissions:
 *   • Route gated at App.tsx via `payment-accounts.read`
 *   • Mutating actions gated by `payment-accounts.manage` inside the
 *     page (buttons hidden / disabled when missing).
 *
 * Out of scope (per audit):
 *   • Per-account transaction list (placeholder in details panel)
 *   • Top-30-day usage chart (placeholder card at the bottom)
 *   • Official cheque-issuer logos (PR-4E)
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  Building2,
  CheckCheck,
  CheckCircle2,
  CreditCard,
  FileCheck,
  Filter,
  Plus,
  RefreshCcw,
  Smartphone,
  Star,
  Wallet,
  Wallet as WalletIcon,
  X,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import {
  paymentsApi,
  type PaymentAccount,
  type PaymentAccountBalance,
  type PaymentMethodCode,
  type PaymentProvider,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
import { cashDeskApi, type Cashbox } from '@/api/cash-desk.api';
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';
import { PaymentAccountModal } from '@/components/payment-accounts/PaymentAccountModal';
import { PaymentAccountAlerts } from '@/components/payment-accounts/PaymentAccountAlerts';

const EGP = (n: string | number) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

type TypeFilter = 'all' | 'wallet' | 'bank' | 'card' | 'check';

/** Coarse "type" derived from a row's method, mapping to the 4 KPI buckets. */
function typeOf(method: PaymentMethodCode): TypeFilter {
  if (method === 'instapay' || method === 'wallet' || method === 'vodafone_cash' || method === 'orange_cash') {
    return 'wallet';
  }
  if (method === 'bank_transfer') return 'bank';
  if (method === 'card_visa' || method === 'card_mastercard' || method === 'card_meeza') {
    return 'card';
  }
  if (method === 'check') return 'check';
  return 'all'; // 'cash' / 'credit' / 'other' — not surfaced by the 4 type filters
}

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: 'الكل',
  wallet: 'محافظ إلكترونية',
  bank: 'بنوك',
  card: 'نقاط بيع',
  check: 'شيكات',
};

const TYPE_ICONS: Record<Exclude<TypeFilter, 'all'>, any> = {
  wallet: WalletIcon,
  bank: Building2,
  card: CreditCard,
  check: FileCheck,
};

export default function PaymentAccounts() {
  const qc = useQueryClient();
  const canManage = useAuthStore((s) =>
    s.hasPermission('payment-accounts.manage'),
  );

  // ── Data ────────────────────────────────────────────────────────
  const providersQuery = useQuery({
    queryKey: ['payment-providers'],
    queryFn: () => paymentsApi.listProviders(),
    staleTime: 5 * 60 * 1000,
  });
  const balancesQuery = useQuery({
    queryKey: ['payment-accounts-balances'],
    queryFn: () => paymentsApi.listBalances(),
    staleTime: 30 * 1000,
  });
  const cashboxesQuery = useQuery({
    queryKey: ['cashboxes', 'all'],
    queryFn: () => cashDeskApi.cashboxes(true),
    staleTime: 30 * 1000,
  });
  const driftQuery = useQuery({
    queryKey: ['cashbox-gl-drift'],
    queryFn: () => cashDeskApi.glDrift(),
    staleTime: 30 * 1000,
  });

  const providers: PaymentProvider[] = providersQuery.data ?? [];
  const balances: PaymentAccountBalance[] = balancesQuery.data ?? [];
  const cashboxes: Cashbox[] = cashboxesQuery.data ?? [];
  const drifts = driftQuery.data ?? [];

  // ── Filters ─────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState<PaymentMethodCode | ''>('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>(
    'all',
  );
  const [defaultFilter, setDefaultFilter] = useState<'all' | 'default' | 'non-default'>('all');
  const [cashboxFilter, setCashboxFilter] = useState<string>('');

  function clearFilters() {
    setSearch('');
    setMethodFilter('');
    setTypeFilter('all');
    setActiveFilter('all');
    setDefaultFilter('all');
    setCashboxFilter('');
  }

  const filtered = useMemo(() => {
    return balances.filter((b) => {
      if (search) {
        const q = search.trim().toLowerCase();
        const hay = [
          b.display_name,
          b.provider_key ?? '',
          b.identifier ?? '',
          b.gl_account_code,
          METHOD_LABEL_AR[b.method as PaymentMethodCode] ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (methodFilter && b.method !== methodFilter) return false;
      if (typeFilter !== 'all' && typeOf(b.method as PaymentMethodCode) !== typeFilter)
        return false;
      if (activeFilter === 'active' && !b.active) return false;
      if (activeFilter === 'inactive' && b.active) return false;
      if (defaultFilter === 'default' && !b.is_default) return false;
      if (defaultFilter === 'non-default' && b.is_default) return false;
      if (cashboxFilter && b.cashbox_id !== cashboxFilter) return false;
      return true;
    });
  }, [balances, search, methodFilter, typeFilter, activeFilter, defaultFilter, cashboxFilter]);

  // ── KPI computations ────────────────────────────────────────────
  const kpis = useMemo(() => {
    const total = balances.length;
    const active = balances.filter((b) => b.active).length;
    const inactive = total - active;
    const methodsActive = new Set<string>();
    for (const b of balances) if (b.active) methodsActive.add(b.method);
    const methodsWithDefault = new Set<string>();
    for (const b of balances) if (b.active && b.is_default) methodsWithDefault.add(b.method);
    const noDefault = methodsActive.size - methodsWithDefault.size;

    const sumBy = (filter: (b: PaymentAccountBalance) => boolean) =>
      balances
        .filter(filter)
        .reduce((acc, b) => acc + Number(b.net_debit || 0), 0);

    // To avoid double-counting accounts that share gl_account_code +
    // null cashbox_id, dedupe by (gl_account_code | cashbox_id) when
    // summing per-bucket totals.
    const seen = new Set<string>();
    const sumDedupe = (filter: (b: PaymentAccountBalance) => boolean) => {
      let s = 0;
      for (const b of balances) {
        if (!filter(b)) continue;
        const key = `${b.gl_account_code}|${b.cashbox_id ?? 'null'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        s += Number(b.net_debit || 0);
      }
      seen.clear();
      return s;
    };

    const walletTotal = sumDedupe((b) => typeOf(b.method as PaymentMethodCode) === 'wallet');
    const bankTotal = sumDedupe((b) => typeOf(b.method as PaymentMethodCode) === 'bank');
    const cardTotal = sumDedupe((b) => typeOf(b.method as PaymentMethodCode) === 'card');
    const checkTotal = sumDedupe((b) => typeOf(b.method as PaymentMethodCode) === 'check');

    const lastMovement = balances
      .map((b) => b.last_movement)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    return {
      total, active, inactive, noDefault,
      walletTotal, bankTotal, cardTotal, checkTotal,
      lastMovement,
    };
  }, [balances]);

  // ── Selection ───────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = balances.find((b) => b.payment_account_id === selectedId) ?? null;

  // ── Modals ──────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState<{
    open: boolean;
    method: PaymentMethodCode | null;
  }>({ open: false, method: null });
  const [editingAccount, setEditingAccount] = useState<PaymentAccount | null>(null);

  // ── Actions ─────────────────────────────────────────────────────
  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => paymentsApi.setDefault(id),
    onSuccess: () => {
      toast.success('تم تعيين الحساب الافتراضي');
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'فشل التحديث'),
  });
  const toggleActiveMutation = useMutation({
    mutationFn: (id: string) => paymentsApi.toggleActive(id),
    onSuccess: () => {
      toast.success('تم تغيير حالة الحساب');
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'فشل التحديث'),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => paymentsApi.deleteAccount(id),
    onSuccess: (out) => {
      toast.success(out.mode === 'hard' ? 'تم حذف الحساب' : 'تم تعطيل الحساب (مرتبط بمعاملات سابقة)');
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
      setSelectedId(null);
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'فشل الحذف'),
  });

  function handleSetDefault(b: PaymentAccountBalance) {
    if (!canManage) return;
    setDefaultMutation.mutate(b.payment_account_id);
  }
  function handleToggleActive(b: PaymentAccountBalance) {
    if (!canManage) return;
    toggleActiveMutation.mutate(b.payment_account_id);
  }
  function handleDelete(b: PaymentAccountBalance) {
    if (!canManage) return;
    const ok = confirm(`هل أنت متأكد من حذف "${b.display_name}"؟`);
    if (!ok) return;
    deleteMutation.mutate(b.payment_account_id);
  }

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    qc.invalidateQueries({ queryKey: ['cashbox-gl-drift'] });
    qc.invalidateQueries({ queryKey: ['cashboxes', 'all'] });
    toast.success('تم تحديث البيانات');
  }

  const cashbox = cashboxes.find((c) => c.kind === 'cash');

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="space-y-4 pb-8" data-testid="payment-accounts-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="text-right">
          <div className="text-[11px] text-slate-500 mb-1" data-testid="payment-accounts-breadcrumb">
            الرئيسية / الإعدادات / حسابات الدفع
          </div>
          <h1 className="text-2xl font-black text-slate-900">حسابات الدفع</h1>
          <p className="text-sm text-slate-500 mt-1">
            إدارة حسابات الدفع المستخدمة في نقطة البيع ومقبوضات العملاء ومدفوعات الموردين
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshAll}
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            data-testid="payment-accounts-refresh"
          >
            <RefreshCcw size={14} /> تحديث الأرصدة
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => setCreateOpen({ open: true, method: null })}
              className="px-4 py-2 rounded-lg bg-pink-600 text-white text-sm font-bold hover:bg-pink-700 inline-flex items-center gap-1.5"
              data-testid="payment-accounts-add"
            >
              <Plus size={14} /> إضافة حساب دفع
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
        {/* MAIN COLUMN */}
        <div className="space-y-4">
          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3" data-testid="payment-accounts-kpis">
            <KpiTile
              testId="kpi-total"
              icon={<Wallet size={16} className="text-pink-600" />}
              label="كل الحسابات"
              value={String(kpis.total)}
              tone="pink"
            />
            <KpiTile
              testId="kpi-active"
              icon={<CheckCircle2 size={16} className="text-emerald-600" />}
              label="الحسابات النشطة"
              value={String(kpis.active)}
              tone="emerald"
            />
            <KpiTile
              testId="kpi-inactive"
              icon={<XCircle size={16} className="text-slate-500" />}
              label="الحسابات غير النشطة"
              value={String(kpis.inactive)}
              tone="slate"
              suffix="حساب"
            />
            <KpiTile
              testId="kpi-no-default"
              icon={<Star size={16} className="text-amber-600" />}
              label="بدون حساب افتراضي"
              value={String(kpis.noDefault)}
              tone="amber"
              suffix="طريقة دفع"
            />
            <KpiTile
              testId="kpi-wallet-balance"
              icon={<Smartphone size={16} className="text-emerald-600" />}
              label="أرصدة المحافظ"
              value={EGP(kpis.walletTotal)}
              tone="emerald"
              valueClass="text-base font-black"
            />
            <KpiTile
              testId="kpi-bank-balance"
              icon={<Building2 size={16} className="text-sky-600" />}
              label="أرصدة البنوك"
              value={EGP(kpis.bankTotal)}
              tone="sky"
              valueClass="text-base font-black"
            />
            <KpiTile
              testId="kpi-check-balance"
              icon={<FileCheck size={16} className="text-violet-600" />}
              label="أرصدة الشيكات"
              value={EGP(kpis.checkTotal)}
              tone="violet"
              valueClass="text-base font-black"
            />
          </div>

          {/* Warning strips — computed from real data */}
          <WarningStrips balances={balances} />

          {/* Filters */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="payment-accounts-filters">
            <div className="grid grid-cols-1 md:grid-cols-7 gap-3 items-end">
              <Field label="بحث">
                <input
                  className="input"
                  placeholder="بحث باسم الحساب / رقم الحساب / المزود..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="filter-search"
                />
              </Field>
              <Field label="طريقة الدفع">
                <select
                  className="input"
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value as any)}
                  data-testid="filter-method"
                >
                  <option value="">الكل</option>
                  {Object.entries(METHOD_LABEL_AR).map(([code, ar]) => (
                    <option key={code} value={code}>{ar}</option>
                  ))}
                </select>
              </Field>
              <Field label="النوع">
                <select
                  className="input"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
                  data-testid="filter-type"
                >
                  <option value="all">الكل</option>
                  <option value="wallet">{TYPE_LABELS.wallet}</option>
                  <option value="bank">{TYPE_LABELS.bank}</option>
                  <option value="card">{TYPE_LABELS.card}</option>
                  <option value="check">{TYPE_LABELS.check}</option>
                </select>
              </Field>
              <Field label="الحالة">
                <select
                  className="input"
                  value={activeFilter}
                  onChange={(e) => setActiveFilter(e.target.value as any)}
                  data-testid="filter-active"
                >
                  <option value="all">الكل</option>
                  <option value="active">نشط</option>
                  <option value="inactive">غير نشط</option>
                </select>
              </Field>
              <Field label="الافتراضي">
                <select
                  className="input"
                  value={defaultFilter}
                  onChange={(e) => setDefaultFilter(e.target.value as any)}
                  data-testid="filter-default"
                >
                  <option value="all">الكل</option>
                  <option value="default">افتراضي</option>
                  <option value="non-default">غير افتراضي</option>
                </select>
              </Field>
              <Field label="الخزنة المرتبطة">
                <select
                  className="input"
                  value={cashboxFilter}
                  onChange={(e) => setCashboxFilter(e.target.value)}
                  data-testid="filter-cashbox"
                >
                  <option value="">الكل</option>
                  {cashboxes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name_ar}</option>
                  ))}
                </select>
              </Field>
              <button
                type="button"
                onClick={clearFilters}
                className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
                data-testid="filter-clear"
              >
                <Filter size={12} /> مسح الفلاتر
              </button>
            </div>
          </div>

          {/* Main table */}
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <h2 className="font-bold text-sm text-slate-800">
                قائمة حسابات الدفع ({filtered.length} حساب)
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[11px] text-slate-600">
                  <tr>
                    <Th>الشعار</Th>
                    <Th>اسم الحساب</Th>
                    <Th>المزود</Th>
                    <Th>طريقة الدفع</Th>
                    <Th>الرقم / المعرف</Th>
                    <Th>حساب الأستاذ</Th>
                    <Th>الخزنة المرتبطة</Th>
                    <Th>الرصيد المحاسبي</Th>
                    <Th>الحركات</Th>
                    <Th>الحالة</Th>
                    <Th>افتراضي</Th>
                    <Th>الإجراءات</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="text-center py-8 text-slate-500 text-sm">
                        لا توجد حسابات مطابقة للفلتر الحالي
                      </td>
                    </tr>
                  ) : filtered.map((b) => {
                    const provider = providers.find((p) => p.provider_key === b.provider_key);
                    const isSelected = b.payment_account_id === selectedId;
                    const linkedCb = cashboxes.find((c) => c.id === b.cashbox_id);
                    return (
                      <tr
                        key={b.payment_account_id}
                        onClick={() => setSelectedId(b.payment_account_id)}
                        className={`cursor-pointer hover:bg-slate-50 ${
                          isSelected ? 'bg-pink-50' : ''
                        }`}
                        data-testid={`payment-account-row-${b.payment_account_id}`}
                      >
                        <Td>
                          <PaymentProviderLogo
                            logoDataUrl={(b.metadata as any)?.logo_data_url}
                            logoKey={provider?.logo_key}
                            method={b.method as PaymentMethodCode}
                            name={b.display_name}
                            size="sm"
                            decorative
                          />
                        </Td>
                        <Td><span className="font-bold text-slate-800">{b.display_name}</span></Td>
                        <Td><span className="text-slate-600">{provider?.name_ar ?? b.provider_key ?? '—'}</span></Td>
                        <Td>
                          <span className="px-2 py-0.5 rounded bg-slate-100 text-[11px] font-bold text-slate-700">
                            {METHOD_LABEL_AR[b.method as PaymentMethodCode] ?? b.method}
                          </span>
                        </Td>
                        <Td className="font-mono text-[11px]">{b.identifier ?? '—'}</Td>
                        <Td>
                          <div className="font-mono text-xs text-slate-700">{b.gl_account_code}</div>
                          <div className="text-[10px] text-slate-500 truncate max-w-32">{b.gl_name_ar ?? ''}</div>
                        </Td>
                        <Td>
                          {linkedCb ? (
                            <span className="text-xs text-slate-700">{linkedCb.name_ar}</span>
                          ) : (
                            <span className="text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded">غير مربوط</span>
                          )}
                        </Td>
                        <Td className="font-mono text-xs">{EGP(b.net_debit)}</Td>
                        <Td className="text-center">{b.je_count}</Td>
                        <Td>
                          {b.active ? (
                            <span className="text-[11px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">نشط</span>
                          ) : (
                            <span className="text-[11px] font-bold bg-rose-100 text-rose-700 px-2 py-0.5 rounded">غير نشط</span>
                          )}
                        </Td>
                        <Td className="text-center">
                          {b.is_default ? (
                            <span className="text-[10px] font-bold bg-amber-500/20 text-amber-700 px-2 py-0.5 rounded inline-flex items-center gap-0.5">
                              <Star size={10} /> افتراضي
                            </span>
                          ) : '—'}
                        </Td>
                        <Td>
                          {canManage && (
                            <RowActions
                              onEdit={(e) => {
                                e.stopPropagation();
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                setEditingAccount(b as any as PaymentAccount);
                              }}
                              onSetDefault={(e) => {
                                e.stopPropagation();
                                handleSetDefault(b);
                              }}
                              onToggleActive={(e) => {
                                e.stopPropagation();
                                handleToggleActive(b);
                              }}
                              onDelete={(e) => {
                                e.stopPropagation();
                                handleDelete(b);
                              }}
                            />
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bottom summary cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3" data-testid="payment-accounts-summary">
            <SummaryCard title="ملخص أرصدة حسابات الدفع">
              <div className="space-y-2 text-sm">
                <Row label="إجمالي الداخل" value={EGP(balances.reduce((s, b) => s + Number(b.total_in || 0), 0))} tone="emerald" />
                <Row label="إجمالي الخارج" value={EGP(balances.reduce((s, b) => s + Number(b.total_out || 0), 0))} tone="rose" />
                <Row label="عدد الحسابات" value={String(balances.length)} />
              </div>
            </SummaryCard>
            <SummaryCard title="توزيع الحسابات حسب النوع">
              <DistributionMini balances={balances} />
            </SummaryCard>
            <SummaryCard title="أكثر الطرق استخدامًا (آخر 30 يوم)">
              <div className="text-xs text-slate-500">
                {/* PR-FIN-PAYACCT-4B: placeholder. The 30-day usage endpoint
                    is deferred to a follow-up PR; today this card tells the
                    operator how to read it once the data lands. */}
                هذه الإحصائية ستتاح عند توفر API استخدام الطرق آخر 30 يوم.
              </div>
            </SummaryCard>
          </div>
        </div>

        {/* RIGHT RAIL */}
        <aside className="space-y-3" data-testid="payment-accounts-rail">
          {/* Cash KPI summary */}
          {cashbox && (
            <div className="rounded-2xl border border-slate-200 bg-emerald-50/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Banknote size={14} className="text-emerald-700" />
                <span className="font-bold text-sm text-emerald-800">{cashbox.name_ar}</span>
              </div>
              <div className="text-2xl font-black text-emerald-800 font-mono">
                {EGP(cashbox.current_balance)}
              </div>
              <Link
                to={`/cashboxes`}
                className="text-[11px] text-emerald-700 hover:underline mt-1 block"
              >
                عرض التفاصيل ←
              </Link>
            </div>
          )}

          {/* Quick actions */}
          {canManage && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2" data-testid="payment-accounts-quick-actions">
              <h3 className="font-bold text-sm text-slate-800 mb-2">إجراءات سريعة</h3>
              <QuickAction
                onClick={() => setCreateOpen({ open: true, method: 'bank_transfer' })}
                icon={<Building2 size={14} />}
                label="إضافة حساب بنكي"
                testId="quick-add-bank"
              />
              <QuickAction
                onClick={() => setCreateOpen({ open: true, method: 'wallet' })}
                icon={<WalletIcon size={14} />}
                label="إضافة محفظة إلكترونية"
                testId="quick-add-wallet"
              />
              <QuickAction
                onClick={() => setCreateOpen({ open: true, method: 'instapay' })}
                icon={<Smartphone size={14} />}
                label="إضافة حساب InstaPay"
                testId="quick-add-instapay"
              />
              <QuickAction
                onClick={() => setCreateOpen({ open: true, method: 'card_visa' })}
                icon={<CreditCard size={14} />}
                label="إضافة جهاز POS / بطاقة"
                testId="quick-add-card"
              />
              <QuickAction
                onClick={() => setCreateOpen({ open: true, method: 'check' })}
                icon={<FileCheck size={14} />}
                label="إضافة حساب شيكات"
                testId="quick-add-check"
              />
            </div>
          )}

          {/* Accounting alerts */}
          <PaymentAccountAlerts
            accounts={balances as unknown as PaymentAccount[]}
            balances={balances}
            drifts={drifts}
          />
        </aside>
      </div>

      {/* Side details panel */}
      {selected && (
        <DetailsPanel
          balance={selected}
          provider={providers.find((p) => p.provider_key === selected.provider_key) ?? null}
          cashbox={cashboxes.find((c) => c.id === selected.cashbox_id) ?? null}
          canManage={canManage}
          onClose={() => setSelectedId(null)}
          onEdit={() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            setEditingAccount(selected as unknown as PaymentAccount);
          }}
          onSetDefault={() => handleSetDefault(selected)}
          onToggleActive={() => handleToggleActive(selected)}
          onDelete={() => handleDelete(selected)}
        />
      )}

      {/* Create modal */}
      {createOpen.open && canManage && (
        <PaymentAccountModal
          mode="create"
          prefilledMethod={createOpen.method}
          providers={providers}
          cashboxes={cashboxes}
          onClose={() => setCreateOpen({ open: false, method: null })}
        />
      )}

      {/* Edit modal */}
      {editingAccount && canManage && (
        <PaymentAccountModal
          mode="edit"
          account={editingAccount}
          providers={providers}
          cashboxes={cashboxes}
          onClose={() => setEditingAccount(null)}
        />
      )}
    </div>
  );
}

// ─────────────── Sub-components ───────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-right font-bold whitespace-nowrap">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 text-right whitespace-nowrap ${className ?? ''}`}>{children}</td>;
}

const TONE_CLASSES: Record<string, string> = {
  pink: 'border-pink-200 bg-pink-50',
  emerald: 'border-emerald-200 bg-emerald-50/40',
  slate: 'border-slate-200 bg-slate-50',
  amber: 'border-amber-200 bg-amber-50',
  sky: 'border-sky-200 bg-sky-50',
  violet: 'border-violet-200 bg-violet-50',
};

function KpiTile({
  testId,
  icon,
  label,
  value,
  tone = 'slate',
  suffix,
  valueClass,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: keyof typeof TONE_CLASSES;
  suffix?: string;
  valueClass?: string;
}) {
  return (
    <div
      className={`rounded-2xl border p-3 ${TONE_CLASSES[tone] ?? TONE_CLASSES.slate}`}
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`font-black text-slate-900 ${valueClass ?? 'text-2xl'}`}>{value}</div>
      {suffix && <div className="text-[10px] text-slate-500 mt-0.5">{suffix}</div>}
    </div>
  );
}

function WarningStrips({ balances }: { balances: PaymentAccountBalance[] }) {
  const noDefaultMethods = useMemo(() => {
    const activeByMethod = new Map<string, PaymentAccountBalance[]>();
    for (const b of balances) {
      if (!b.active) continue;
      const arr = activeByMethod.get(b.method) ?? [];
      arr.push(b);
      activeByMethod.set(b.method, arr);
    }
    return Array.from(activeByMethod.entries())
      .filter(([, arr]) => !arr.some((b) => b.is_default))
      .map(([m]) => m);
  }, [balances]);

  const unlinkedAccounts = useMemo(
    () => balances.filter((b) => b.active && !b.cashbox_id),
    [balances],
  );

  if (noDefaultMethods.length === 0 && unlinkedAccounts.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="payment-accounts-warnings">
      {noDefaultMethods.map((m) => (
        <div
          key={`nodef-${m}`}
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center justify-between"
          data-testid={`warning-no-default-${m}`}
        >
          <div className="flex items-center gap-2">
            <Star size={14} className="text-amber-600" />
            <div className="text-xs text-amber-800">
              طريقة <strong>{METHOD_LABEL_AR[m as keyof typeof METHOD_LABEL_AR] ?? m}</strong> لا يوجد لها حساب افتراضي نشط
            </div>
          </div>
        </div>
      ))}
      {unlinkedAccounts.length > 0 && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center justify-between"
          data-testid="warning-unlinked-accounts"
        >
          <div className="flex items-center gap-2">
            <Star size={14} className="text-amber-600" />
            <div className="text-xs text-amber-800">
              {unlinkedAccounts.length} حساب نشط غير مربوط بخزنة
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuickAction({
  onClick,
  icon,
  label,
  testId,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 hover:border-pink-300 transition"
      data-testid={testId}
    >
      <span className="text-pink-600">{icon}</span>
      <span className="font-bold">{label}</span>
    </button>
  );
}

function RowActions({
  onEdit, onSetDefault, onToggleActive, onDelete,
}: {
  onEdit: (e: React.MouseEvent) => void;
  onSetDefault: (e: React.MouseEvent) => void;
  onToggleActive: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="flex items-center gap-1 justify-end">
      <button onClick={onEdit} className="text-[11px] px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200" data-testid="row-action-edit">تعديل</button>
      <button onClick={onSetDefault} className="text-[11px] px-2 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200" data-testid="row-action-set-default">افتراضي</button>
      <button onClick={onToggleActive} className="text-[11px] px-2 py-1 rounded bg-sky-100 text-sky-700 hover:bg-sky-200" data-testid="row-action-toggle-active">تفعيل/تعطيل</button>
      <button onClick={onDelete} className="text-[11px] px-2 py-1 rounded bg-rose-100 text-rose-700 hover:bg-rose-200" data-testid="row-action-delete">حذف</button>
    </div>
  );
}

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="font-bold text-sm text-slate-800 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'rose' }) {
  const cls = tone === 'emerald' ? 'text-emerald-700' : tone === 'rose' ? 'text-rose-700' : 'text-slate-800';
  return (
    <div className="flex justify-between">
      <span className="text-slate-600">{label}</span>
      <span className={`font-mono font-bold ${cls}`}>{value}</span>
    </div>
  );
}

function DistributionMini({ balances }: { balances: PaymentAccountBalance[] }) {
  const buckets = useMemo(() => {
    const init: Record<Exclude<TypeFilter, 'all'>, number> = { wallet: 0, bank: 0, card: 0, check: 0 };
    for (const b of balances) {
      const t = typeOf(b.method as PaymentMethodCode);
      if (t === 'all') continue;
      init[t]++;
    }
    return init;
  }, [balances]);
  const total = buckets.wallet + buckets.bank + buckets.card + buckets.check;

  return (
    <div className="space-y-2 text-sm">
      {(Object.entries(buckets) as Array<[Exclude<TypeFilter, 'all'>, number]>).map(
        ([type, n]) => {
          const Icon = TYPE_ICONS[type];
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          return (
            <div key={type} className="flex items-center gap-2">
              <Icon size={12} className="text-slate-500" />
              <span className="flex-1 text-slate-700">{TYPE_LABELS[type]}</span>
              <span className="text-slate-500 text-xs">{n} ({pct}%)</span>
            </div>
          );
        },
      )}
    </div>
  );
}

function DetailsPanel({
  balance, provider, cashbox, canManage,
  onClose, onEdit, onSetDefault, onToggleActive, onDelete,
}: {
  balance: PaymentAccountBalance;
  provider: PaymentProvider | null;
  cashbox: Cashbox | null;
  canManage: boolean;
  onClose: () => void;
  onEdit: () => void;
  onSetDefault: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/30"
      onClick={onClose}
      data-testid="payment-account-details-overlay"
    >
      <div
        className="absolute top-0 left-0 h-full w-full max-w-md bg-white shadow-2xl border-r border-slate-200 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid="payment-account-details-panel"
      >
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            <PaymentProviderLogo
              logoDataUrl={(balance.metadata as any)?.logo_data_url}
              logoKey={provider?.logo_key}
              method={balance.method as PaymentMethodCode}
              name={balance.display_name}
              size="md"
              decorative
            />
            <div>
              <div className="font-bold text-slate-900">{balance.display_name}</div>
              <div className="text-[11px] text-slate-500">
                {provider?.name_ar ?? balance.provider_key ?? '—'} · {METHOD_LABEL_AR[balance.method as PaymentMethodCode]}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded" aria-label="إغلاق">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <DetailRow label="المعرف" value={balance.identifier ?? '—'} mono />
            <DetailRow label="حساب الأستاذ" value={`${balance.gl_account_code} — ${balance.gl_name_ar ?? ''}`} mono />
            <DetailRow label="الخزنة المرتبطة" value={cashbox?.name_ar ?? '— غير مربوط —'} />
            <DetailRow label="الحالة" value={balance.active ? 'نشط' : 'غير نشط'} tone={balance.active ? 'emerald' : 'rose'} />
            <DetailRow label="افتراضي" value={balance.is_default ? 'نعم' : 'لا'} />
            <DetailRow label="آخر حركة" value={balance.last_movement ?? '—'} />
          </div>

          {/* Balance summary */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2 text-sm">
            <Row label="إجمالي الداخل" value={EGP(balance.total_in)} tone="emerald" />
            <Row label="إجمالي الخارج" value={EGP(balance.total_out)} tone="rose" />
            <Row label="الرصيد المحاسبي" value={EGP(balance.net_debit)} />
            <Row label="عدد القيود" value={String(balance.je_count)} />
          </div>

          {/* Last 5 movements (placeholder) */}
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-bold text-slate-700 mb-1">آخر 5 حركات</div>
            <div className="text-[11px] text-slate-500">
              ستتوفر عند تفعيل API حركات الحساب التفصيلية.
            </div>
          </div>

          {canManage && (
            <div className="space-y-2">
              <button
                onClick={onEdit}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-bold hover:bg-slate-50"
                data-testid="details-action-edit"
              >
                تعديل
              </button>
              <button
                onClick={onSetDefault}
                disabled={balance.is_default}
                className="w-full px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-sm font-bold hover:bg-amber-100 disabled:opacity-40"
                data-testid="details-action-set-default"
              >
                <CheckCheck size={14} className="inline -mt-0.5 ml-1" />
                تعيين افتراضي
              </button>
              <button
                onClick={onToggleActive}
                className="w-full px-3 py-2 rounded-lg border border-sky-300 bg-sky-50 text-sky-800 text-sm font-bold hover:bg-sky-100"
                data-testid="details-action-toggle-active"
              >
                {balance.active ? 'تعطيل' : 'تفعيل'}
              </button>
              <button
                onClick={onDelete}
                className="w-full px-3 py-2 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 text-sm font-bold hover:bg-rose-100"
                data-testid="details-action-delete"
              >
                حذف
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label, value, tone, mono,
}: { label: string; value: string; tone?: 'emerald' | 'rose'; mono?: boolean }) {
  const valueCls = tone === 'emerald' ? 'text-emerald-700' : tone === 'rose' ? 'text-rose-700' : 'text-slate-800';
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-sm font-bold ${valueCls} ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
