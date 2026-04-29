/**
 * Cashboxes — table-first treasury / payment-accounts admin page
 * (PR-FIN-PAYACCT-4D-UX-FIX).
 *
 * UI/layout-only repositioning of the unified treasury page to match
 * the approved screenshot. **No accounting behavior, no GL posting,
 * no balance changes.** All values come from the same read-only
 * endpoints already in production:
 *
 *   • GET /payment-accounts/balances     ← v_payment_account_balance
 *   • GET /cash-desk/cashboxes
 *   • GET /cash-desk/gl-drift            ← v_cashbox_gl_drift
 *   • GET /cash-desk/movements           ← v_cashbox_movements
 *   • GET /payment-providers
 *   • GET /payments/method-mix?days=30   ← v_dashboard_payment_mix_30d
 *
 * Layout (right→left in RTL):
 *
 *   ┌───────────────────────────────────────────────┬────────────┐
 *   │ Header (breadcrumb / title / subtitle / btns) │            │
 *   │ KPI row (7 tiles)                             │  RIGHT     │
 *   │ Warning strips                                │  RAIL      │
 *   │ Filters row                                   │  (cash     │
 *   │ Main TABLE (15 columns, paginated)            │   summary  │
 *   │ Bottom 3 dashboard cards                      │   quick    │
 *   │                                               │   actions  │
 *   │                                               │   alerts)  │
 *   └───────────────────────────────────────────────┴────────────┘
 *
 * RTL right-rail invariant: `xl:grid-cols-[320px_1fr]` with the rail
 * as the FIRST grid child — RTL flow puts the first child in the
 * rightmost slot.
 *
 * Reuses PR-4B components verbatim: PaymentAccountModal,
 * PaymentAccountAlerts, PaymentProviderLogo. Reuses PR-4D data
 * hooks (paymentsApi.listBalances/methodMix/listProviders, cashDeskApi.cashboxes/glDrift/movements).
 *
 * Cashbox CRUD + transfer surface through the header overflow menu
 * (the existing TransferModal / CashboxFormModal still live further
 * down this file untouched).
 */
import { useMemo, useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Plus,
  X,
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
  ArrowRightLeft,
  CreditCard,
  Star,
  ShieldAlert,
  RefreshCcw,
  Activity,
  PieChart,
  ListChecks,
  MoreVertical,
  AlertTriangle,
  Edit3,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Trash2,
  PowerOff,
  Power,
  CheckCheck,
} from 'lucide-react';

import {
  cashDeskApi,
  Cashbox,
  CashboxKind,
  FinancialInstitution,
  CreateCashboxPayload,
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
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';
import { PaymentAccountModal } from '@/components/payment-accounts/PaymentAccountModal';
import { PaymentAccountAlerts } from '@/components/payment-accounts/PaymentAccountAlerts';
import { InstitutionLogo } from '@/components/InstitutionLogo';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Icon used by `CashboxFormModal` (kept verbatim from earlier PRs) to
 * render the kind-specific avatar in its header. The full kind grid
 * has been retired from the main view; only this icon mapping is
 * still consumed below.
 */
const KIND_ICON: Record<CashboxKind, any> = {
  cash:    Wallet,
  bank:    Building2,
  ewallet: Smartphone,
  check:   FileCheck,
};

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

/**
 * Coarse "type" derived from a payment_account method, used for the
 * النوع column + type filter + bottom distribution card. Mirrors the
 * grouping used everywhere else in this codebase.
 */
type PaymentAccountKind = 'wallet' | 'bank' | 'card' | 'check' | 'instapay';

function paymentAccountKind(m: PaymentMethodCode): PaymentAccountKind | null {
  if (m === 'instapay') return 'instapay';
  if (m === 'wallet' || m === 'vodafone_cash' || m === 'orange_cash') return 'wallet';
  if (m === 'bank_transfer') return 'bank';
  if (m === 'card_visa' || m === 'card_mastercard' || m === 'card_meeza') return 'card';
  if (m === 'check') return 'check';
  return null; // 'cash' / 'credit' / 'other' — not surfaced
}

const KIND_AR_LABEL: Record<PaymentAccountKind, string> = {
  wallet:   'محفظة إلكترونية',
  bank:     'تحويل بنكي',
  card:     'نقاط بيع',
  check:    'شيكات',
  instapay: 'إنستا باي',
};

/** Methods where pinning a `cashbox_id` is recommended (mirrors the same
 *  set used by `PaymentAccountAlerts` for the "no-cashbox-pin" alert). */
const PIN_RECOMMENDED_METHODS = new Set<PaymentMethodCode>([
  'bank_transfer',
  'card_visa', 'card_mastercard', 'card_meeza',
  'instapay',
  'wallet', 'vodafone_cash', 'orange_cash',
  'check',
]);

/** Arabic relative-time helper for the "آخر حركة" KPI/column. */
function relativeArabic(iso: string | null): string {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const ms = Date.now() - ts;
  const min = Math.floor(ms / 60_000);
  if (min < 1)  return 'الآن';
  if (min < 60) return `منذ ${min} دقيقة`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `منذ ${hr} ساعة`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'أمس';
  if (days < 7)   return `منذ ${days} أيام`;
  return new Date(iso).toLocaleDateString('en-CA');
}

function shortClock(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ════════════════════════════════════════════════════════════════════
 * Main page
 * ════════════════════════════════════════════════════════════════════ */
export default function Cashboxes() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManageCashboxes = hasPermission('cashdesk.manage_accounts');
  const canManageAccounts  = hasPermission('payment-accounts.manage');

  // ── Filters ────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState<PaymentMethodCode | ''>('');
  const [typeFilter, setTypeFilter] = useState<'' | PaymentAccountKind>('');
  const [activeFilter, setActiveFilter] = useState<'' | 'active' | 'inactive'>('');
  const [defaultFilter, setDefaultFilter] = useState<'' | 'default' | 'non-default'>('');
  const [cashboxFilter, setCashboxFilter] = useState<string>('');

  function clearFilters() {
    setSearch('');
    setMethodFilter('');
    setTypeFilter('');
    setActiveFilter('');
    setDefaultFilter('');
    setCashboxFilter('');
    setPage(1);
  }

  // ── Pagination (client-side) ───────────────────────────────────────
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState<number>(1);

  // ── Modals ─────────────────────────────────────────────────────────
  const [paCreate, setPaCreate] = useState<{ open: boolean; method: PaymentMethodCode | null }>({
    open: false, method: null,
  });
  const [paEditing, setPaEditing] = useState<PaymentAccount | null>(null);
  const [showCreateCashbox, setShowCreateCashbox] = useState<CashboxKind | null>(null);
  const [editingCashbox, setEditingCashbox]       = useState<Cashbox | null>(null);
  const [showTransfer, setShowTransfer]           = useState(false);
  const [showOverflow, setShowOverflow]           = useState(false);

  // ── Selected row (visual highlight) ────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Live data (no mocks, no fallbacks) ─────────────────────────────
  const { data: boxes = [] } = useQuery({
    queryKey: ['cashboxes', 'all'],
    queryFn: () => cashDeskApi.cashboxes(true),
    staleTime: 30_000,
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
  // /cash-desk/movements is consumed by the "آخر حركة" KPI to surface
  // the cash-side movement timestamp when it's newer than any
  // payment_account `last_movement` (e.g. internal transfers).
  const todayISO = new Date().toISOString().slice(0, 10);
  const { data: recentMovements = [] } = useQuery({
    queryKey: ['cashbox-movements-today', todayISO],
    queryFn: () => cashDeskApi.movements({ from: todayISO, to: todayISO, limit: 1 }),
    staleTime: 30_000,
  });

  // ── Filtered + sorted accounts (no fake rows) ──────────────────────
  const filteredAccounts = useMemo(() => {
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
      if (typeFilter) {
        const k = paymentAccountKind(b.method as PaymentMethodCode);
        if (k !== typeFilter) return false;
      }
      if (activeFilter === 'active'   && !b.active) return false;
      if (activeFilter === 'inactive' &&  b.active) return false;
      if (defaultFilter === 'default'     && !b.is_default) return false;
      if (defaultFilter === 'non-default' &&  b.is_default) return false;
      if (cashboxFilter && b.cashbox_id !== cashboxFilter) return false;
      return true;
    });
  }, [balances, search, methodFilter, typeFilter, activeFilter, defaultFilter, cashboxFilter]);

  // Reset page when filters narrow the result set out of bounds.
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [filteredAccounts.length, pageSize, page]);

  const pagedAccounts = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredAccounts.slice(start, start + pageSize);
  }, [filteredAccounts, page, pageSize]);

  // ── KPI math (7 tiles) ─────────────────────────────────────────────
  const kpis = useMemo(() => {
    const total    = balances.length;
    const active   = balances.filter((b) => b.active).length;
    const inactive = total - active;

    // Active methods missing a default.
    const activeMethods    = new Set<string>();
    const defaultedMethods = new Set<string>();
    for (const b of balances) {
      if (!b.active) continue;
      activeMethods.add(b.method);
      if (b.is_default) defaultedMethods.add(b.method);
    }
    const noDefault = activeMethods.size - defaultedMethods.size;

    // Wallet / bank totals — dedupe by (gl_account_code | cashbox_id)
    // so accounts that share a bucket don't double-count.
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
    const walletTotal = sumDedupe((b) => {
      const k = paymentAccountKind(b.method as PaymentMethodCode);
      return k === 'wallet' || k === 'instapay';
    });
    const bankTotal = sumDedupe((b) => paymentAccountKind(b.method as PaymentMethodCode) === 'bank');

    // "آخر حركة" = max(last_movement across balances, latest cashbox movement)
    const balanceLast = balances
      .map((b) => b.last_movement)
      .filter((s): s is string => !!s)
      .sort();
    const latestBalanceMovement = balanceLast[balanceLast.length - 1] ?? null;
    const latestCashboxMovement = recentMovements[0]?.created_at ?? null;
    const latestMovement =
      [latestBalanceMovement, latestCashboxMovement]
        .filter((s): s is string => !!s)
        .sort()
        .pop() ?? null;

    return {
      total, active, inactive, noDefault,
      walletTotal, bankTotal,
      latestMovement,
    };
  }, [balances, recentMovements]);

  // ── Warning-strip data (computed from the same balances; no extra fetch) ──
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
    () =>
      balances.filter(
        (b) =>
          b.active &&
          !b.cashbox_id &&
          PIN_RECOMMENDED_METHODS.has(b.method as PaymentMethodCode),
      ),
    [balances],
  );

  // ── Per-row warning resolver (for the "التحذيرات" column) ──────────
  function rowWarnings(b: PaymentAccountBalance): string[] {
    const out: string[] = [];
    if (
      b.active &&
      !b.cashbox_id &&
      PIN_RECOMMENDED_METHODS.has(b.method as PaymentMethodCode)
    ) {
      out.push('غير مربوط بخزنة');
    }
    if (b.active && noDefaultMethods.includes(b.method)) {
      out.push('لا يوجد افتراضي');
    }
    return out;
  }

  // ── Mutations on payment_accounts ──────────────────────────────────
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
      setSelectedId(null);
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

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 pb-8" data-testid="treasury-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap" data-testid="treasury-header">
        <div className="text-right">
          <div className="text-[11px] text-slate-500 mb-1" data-testid="treasury-breadcrumb">
            الرئيسية / الإعدادات / حسابات الدفع
          </div>
          <h1 className="text-2xl font-black text-slate-900">حسابات الدفع</h1>
          <p className="text-sm text-slate-500 mt-1">
            إدارة حسابات الدفع المستخدمة في نقطة البيع ومقبوضات العملاء ومدفوعات الموردين
          </p>
        </div>
        <div className="flex items-center gap-2 relative" data-testid="treasury-actions">
          {canManageAccounts && (
            <button
              type="button"
              onClick={() => setPaCreate({ open: true, method: null })}
              className="px-4 py-2 rounded-lg bg-pink-600 text-white text-sm font-bold hover:bg-pink-700 inline-flex items-center gap-1.5"
              data-testid="treasury-add-payment-account"
            >
              <Plus size={14} /> إضافة حساب دفع
            </button>
          )}
          <button
            type="button"
            onClick={refreshAll}
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            data-testid="treasury-refresh"
          >
            <RefreshCcw size={14} /> تحديث الأرصدة
          </button>
          <OverflowMenu
            open={showOverflow}
            onToggle={() => setShowOverflow((v) => !v)}
            onClose={() => setShowOverflow(false)}
            disabledTransfer={boxes.filter((b) => b.is_active).length < 2}
            canManageCashboxes={canManageCashboxes}
            onTransfer={() => { setShowOverflow(false); setShowTransfer(true); }}
            onAddCash={() => { setShowOverflow(false); setShowCreateCashbox('cash'); }}
            onAddBank={() => { setShowOverflow(false); setShowCreateCashbox('bank'); }}
            onAddEwallet={() => { setShowOverflow(false); setShowCreateCashbox('ewallet'); }}
            onAddCheck={() => { setShowOverflow(false); setShowCreateCashbox('check'); }}
          />
        </div>
      </div>

      {/* Right rail (RTL: rail is the FIRST grid child → renders RIGHT) + main column */}
      <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4" data-testid="treasury-grid">
        <aside className="space-y-3 xl:order-first" data-testid="treasury-rail">
          {cashCashbox && (
            <div
              className="rounded-2xl border border-slate-200 bg-emerald-50/30 p-4"
              data-testid="treasury-rail-cash-summary"
            >
              <div className="flex items-center gap-2 mb-1">
                <Wallet size={14} className="text-emerald-700" />
                <span className="font-bold text-sm text-emerald-800">نقدي</span>
              </div>
              <div className="text-[11px] text-emerald-700">{cashCashbox.name_ar}</div>
              <div className="text-2xl font-black text-emerald-800 font-mono mt-1">
                {EGP(cashCashbox.current_balance)}
              </div>
              <button
                type="button"
                onClick={() => setCashboxFilter(cashCashbox.id)}
                className="text-[11px] text-emerald-700 hover:underline mt-1 block"
                data-testid="treasury-rail-cash-details"
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
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'bank_transfer' })} icon={<Building2 size={14} />}  label="إضافة حساب بنكي"          testId="quick-add-bank" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'wallet' })}        icon={<Smartphone size={14} />} label="إضافة محفظة إلكترونية"  testId="quick-add-wallet" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'instapay' })}      icon={<Smartphone size={14} />} label="إضافة حساب InstaPay"    testId="quick-add-instapay" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'card_visa' })}     icon={<CreditCard size={14} />} label="إضافة جهاز POS / بطاقة" testId="quick-add-card" />
              <QuickAction onClick={() => setPaCreate({ open: true, method: 'check' })}         icon={<FileCheck size={14} />}  label="إضافة حساب شيكات"       testId="quick-add-check" />
            </div>
          )}

          <PaymentAccountAlerts
            accounts={balances as unknown as PaymentAccount[]}
            balances={balances}
            drifts={drifts}
          />
        </aside>

        <div className="space-y-4 min-w-0">
          {/* KPI row — 7 tiles */}
          <div
            className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2"
            data-testid="treasury-kpis"
          >
            <KpiTile testId="kpi-total"     icon={<Wallet      size={14} className="text-pink-600" />}    tone="pink"    label="كل الحسابات"        value={String(kpis.total)}       suffix="حساب" />
            <KpiTile testId="kpi-active"    icon={<CheckCheck  size={14} className="text-emerald-600" />} tone="emerald" label="الحسابات النشطة"     value={String(kpis.active)} />
            <KpiTile testId="kpi-inactive"  icon={<PowerOff    size={14} className="text-slate-500" />}   tone="slate"   label="الحسابات غير النشطة" value={String(kpis.inactive)}    suffix="حساب" />
            <KpiTile testId="kpi-no-default" icon={<Star        size={14} className="text-amber-600" />}   tone="amber"   label="بدون حساب افتراضي"  value={String(kpis.noDefault)}   suffix="طريقة دفع" />
            <KpiTile testId="kpi-wallet-balance" icon={<Smartphone size={14} className="text-purple-600" />} tone="purple" label="أرصدة المحافظ" value={EGP(kpis.walletTotal)} valueClass="text-base font-black" />
            <KpiTile testId="kpi-bank-balance"   icon={<Building2  size={14} className="text-indigo-600" />} tone="indigo" label="أرصدة البنوك"  value={EGP(kpis.bankTotal)}   valueClass="text-base font-black" />
            <KpiTile
              testId="kpi-last-movement"
              icon={<Clock size={14} className="text-rose-600" />}
              tone="rose"
              label="آخر حركة"
              value={
                kpis.latestMovement
                  ? `${shortClock(kpis.latestMovement) || ''} ${relativeArabic(kpis.latestMovement)}`.trim()
                  : '—'
              }
              valueClass="text-sm font-black"
              suffix={kpis.latestMovement ? new Date(kpis.latestMovement).toLocaleDateString('en-CA') : undefined}
            />
          </div>

          {/* Warning strips */}
          {(noDefaultMethods.length > 0 || unlinkedAccounts.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2" data-testid="treasury-warnings">
              {noDefaultMethods.map((m) => (
                <div
                  key={`nodef-${m}`}
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center justify-between"
                  data-testid={`warning-no-default-${m}`}
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-amber-600" />
                    <div className="text-xs text-amber-800">
                      طريقة <strong>{METHOD_LABEL_AR[m as keyof typeof METHOD_LABEL_AR] ?? m}</strong> لا يوجد لها حساب افتراضي نشط
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-[11px] text-amber-800 hover:underline"
                    onClick={() => { setMethodFilter(m as PaymentMethodCode); setPage(1); }}
                  >
                    عرض التفاصيل
                  </button>
                </div>
              ))}
              {unlinkedAccounts.length > 0 && (
                <div
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center justify-between"
                  data-testid="warning-unlinked-accounts"
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-amber-600" />
                    <div className="text-xs text-amber-800">
                      {unlinkedAccounts.length} حساب نشط غير مربوط بخزنة
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-[11px] text-amber-800 hover:underline"
                    onClick={() => { setCashboxFilter(''); setPage(1); }}
                  >
                    عرض التفاصيل
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Filters */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="treasury-filters">
            <div className="grid grid-cols-1 md:grid-cols-7 gap-3 items-end">
              <Field label="بحث">
                <input
                  className="input"
                  placeholder="بحث باسم الحساب / رقم الحساب / المزود..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  data-testid="filter-search"
                />
              </Field>
              <Field label="طريقة الدفع">
                <select
                  className="input"
                  value={methodFilter}
                  onChange={(e) => { setMethodFilter(e.target.value as PaymentMethodCode | ''); setPage(1); }}
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
                  onChange={(e) => { setTypeFilter(e.target.value as '' | PaymentAccountKind); setPage(1); }}
                  data-testid="filter-type"
                >
                  <option value="">الكل</option>
                  <option value="instapay">{KIND_AR_LABEL.instapay}</option>
                  <option value="wallet">{KIND_AR_LABEL.wallet}</option>
                  <option value="card">{KIND_AR_LABEL.card}</option>
                  <option value="bank">{KIND_AR_LABEL.bank}</option>
                  <option value="check">{KIND_AR_LABEL.check}</option>
                </select>
              </Field>
              <Field label="الحالة">
                <select
                  className="input"
                  value={activeFilter}
                  onChange={(e) => { setActiveFilter(e.target.value as '' | 'active' | 'inactive'); setPage(1); }}
                  data-testid="filter-active"
                >
                  <option value="">الكل</option>
                  <option value="active">نشط</option>
                  <option value="inactive">غير نشط</option>
                </select>
              </Field>
              <Field label="الافتراضي">
                <select
                  className="input"
                  value={defaultFilter}
                  onChange={(e) => { setDefaultFilter(e.target.value as '' | 'default' | 'non-default'); setPage(1); }}
                  data-testid="filter-default"
                >
                  <option value="">الكل</option>
                  <option value="default">افتراضي</option>
                  <option value="non-default">غير افتراضي</option>
                </select>
              </Field>
              <Field label="الخزنة المرتبطة">
                <select
                  className="input"
                  value={cashboxFilter}
                  onChange={(e) => { setCashboxFilter(e.target.value); setPage(1); }}
                  data-testid="filter-cashbox"
                >
                  <option value="">الكل</option>
                  {boxes.map((c) => (
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
                <X size={12} /> مسح الفلاتر
              </button>
            </div>
          </div>

          {/* Main table */}
          <PaymentAccountsTable
            rows={pagedAccounts}
            providers={providers}
            cashboxes={boxes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            canManage={canManageAccounts}
            onEdit={(b) => setPaEditing(b as unknown as PaymentAccount)}
            onSetDefault={(b) => canManageAccounts && setDefaultMutation.mutate(b.payment_account_id)}
            onToggleActive={(b) => canManageAccounts && toggleAccountMutation.mutate(b.payment_account_id)}
            onDelete={(b) => {
              if (!canManageAccounts) return;
              const ok = window.confirm(`هل أنت متأكد من حذف "${b.display_name}"؟`);
              if (ok) deleteAccountMutation.mutate(b.payment_account_id);
            }}
            warningsFor={rowWarnings}
            totalCount={filteredAccounts.length}
          />

          {/* Pagination */}
          <Pagination
            total={filteredAccounts.length}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          />

          {/* Bottom 3 dashboard cards */}
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

      {/* Modals */}
      {showCreateCashbox && (
        <CashboxFormModal kind={showCreateCashbox} onClose={() => setShowCreateCashbox(null)} />
      )}
      {editingCashbox && (
        <CashboxFormModal kind={editingCashbox.kind} editing={editingCashbox} onClose={() => setEditingCashbox(null)} />
      )}
      {showTransfer && (
        <TransferModal
          boxes={boxes.filter((b) => b.is_active)}
          onClose={() => setShowTransfer(false)}
        />
      )}
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

/* ════════════════════════════════════════════════════════════════════
 * Sub-components — kept inline so the unified treasury page stays
 * editable as one file. None of these talk to the network.
 * ════════════════════════════════════════════════════════════════════ */

function KpiTile({
  testId, icon, label, value, tone = 'slate', suffix, valueClass,
}: {
  testId: string;
  icon?: React.ReactNode;
  label: string;
  value: string;
  tone?: 'pink' | 'emerald' | 'indigo' | 'purple' | 'amber' | 'slate' | 'rose';
  suffix?: string;
  valueClass?: string;
}) {
  const toneCls: Record<string, string> = {
    pink:    'border-pink-200 bg-pink-50/60',
    emerald: 'border-emerald-200 bg-emerald-50/60',
    indigo:  'border-indigo-200 bg-indigo-50/60',
    purple:  'border-purple-200 bg-purple-50/60',
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
      <div className={`font-black text-slate-900 truncate ${valueClass ?? 'text-2xl'}`}>{value}</div>
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

function OverflowMenu({
  open, onToggle, onClose, disabledTransfer, canManageCashboxes,
  onTransfer, onAddCash, onAddBank, onAddEwallet, onAddCheck,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  disabledTransfer: boolean;
  canManageCashboxes: boolean;
  onTransfer: () => void;
  onAddCash: () => void;
  onAddBank: () => void;
  onAddEwallet: () => void;
  onAddCheck: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onClose]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-2 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        data-testid="treasury-overflow"
        title="المزيد"
      >
        <MoreVertical size={14} />
      </button>
      {open && (
        <div
          className="absolute left-0 mt-1 w-56 rounded-lg border border-slate-200 bg-white shadow-lg z-30"
          role="menu"
          data-testid="treasury-overflow-menu"
        >
          <button
            type="button"
            onClick={onTransfer}
            disabled={disabledTransfer}
            className="w-full text-right px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-40 inline-flex items-center gap-2"
            data-testid="overflow-transfer"
          >
            <ArrowRightLeft size={14} /> تحويل بين الخزائن
          </button>
          {canManageCashboxes && (
            <>
              <div className="border-t border-slate-100" />
              <button type="button" onClick={onAddCash}    className="w-full text-right px-3 py-2 text-sm hover:bg-slate-50 inline-flex items-center gap-2" data-testid="overflow-add-cash">    <Wallet     size={14} /> إضافة نقدي</button>
              <button type="button" onClick={onAddBank}    className="w-full text-right px-3 py-2 text-sm hover:bg-slate-50 inline-flex items-center gap-2" data-testid="overflow-add-bank">    <Building2  size={14} /> إضافة حساب بنكي</button>
              <button type="button" onClick={onAddEwallet} className="w-full text-right px-3 py-2 text-sm hover:bg-slate-50 inline-flex items-center gap-2" data-testid="overflow-add-ewallet"> <Smartphone size={14} /> إضافة محفظة إلكترونية</button>
              <button type="button" onClick={onAddCheck}   className="w-full text-right px-3 py-2 text-sm hover:bg-slate-50 inline-flex items-center gap-2" data-testid="overflow-add-check">   <FileCheck  size={14} /> إضافة حساب شيكات</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentAccountsTable({
  rows, providers, cashboxes, selectedId, onSelect, canManage,
  onEdit, onSetDefault, onToggleActive, onDelete, warningsFor, totalCount,
}: {
  rows: PaymentAccountBalance[];
  providers: PaymentProvider[];
  cashboxes: Cashbox[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
  onEdit: (b: PaymentAccountBalance) => void;
  onSetDefault: (b: PaymentAccountBalance) => void;
  onToggleActive: (b: PaymentAccountBalance) => void;
  onDelete: (b: PaymentAccountBalance) => void;
  warningsFor: (b: PaymentAccountBalance) => string[];
  totalCount: number;
}) {
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white overflow-hidden"
      data-testid="treasury-table-card"
    >
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <h2 className="font-bold text-sm text-slate-800">
          قائمة حسابات الدفع ({totalCount} حسابات)
        </h2>
      </div>
      <div className="overflow-x-auto" data-testid="treasury-table-scroll">
        <table className="w-full text-sm" data-testid="payment-accounts-table">
          <thead className="bg-slate-50 text-[11px] text-slate-600">
            <tr>
              <Th>الشعار</Th>
              <Th>اسم الحساب</Th>
              <Th>المزود</Th>
              <Th>طريقة الدفع</Th>
              <Th>النوع</Th>
              <Th>الرقم المعرف</Th>
              <Th>حساب الأستاذ</Th>
              <Th>الخزنة المرتبطة</Th>
              <Th>الرصيد المحاسبي</Th>
              <Th>آخر حركة</Th>
              <Th>عدد الحركات</Th>
              <Th>الافتراضي</Th>
              <Th>الحالة</Th>
              <Th>التحذيرات</Th>
              <Th>الإجراءات</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={15}
                  className="text-center py-8 text-slate-500 text-sm"
                  data-testid="payment-accounts-empty"
                >
                  لا توجد حسابات مطابقة للفلتر الحالي
                </td>
              </tr>
            ) : rows.map((b) => {
              const provider = providers.find((p) => p.provider_key === b.provider_key);
              const linkedCb = cashboxes.find((c) => c.id === b.cashbox_id);
              const kind = paymentAccountKind(b.method as PaymentMethodCode);
              const isSelected = b.payment_account_id === selectedId;
              const warnings = warningsFor(b);
              return (
                <tr
                  key={b.payment_account_id}
                  onClick={() => onSelect(b.payment_account_id)}
                  className={`cursor-pointer hover:bg-slate-50 ${isSelected ? 'bg-pink-50/50' : ''}`}
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
                  <Td>
                    <span className="text-[11px] text-slate-600">
                      {kind ? KIND_AR_LABEL[kind] : '—'}
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
                  <Td className="text-[11px] text-slate-600">
                    {b.last_movement
                      ? <span title={b.last_movement}>{relativeArabic(b.last_movement)}</span>
                      : '—'}
                  </Td>
                  <Td className="text-center">{b.je_count}</Td>
                  <Td className="text-center">
                    {b.is_default ? (
                      <span className="text-[10px] font-bold bg-amber-500/20 text-amber-700 px-2 py-0.5 rounded inline-flex items-center gap-0.5">
                        <Star size={10} /> افتراضي
                      </span>
                    ) : '—'}
                  </Td>
                  <Td>
                    {b.active ? (
                      <span className="text-[11px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">نشط</span>
                    ) : (
                      <span className="text-[11px] font-bold bg-rose-100 text-rose-700 px-2 py-0.5 rounded">غير نشط</span>
                    )}
                  </Td>
                  <Td>
                    {warnings.length === 0 ? (
                      <span className="text-[11px] text-slate-400">—</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {warnings.map((w) => (
                          <span
                            key={w}
                            className="text-[10px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded inline-flex items-center gap-1"
                            data-testid={`row-warning-${w}`}
                          >
                            <AlertTriangle size={10} /> {w}
                          </span>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td>
                    {canManage && (
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={(e) => { e.stopPropagation(); onEdit(b); }}         className="text-[11px] px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200" data-testid="row-action-edit"          title="تعديل"><Edit3 size={12} /></button>
                        <button onClick={(e) => { e.stopPropagation(); onSetDefault(b); }}   className="text-[11px] px-2 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200" data-testid="row-action-set-default"  title="تعيين افتراضي"><Star size={12} /></button>
                        <button onClick={(e) => { e.stopPropagation(); onToggleActive(b); }} className="text-[11px] px-2 py-1 rounded bg-sky-100 text-sky-700 hover:bg-sky-200"       data-testid="row-action-toggle-active" title={b.active ? 'تعطيل' : 'تفعيل'}>{b.active ? <PowerOff size={12} /> : <Power size={12} />}</button>
                        <button onClick={(e) => { e.stopPropagation(); onDelete(b); }}       className="text-[11px] px-2 py-1 rounded bg-rose-100 text-rose-700 hover:bg-rose-200"   data-testid="row-action-delete"        title="حذف"><Trash2 size={12} /></button>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Pagination({
  total, page, pageSize, onPageChange, onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div
      className="flex items-center justify-between flex-wrap gap-2"
      data-testid="treasury-pagination"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">عرض</span>
        <select
          className="input w-20 text-xs"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value) || 10)}
          data-testid="pagination-size"
        >
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>
      <div className="text-xs text-slate-600" data-testid="pagination-summary">
        عرض {from} إلى {to} من {total}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onPageChange(1)}            disabled={page <= 1}            className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="pagination-first"><ChevronsRight size={14} /></button>
        <button type="button" onClick={() => onPageChange(page - 1)}     disabled={page <= 1}            className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="pagination-prev"><ChevronRight size={14} /></button>
        <span className="text-xs text-slate-700 px-2 py-1 rounded bg-slate-100 font-bold" data-testid="pagination-page">{page}</span>
        <button type="button" onClick={() => onPageChange(page + 1)}     disabled={page >= totalPages}   className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="pagination-next"><ChevronLeft size={14} /></button>
        <button type="button" onClick={() => onPageChange(totalPages)}   disabled={page >= totalPages}   className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="pagination-last"><ChevronsLeft size={14} /></button>
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
      <Row label="عدد الحسابات"  value={String(balances.length)} />
      <Row label="إجمالي الداخل"  value={EGP(totalIn)}  tone="emerald" />
      <Row label="إجمالي الخارج"  value={EGP(totalOut)} tone="rose" />
      <Row label="إجمالي الرصيد"  value={EGP(total)} />
      <Row label="عدد القيود"     value={String(jeCount)} />
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
  return (
    <ul className="space-y-1.5 text-sm">
      {(Object.keys(buckets) as PaymentAccountKind[]).map((k) => {
        const n = buckets[k];
        const pct = total > 0 ? Math.round((n / total) * 100) : 0;
        return (
          <li key={k} className="flex items-center gap-2" data-testid={`dist-${k}`}>
            <span className="flex-1 text-slate-700">{KIND_AR_LABEL[k]}</span>
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

function Row({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'emerald' | 'rose';
}) {
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
