/**
 * Cashboxes — unified treasury page (PR-FIN-PAYACCT-4D).
 *
 * Replaces both the old isolated /cashboxes (cashbox CRUD only) and
 * /payment-accounts (admin admin only) experiences with a single
 * treasury surface that reflects how operators actually think:
 *
 *   physical cash ⊕ bank accounts ⊕ e-wallets ⊕ POS terminals
 *   ⊕ InstaPay ⊕ cheque accounts — all under one roof, with
 *   real-time balances, drift alerts, and 30-day usage mix.
 *
 * Routes:
 *   • /cashboxes        — this page (canonical)
 *   • /payment-accounts — redirects here (PR-FIN-PAYACCT-4B compat)
 *
 * Reuses the PR-4B components verbatim:
 *   • PaymentAccountModal  — create/edit a payment_account row
 *   • PaymentAccountAlerts — accounting alerts panel (extended in 4D
 *     with two new alert types)
 *   • PaymentProviderLogo  — initials-fallback aware
 *
 * Right-rail RTL fix (vs PR-4B): grid-cols-[320px_1fr] with the rail
 * as the FIRST child. In RTL the first grid child takes the rightmost
 * slot, putting the rail visually on the right where it belongs.
 *
 * Data sources (all read-only, all real):
 *   • GET /cash-desk/cashboxes
 *   • GET /cash-desk/movements
 *   • GET /cash-desk/gl-drift
 *   • GET /payment-providers
 *   • GET /payment-accounts/balances
 *   • GET /payments/method-mix?days=30   ← new in 4D
 */
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
  CreditCard,
  Star,
  ShieldAlert,
  Activity,
  RefreshCcw,
  ListChecks,
  PieChart,
} from 'lucide-react';

import {
  cashDeskApi,
  Cashbox,
  CashboxKind,
  FinancialInstitution,
  CreateCashboxPayload,
  CashboxMovement,
} from '@/api/cash-desk.api';
import {
  paymentsApi,
  type PaymentAccount,
  type PaymentAccountBalance,
  type PaymentMethodCode,
  type PaymentMethodMixRow,
  type PaymentProvider,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
import { InstitutionLogo } from '@/components/InstitutionLogo';
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';
import { PaymentAccountModal } from '@/components/payment-accounts/PaymentAccountModal';
import { PaymentAccountAlerts } from '@/components/payment-accounts/PaymentAccountAlerts';
import { useAuthStore } from '@/stores/auth.store';
// The daily cash-desk operations (receipts / supplier pays / deposits)
// live in their own page now — we no longer embed them here so this
// screen stays focused on cashbox MANAGEMENT only.

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

// ─── Tab keys for the unified treasury page ────────────────────────
type TabKey =
  | 'all'
  | 'cashboxes'
  | 'payment-accounts'
  | 'banks-wallets'
  | 'pos-cards'
  | 'cheques'
  | 'today'
  | 'alerts';

/**
 * Coarse "type" derived from a payment_account method, used for the
 * inner filter on the "حسابات الدفع" tab and for KPI bucketing.
 *
 * Mirrors the mapping in `pages/PaymentAccounts.tsx` (PR-4B).
 */
type PaymentAccountKind = 'wallet' | 'bank' | 'card' | 'check' | 'instapay';

function paymentAccountKind(m: PaymentMethodCode): PaymentAccountKind | null {
  if (m === 'instapay') return 'instapay';
  if (m === 'wallet' || m === 'vodafone_cash' || m === 'orange_cash') return 'wallet';
  if (m === 'bank_transfer') return 'bank';
  if (m === 'card_visa' || m === 'card_mastercard' || m === 'card_meeza') return 'card';
  if (m === 'check') return 'check';
  return null; // 'cash' / 'credit' / 'other' don't surface here
}

export default function Cashboxes() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManageCashboxes = hasPermission('cashdesk.manage_accounts');
  const canManageAccounts  = hasPermission('payment-accounts.manage');

  const [tab, setTab] = useState<TabKey>('all');
  // Cashbox sub-filters (the "الخزائن" tab keeps the legacy controls).
  const [cashboxKindFilter, setCashboxKindFilter] = useState<CashboxKind | ''>('');
  const [cashboxSearch, setCashboxSearch] = useState('');
  // Payment-account sub-filter (under the "حسابات الدفع" tab).
  const [paFilter, setPaFilter] = useState<'' | PaymentAccountKind>('');
  const [paSearch, setPaSearch] = useState('');

  // Cashbox-side modals
  const [showCreate, setShowCreate] = useState<CashboxKind | null>(null);
  const [editing, setEditing] = useState<Cashbox | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  // Payment-account modal
  const [paCreate, setPaCreate] = useState<{ open: boolean; method: PaymentMethodCode | null }>({
    open: false,
    method: null,
  });
  const [paEditing, setPaEditing] = useState<PaymentAccount | null>(null);

  // ─── Live data ────────────────────────────────────────────────────
  const { data: boxes = [], isLoading: boxesLoading } = useQuery({
    queryKey: ['cashboxes', 'all'],
    queryFn: () => cashDeskApi.cashboxes(true),
  });
  const { data: balances = [] } = useQuery({
    queryKey: ['payment-accounts-balances'],
    queryFn: () => paymentsApi.listBalances(),
    staleTime: 30_000,
  });
  const { data: drifts = [] } = useQuery({
    queryKey: ['cashbox-gl-drift'],
    queryFn: () => cashDeskApi.glDrift(),
    staleTime: 30_000,
  });
  const { data: providers = [] } = useQuery({
    queryKey: ['payment-providers'],
    queryFn: () => paymentsApi.listProviders(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: methodMix = [] } = useQuery({
    queryKey: ['payments-method-mix-30d'],
    queryFn: () => paymentsApi.methodMix(30),
    staleTime: 5 * 60 * 1000,
  });
  // Today's movements feed (cashbox-side; non-cash account flows still
  // ride this view when their cashbox_id is pinned — PR-DRIFT-3F).
  const todayISO = new Date().toISOString().slice(0, 10);
  const { data: todayMovements = [] } = useQuery({
    queryKey: ['cashbox-movements-today', todayISO],
    queryFn: () => cashDeskApi.movements({ from: todayISO, to: todayISO, limit: 200 }),
    staleTime: 15_000,
  });

  // ─── KPI math (8 tiles) ───────────────────────────────────────────
  const kpis = useMemo(() => {
    const byKind: Record<CashboxKind, { count: number; balance: number }> = {
      cash:    { count: 0, balance: 0 },
      bank:    { count: 0, balance: 0 },
      ewallet: { count: 0, balance: 0 },
      check:   { count: 0, balance: 0 },
    };
    for (const b of boxes.filter((b) => b.is_active)) {
      byKind[b.kind].count++;
      byKind[b.kind].balance += Number(b.current_balance || 0);
    }

    // Payment-accounts buckets (POS / cards = card kind).
    const paBalanceByKind: Record<PaymentAccountKind, number> = {
      wallet: 0, bank: 0, card: 0, check: 0, instapay: 0,
    };
    const seenKey = new Set<string>();
    for (const b of balances) {
      const k = paymentAccountKind(b.method as PaymentMethodCode);
      if (!k) continue;
      // Dedupe by (gl_account_code|cashbox_id) so accounts that share a
      // bucket don't double-count.
      const key = `${b.gl_account_code}|${b.cashbox_id ?? 'null'}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      paBalanceByKind[k] += Number(b.net_debit || 0);
    }

    // Methods with active rows but no `is_default=true`.
    const activeMethods = new Set<string>();
    const defaultedMethods = new Set<string>();
    for (const b of balances) {
      if (!b.active) continue;
      activeMethods.add(b.method);
      if (b.is_default) defaultedMethods.add(b.method);
    }
    const noDefaultCount = activeMethods.size - defaultedMethods.size;

    // Drift: any cashbox where |drift_amount| > 0.01.
    const driftCount = drifts.filter((d) => Math.abs(Number(d.drift_amount || 0)) > 0.01).length;

    const totalBalance =
      byKind.cash.balance + byKind.bank.balance + byKind.ewallet.balance + byKind.check.balance;

    return {
      total: totalBalance,
      cash: byKind.cash.balance,
      bank: byKind.bank.balance + paBalanceByKind.bank,
      wallet: byKind.ewallet.balance + paBalanceByKind.wallet + paBalanceByKind.instapay,
      card: paBalanceByKind.card,
      check: byKind.check.balance + paBalanceByKind.check,
      noDefault: noDefaultCount,
      driftCount,
    };
  }, [boxes, balances, drifts]);

  // ─── Filtered cashboxes (الخزائن tab) ─────────────────────────────
  const filteredBoxes = useMemo(() => {
    return boxes.filter((b) => {
      if (cashboxKindFilter && b.kind !== cashboxKindFilter) return false;
      if (cashboxSearch) {
        const s = cashboxSearch.toLowerCase();
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
  }, [boxes, cashboxKindFilter, cashboxSearch]);

  // ─── Filtered payment accounts (per active tab) ───────────────────
  const filteredAccounts = useMemo(() => {
    let kindFilter: PaymentAccountKind | '' = paFilter;
    if (tab === 'banks-wallets')   kindFilter = ''; // multi-kind in renderer
    if (tab === 'pos-cards')       kindFilter = 'card';
    if (tab === 'cheques')         kindFilter = 'check';

    return balances.filter((b) => {
      const k = paymentAccountKind(b.method as PaymentMethodCode);
      if (tab === 'banks-wallets') {
        if (k !== 'bank' && k !== 'wallet' && k !== 'instapay') return false;
      } else if (kindFilter && k !== kindFilter) {
        return false;
      }
      if (paSearch) {
        const s = paSearch.toLowerCase();
        const hay = [
          b.display_name,
          b.provider_key ?? '',
          b.identifier ?? '',
          b.gl_account_code,
          METHOD_LABEL_AR[b.method as PaymentMethodCode] ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [balances, tab, paFilter, paSearch]);

  // ─── Mutations on payment_accounts (reused from PR-4B page) ───────
  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => paymentsApi.setDefault(id),
    onSuccess: () => {
      toast.success('تم تعيين الحساب الافتراضي');
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل التحديث'),
  });
  const toggleAccountMutation = useMutation({
    mutationFn: (id: string) => paymentsApi.toggleActive(id),
    onSuccess: () => {
      toast.success('تم تغيير حالة الحساب');
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل التحديث'),
  });
  const deleteAccountMutation = useMutation({
    mutationFn: (id: string) => paymentsApi.deleteAccount(id),
    onSuccess: (out) => {
      toast.success(out.mode === 'hard' ? 'تم حذف الحساب' : 'تم تعطيل الحساب');
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل الحذف'),
  });

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ['cashboxes'] });
    qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    qc.invalidateQueries({ queryKey: ['cashbox-gl-drift'] });
    qc.invalidateQueries({ queryKey: ['cashbox-movements-today'] });
    qc.invalidateQueries({ queryKey: ['payments-method-mix-30d'] });
    toast.success('تم تحديث البيانات');
  }

  const cashCashbox = boxes.find((c) => c.kind === 'cash' && c.is_active);

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="space-y-4 pb-8" data-testid="treasury-page">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Wallet className="text-brand-600" /> الخزائن والحسابات البنكية
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            نقدي · حسابات بنكية · محافظ إلكترونية · نقاط بيع · شيكات
          </p>
        </div>
        <div className="flex gap-2 flex-wrap" data-testid="treasury-actions">
          <button
            className="btn-secondary"
            onClick={refreshAll}
            data-testid="treasury-refresh"
            title="تحديث الأرصدة"
          >
            <RefreshCcw size={14} /> تحديث الأرصدة
          </button>
          <button
            className="btn-primary"
            onClick={() => setShowTransfer(true)}
            disabled={boxes.filter((b) => b.is_active).length < 2}
            title="تحويل نقدية بين خزنتين"
            data-testid="treasury-transfer"
          >
            <ArrowRightLeft size={16} /> تحويل بين الخزائن
          </button>
          {canManageCashboxes && (
            <>
              <button
                className="btn-secondary"
                onClick={() => setShowCreate('cash')}
                data-testid="treasury-add-cash"
              >
                <Wallet size={14} />
                <Plus size={12} /> إضافة نقدي
              </button>
              <button
                className="btn-secondary"
                onClick={() => setShowCreate('bank')}
                data-testid="treasury-add-bank"
              >
                <Building2 size={14} />
                <Plus size={12} /> إضافة حساب بنكي
              </button>
              <button
                className="btn-secondary"
                onClick={() => setShowCreate('ewallet')}
                data-testid="treasury-add-ewallet"
              >
                <Smartphone size={14} />
                <Plus size={12} /> إضافة محفظة إلكترونية
              </button>
              <button
                className="btn-secondary"
                onClick={() => setShowCreate('check')}
                data-testid="treasury-add-check-cashbox"
              >
                <FileCheck size={14} />
                <Plus size={12} /> إضافة حساب شيكات
              </button>
            </>
          )}
          {canManageAccounts && (
            <button
              className="btn-secondary"
              onClick={() => setPaCreate({ open: true, method: 'card_visa' })}
              data-testid="treasury-add-pos-card"
            >
              <CreditCard size={14} />
              <Plus size={12} /> إضافة جهاز POS / بطاقة
            </button>
          )}
        </div>
      </div>

      {/* KPI strip — 8 tiles */}
      <div
        className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2"
        data-testid="treasury-kpis"
      >
        <KpiTile testId="kpi-total"     label="إجمالي الرصيد"        value={EGP(kpis.total)}     tone="pink"    icon={<Wallet size={14} />} />
        <KpiTile testId="kpi-cash"      label="نقدي"                 value={EGP(kpis.cash)}      tone="emerald" icon={<Wallet size={14} />} />
        <KpiTile testId="kpi-bank"      label="حسابات بنكية"          value={EGP(kpis.bank)}      tone="indigo"  icon={<Building2 size={14} />} />
        <KpiTile testId="kpi-wallet"    label="محافظ إلكترونية"        value={EGP(kpis.wallet)}    tone="purple"  icon={<Smartphone size={14} />} />
        <KpiTile testId="kpi-card"      label="نقاط بيع / بطاقات"     value={EGP(kpis.card)}      tone="sky"     icon={<CreditCard size={14} />} />
        <KpiTile testId="kpi-check"     label="شيكات"                value={EGP(kpis.check)}     tone="amber"   icon={<FileCheck size={14} />} />
        <KpiTile testId="kpi-no-default" label="حسابات بدون افتراضي"  value={String(kpis.noDefault)} suffix="طريقة" tone="slate" icon={<Star size={14} />} />
        <KpiTile testId="kpi-drift"    label="فروق محاسبية"         value={String(kpis.driftCount)} suffix="خزنة"   tone="rose"  icon={<ShieldAlert size={14} />} />
      </div>

      {/* Right rail (RIGHT in RTL) + main column.
          RTL invariant: grid children flow right→left, so the FIRST child
          takes the rightmost slot. We put the rail first → it appears on
          the right; the main column (1fr) takes the left/wide slot. */}
      <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4" data-testid="treasury-grid">
        {/* RIGHT RAIL */}
        <aside className="space-y-3 xl:order-first" data-testid="treasury-rail">
          {cashCashbox && (
            <div
              className="rounded-2xl border border-slate-200 bg-emerald-50/30 p-4"
              data-testid="treasury-rail-cash-summary"
            >
              <div className="flex items-center gap-2 mb-1">
                <Wallet size={14} className="text-emerald-700" />
                <span className="font-bold text-sm text-emerald-800">
                  {cashCashbox.name_ar}
                </span>
              </div>
              <div className="text-2xl font-black text-emerald-800 font-mono">
                {EGP(cashCashbox.current_balance)}
              </div>
              <button
                onClick={() => setTab('cashboxes')}
                className="text-[11px] text-emerald-700 hover:underline mt-1 block"
              >
                عرض التفاصيل ←
              </button>
            </div>
          )}

          {canManageAccounts && (
            <div
              className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2"
              data-testid="treasury-quick-actions"
            >
              <h3 className="font-bold text-sm text-slate-800 mb-2">إجراءات سريعة</h3>
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'bank_transfer' })} icon={<Building2 size={14} />} label="إضافة حساب بنكي"          testId="quick-add-bank" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'wallet' })}        icon={<Smartphone size={14} />} label="إضافة محفظة إلكترونية"  testId="quick-add-wallet" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'instapay' })}      icon={<Smartphone size={14} />} label="إضافة حساب InstaPay"    testId="quick-add-instapay" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'card_visa' })}     icon={<CreditCard size={14} />} label="إضافة جهاز POS / بطاقة" testId="quick-add-card" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'check' })}         icon={<FileCheck size={14} />}  label="إضافة حساب شيكات"      testId="quick-add-check" />
            </div>
          )}

          <PaymentAccountAlerts
            accounts={balances as unknown as PaymentAccount[]}
            balances={balances}
            drifts={drifts}
          />
        </aside>

        {/* MAIN COLUMN */}
        <div className="space-y-4 min-w-0">
          {/* Tabs */}
          <div className="rounded-2xl border border-slate-200 bg-white overflow-x-auto" data-testid="treasury-tabs">
            <div className="flex flex-nowrap gap-1 p-2">
              <Tab tab={tab} setTab={setTab} value="all"              label="الكل"                  testId="tab-all" />
              <Tab tab={tab} setTab={setTab} value="cashboxes"        label="الخزائن"               testId="tab-cashboxes" />
              <Tab tab={tab} setTab={setTab} value="payment-accounts" label="حسابات الدفع"           testId="tab-payment-accounts" />
              <Tab tab={tab} setTab={setTab} value="banks-wallets"   label="البنوك والمحافظ"        testId="tab-banks-wallets" />
              <Tab tab={tab} setTab={setTab} value="pos-cards"       label="نقاط البيع / البطاقات" testId="tab-pos-cards" />
              <Tab tab={tab} setTab={setTab} value="cheques"          label="الشيكات"               testId="tab-cheques" />
              <Tab tab={tab} setTab={setTab} value="today"            label="حركة اليوم"             testId="tab-today" />
              <Tab tab={tab} setTab={setTab} value="alerts"           label="التنبيهات"              testId="tab-alerts" />
            </div>
          </div>

          {/* Tab content */}
          {tab === 'all' && (
            <AllOverview
              boxes={boxes}
              balances={balances}
              canManageCashboxes={canManageCashboxes}
              onCashboxEdit={setEditing}
              onAccountSelect={(b) => {
                setTab('payment-accounts');
                setPaSearch(b.display_name);
              }}
            />
          )}

          {tab === 'cashboxes' && (
            <CashboxesPanel
              boxes={filteredBoxes}
              isLoading={boxesLoading}
              kindFilter={cashboxKindFilter}
              setKindFilter={setCashboxKindFilter}
              search={cashboxSearch}
              setSearch={setCashboxSearch}
              canManage={canManageCashboxes}
              onEdit={setEditing}
            />
          )}

          {(tab === 'payment-accounts' || tab === 'banks-wallets' || tab === 'pos-cards' || tab === 'cheques') && (
            <PaymentAccountsTable
              tab={tab}
              accounts={filteredAccounts}
              providers={providers}
              cashboxes={boxes}
              search={paSearch}
              setSearch={setPaSearch}
              kindFilter={paFilter}
              setKindFilter={setPaFilter}
              canManage={canManageAccounts}
              onEdit={(b) => setPaEditing(b as unknown as PaymentAccount)}
              onSetDefault={(b) => canManageAccounts && setDefaultMutation.mutate(b.payment_account_id)}
              onToggleActive={(b) => canManageAccounts && toggleAccountMutation.mutate(b.payment_account_id)}
              onDelete={(b) => {
                if (!canManageAccounts) return;
                const ok = window.confirm(`هل أنت متأكد من حذف "${b.display_name}"؟`);
                if (ok) deleteAccountMutation.mutate(b.payment_account_id);
              }}
            />
          )}

          {tab === 'today' && <TodayMovementsPanel rows={todayMovements} />}

          {tab === 'alerts' && (
            <PaymentAccountAlerts
              accounts={balances as unknown as PaymentAccount[]}
              balances={balances}
              drifts={drifts}
            />
          )}

          {/* Bottom dashboard cards (3) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3" data-testid="treasury-summary">
            <SummaryCard title="ملخص أرصدة حسابات الدفع" testId="summary-balance" icon={<ListChecks size={14} className="text-slate-600" />}>
              <BalanceSummary balances={balances} />
            </SummaryCard>
            <SummaryCard title="توزيع الحسابات حسب النوع" testId="summary-distribution" icon={<PieChart size={14} className="text-slate-600" />}>
              <DistributionCard balances={balances} />
            </SummaryCard>
            <SummaryCard title="أكثر الطرق استخدامًا (آخر 30 يوم)" testId="summary-method-mix" icon={<Activity size={14} className="text-slate-600" />}>
              <MethodMixCard rows={methodMix} />
            </SummaryCard>
          </div>
        </div>
      </div>

      {/* Cashbox modals (preserved from pre-4D) */}
      {showCreate && <CashboxFormModal kind={showCreate} onClose={() => setShowCreate(null)} />}
      {editing &&    <CashboxFormModal kind={editing.kind} editing={editing} onClose={() => setEditing(null)} />}
      {showTransfer && (
        <TransferModal
          boxes={boxes.filter((b) => b.is_active)}
          onClose={() => setShowTransfer(false)}
        />
      )}

      {/* Payment-account modals (reused from PR-4B) */}
      {paCreate.open && canManageAccounts && (
        <PaymentAccountModal
          mode="create"
          prefilledMethod={paCreate.method}
          providers={providers}
          cashboxes={boxes}
          onClose={() => setPaCreate({ open: false, method: null })}
        />
      )}
      {paEditing && canManageAccounts && (
        <PaymentAccountModal
          mode="edit"
          account={paEditing}
          providers={providers}
          cashboxes={boxes}
          onClose={() => setPaEditing(null)}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Sub-components — kept inline so the unified treasury page stays
 * editable as one file. None of these talk to the network on their
 * own; the parent passes already-loaded data in.
 * ──────────────────────────────────────────────────────────────────── */

function Tab({
  tab,
  setTab,
  value,
  label,
  testId,
}: {
  tab: TabKey;
  setTab: (v: TabKey) => void;
  value: TabKey;
  label: string;
  testId: string;
}) {
  const active = tab === value;
  return (
    <button
      type="button"
      onClick={() => setTab(value)}
      data-testid={testId}
      className={
        active
          ? 'px-3 py-1.5 rounded-lg bg-brand-50 text-brand-700 text-xs font-bold whitespace-nowrap'
          : 'px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-50 text-xs font-bold whitespace-nowrap'
      }
    >
      {label}
    </button>
  );
}

function KpiTile({
  testId, label, value, tone, suffix, icon,
}: {
  testId: string;
  label: string;
  value: string;
  tone: 'pink' | 'emerald' | 'indigo' | 'purple' | 'sky' | 'amber' | 'slate' | 'rose';
  suffix?: string;
  icon?: React.ReactNode;
}) {
  const toneCls: Record<string, string> = {
    pink:    'border-pink-200 bg-pink-50/60',
    emerald: 'border-emerald-200 bg-emerald-50/60',
    indigo:  'border-indigo-200 bg-indigo-50/60',
    purple:  'border-purple-200 bg-purple-50/60',
    sky:     'border-sky-200 bg-sky-50/60',
    amber:   'border-amber-200 bg-amber-50/60',
    slate:   'border-slate-200 bg-slate-50/60',
    rose:    'border-rose-200 bg-rose-50/60',
  };
  return (
    <div data-testid={testId} className={`rounded-2xl border p-3 ${toneCls[tone]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 mb-1">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="font-black text-base text-slate-900 font-mono truncate">{value}</div>
      {suffix && <div className="text-[10px] text-slate-500 mt-0.5">{suffix}</div>}
    </div>
  );
}

function QuickAction({
  onClick, icon, label, testId,
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

function AllOverview({
  boxes, balances, canManageCashboxes, onCashboxEdit, onAccountSelect,
}: {
  boxes: Cashbox[];
  balances: PaymentAccountBalance[];
  canManageCashboxes: boolean;
  onCashboxEdit: (b: Cashbox) => void;
  onAccountSelect: (b: PaymentAccountBalance) => void;
}) {
  const activeBoxes    = boxes.filter((b) => b.is_active);
  const activeAccounts = balances.filter((b) => b.active);
  return (
    <div className="space-y-4" data-testid="treasury-overview">
      {/* Cashboxes (top 6) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-sm text-slate-800">الخزائن</h3>
          <span className="text-xs text-slate-500">{activeBoxes.length} خزنة نشطة</span>
        </div>
        {activeBoxes.length === 0 ? (
          <EmptyState>لا توجد خزائن نشطة بعد.</EmptyState>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeBoxes.slice(0, 6).map((b) => (
              <CashboxCard key={b.id} box={b} canManage={canManageCashboxes} onEdit={() => onCashboxEdit(b)} />
            ))}
          </div>
        )}
      </section>

      {/* Payment accounts (top 8) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-sm text-slate-800">حسابات الدفع النشطة</h3>
          <span className="text-xs text-slate-500">{activeAccounts.length} حساب</span>
        </div>
        {activeAccounts.length === 0 ? (
          <EmptyState>لا توجد حسابات دفع نشطة بعد.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {activeAccounts.slice(0, 8).map((b) => (
              <li
                key={b.payment_account_id}
                className="py-2 flex items-center gap-3 cursor-pointer hover:bg-slate-50 px-2 rounded"
                onClick={() => onAccountSelect(b)}
                data-testid={`overview-account-${b.payment_account_id}`}
              >
                <div className="text-xs font-bold text-slate-500 w-24 truncate">
                  {METHOD_LABEL_AR[b.method as PaymentMethodCode] ?? b.method}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm text-slate-800 truncate">{b.display_name}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {b.identifier ?? '—'} · GL {b.gl_account_code}
                  </div>
                </div>
                <div className="font-mono text-sm text-slate-800">{EGP(b.net_debit)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CashboxesPanel({
  boxes, isLoading, kindFilter, setKindFilter, search, setSearch, canManage, onEdit,
}: {
  boxes: Cashbox[];
  isLoading: boolean;
  kindFilter: CashboxKind | '';
  setKindFilter: (k: CashboxKind | '') => void;
  search: string;
  setSearch: (s: string) => void;
  canManage: boolean;
  onEdit: (b: Cashbox) => void;
}) {
  return (
    <div className="space-y-3" data-testid="cashboxes-panel">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pr-9"
            placeholder="بحث باسم الخزنة / البنك / رقم الحساب / المسؤول..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="cashboxes-search"
          />
        </div>
        <select
          className="input w-48"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as CashboxKind | '')}
          data-testid="cashboxes-kind-filter"
        >
          <option value="">كل الأنواع</option>
          <option value="cash">نقدي</option>
          <option value="bank">بنكي</option>
          <option value="ewallet">محفظة إلكترونية</option>
          <option value="check">شيكات</option>
        </select>
      </div>
      {isLoading ? (
        <EmptyState>جارٍ التحميل…</EmptyState>
      ) : boxes.length === 0 ? (
        <EmptyState>لا توجد خزائن مطابقة.</EmptyState>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {boxes.map((b) => (
            <CashboxCard key={b.id} box={b} canManage={canManage} onEdit={() => onEdit(b)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PaymentAccountsTable({
  tab, accounts, providers, cashboxes, search, setSearch, kindFilter, setKindFilter,
  canManage, onEdit, onSetDefault, onToggleActive, onDelete,
}: {
  tab: TabKey;
  accounts: PaymentAccountBalance[];
  providers: PaymentProvider[];
  cashboxes: Cashbox[];
  search: string;
  setSearch: (s: string) => void;
  kindFilter: '' | PaymentAccountKind;
  setKindFilter: (k: '' | PaymentAccountKind) => void;
  canManage: boolean;
  onEdit: (b: PaymentAccountBalance) => void;
  onSetDefault: (b: PaymentAccountBalance) => void;
  onToggleActive: (b: PaymentAccountBalance) => void;
  onDelete: (b: PaymentAccountBalance) => void;
}) {
  const showInnerKindFilter = tab === 'payment-accounts';
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden" data-testid="payment-accounts-panel">
      <div className="flex items-center gap-3 flex-wrap p-3 border-b border-slate-100">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pr-9"
            placeholder="بحث باسم الحساب / المعرف / المزود…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="payment-accounts-search"
          />
        </div>
        {showInnerKindFilter && (
          <select
            className="input w-48"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as '' | PaymentAccountKind)}
            data-testid="payment-accounts-kind-filter"
          >
            <option value="">كل الأنواع</option>
            <option value="instapay">InstaPay</option>
            <option value="wallet">محفظة</option>
            <option value="card">POS / بطاقة</option>
            <option value="bank">تحويل بنكي</option>
            <option value="check">شيكات</option>
          </select>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] text-slate-600">
            <tr>
              <Th>الشعار</Th>
              <Th>اسم الحساب</Th>
              <Th>المزود</Th>
              <Th>الطريقة</Th>
              <Th>المعرف</Th>
              <Th>الأستاذ</Th>
              <Th>الخزنة</Th>
              <Th>الرصيد</Th>
              <Th>القيود</Th>
              <Th>الحالة</Th>
              <Th>افتراضي</Th>
              {canManage && <Th>الإجراءات</Th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 12 : 11} className="text-center py-8 text-slate-500 text-sm">
                  لا توجد حسابات مطابقة للفلتر الحالي
                </td>
              </tr>
            ) : (
              accounts.map((b) => {
                const provider = providers.find((p) => p.provider_key === b.provider_key);
                const linkedCb = cashboxes.find((c) => c.id === b.cashbox_id);
                return (
                  <tr
                    key={b.payment_account_id}
                    data-testid={`payment-account-row-${b.payment_account_id}`}
                    className="hover:bg-slate-50"
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
                    {canManage && (
                      <Td>
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => onEdit(b)}         className="text-[11px] px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200" data-testid="row-action-edit">تعديل</button>
                          <button onClick={() => onSetDefault(b)}   className="text-[11px] px-2 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200" data-testid="row-action-set-default">افتراضي</button>
                          <button onClick={() => onToggleActive(b)} className="text-[11px] px-2 py-1 rounded bg-sky-100 text-sky-700 hover:bg-sky-200"       data-testid="row-action-toggle-active">تفعيل/تعطيل</button>
                          <button onClick={() => onDelete(b)}       className="text-[11px] px-2 py-1 rounded bg-rose-100 text-rose-700 hover:bg-rose-200"   data-testid="row-action-delete">حذف</button>
                        </div>
                      </Td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TodayMovementsPanel({ rows }: { rows: CashboxMovement[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="today-movements">
        <EmptyState>لا توجد حركات اليوم بعد.</EmptyState>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden" data-testid="today-movements">
      <div className="px-4 py-3 border-b border-slate-100">
        <h3 className="font-bold text-sm text-slate-800">حركة اليوم ({rows.length})</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] text-slate-600">
            <tr>
              <Th>الخزنة</Th>
              <Th>الاتجاه</Th>
              <Th>المبلغ</Th>
              <Th>النوع</Th>
              <Th>المرجع</Th>
              <Th>الطرف الآخر</Th>
              <Th>الوقت</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} data-testid={`today-row-${r.id}`} className="hover:bg-slate-50">
                <Td>{r.cashbox_name ?? '—'}</Td>
                <Td>
                  {r.direction === 'in' ? (
                    <span className="text-[11px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">داخل</span>
                  ) : (
                    <span className="text-[11px] font-bold bg-rose-100 text-rose-700 px-2 py-0.5 rounded">خارج</span>
                  )}
                </Td>
                <Td className="font-mono">{EGP(r.amount)}</Td>
                <Td>
                  <span className="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{r.kind_ar || r.category}</span>
                </Td>
                <Td className="text-[11px] text-slate-600">{r.reference_no ?? r.reference_type ?? '—'}</Td>
                <Td className="text-[11px] text-slate-600">{r.counterparty_name ?? '—'}</Td>
                <Td className="text-[11px] text-slate-500">{new Date(r.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({
  title, icon, testId, children,
}: {
  title: string;
  icon?: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4" data-testid={testId}>
      <div className="flex items-center gap-1.5 mb-3">
        {icon}
        <h3 className="font-bold text-sm text-slate-800">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function BalanceSummary({ balances }: { balances: PaymentAccountBalance[] }) {
  const totalIn  = balances.reduce((s, b) => s + Number(b.total_in  || 0), 0);
  const totalOut = balances.reduce((s, b) => s + Number(b.total_out || 0), 0);
  const total    = balances.reduce((s, b) => s + Number(b.net_debit || 0), 0);
  const jeCount  = balances.reduce((s, b) => s + Number(b.je_count  || 0), 0);
  return (
    <ul className="space-y-1.5 text-sm">
      <Row label="عدد الحسابات" value={String(balances.length)} />
      <Row label="إجمالي الداخل"  value={EGP(totalIn)}  tone="emerald" />
      <Row label="إجمالي الخارج"  value={EGP(totalOut)} tone="rose" />
      <Row label="إجمالي الرصيد" value={EGP(total)} />
      <Row label="عدد القيود"    value={String(jeCount)} />
    </ul>
  );
}

function DistributionCard({ balances }: { balances: PaymentAccountBalance[] }) {
  const buckets: Record<PaymentAccountKind, number> = {
    wallet: 0, bank: 0, card: 0, check: 0, instapay: 0,
  };
  for (const b of balances) {
    const k = paymentAccountKind(b.method as PaymentMethodCode);
    if (k) buckets[k]++;
  }
  const total = buckets.wallet + buckets.bank + buckets.card + buckets.check + buckets.instapay;
  if (total === 0) return <EmptyState>لا توجد حسابات دفع لعرض التوزيع.</EmptyState>;
  const labels: Record<PaymentAccountKind, string> = {
    wallet: 'محافظ', bank: 'تحويل بنكي', card: 'POS / بطاقات', check: 'شيكات', instapay: 'InstaPay',
  };
  return (
    <ul className="space-y-1.5 text-sm">
      {(Object.keys(buckets) as PaymentAccountKind[]).map((k) => {
        const n = buckets[k];
        const pct = total > 0 ? Math.round((n / total) * 100) : 0;
        return (
          <li key={k} className="flex items-center gap-2" data-testid={`dist-${k}`}>
            <span className="flex-1 text-slate-700">{labels[k]}</span>
            <span className="text-slate-500 text-xs">{n} ({pct}%)</span>
          </li>
        );
      })}
    </ul>
  );
}

function MethodMixCard({ rows }: { rows: PaymentMethodMixRow[] }) {
  if (rows.length === 0) {
    return (
      <div data-testid="method-mix-empty">
        <EmptyState>لا توجد بيانات استخدام في آخر 30 يوم.</EmptyState>
      </div>
    );
  }
  return (
    <ul className="space-y-1.5 text-sm" data-testid="method-mix-list">
      {rows.map((r) => {
        const isCash = r.payment_method === 'cash';
        return (
          <li key={r.payment_method} className="flex items-center gap-2" data-testid={`mix-${r.payment_method}`}>
            <span
              className={
                isCash
                  ? 'text-[10px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded'
                  : 'text-[10px] font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded'
              }
            >
              {isCash ? 'نقدي' : 'غير نقدي'}
            </span>
            <span className="flex-1 text-slate-700 text-xs">
              {METHOD_LABEL_AR[r.payment_method as PaymentMethodCode] ?? r.payment_method}
            </span>
            <span className="font-mono text-[11px] text-slate-700">{EGP(r.total_amount)}</span>
            <span className="text-[10px] text-slate-500 w-12 text-left">{Number(r.pct).toFixed(1)}%</span>
          </li>
        );
      })}
    </ul>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'rose' }) {
  const cls = tone === 'emerald' ? 'text-emerald-700' : tone === 'rose' ? 'text-rose-700' : 'text-slate-800';
  return (
    <li className="flex items-center justify-between">
      <span className="text-slate-600">{label}</span>
      <span className={`font-mono font-bold ${cls}`}>{value}</span>
    </li>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-center text-slate-400 text-sm py-8" data-testid="empty-state">
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-right font-bold whitespace-nowrap">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 text-right whitespace-nowrap ${className ?? ''}`}>{children}</td>;
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
