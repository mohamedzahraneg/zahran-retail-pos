import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { InvoiceHoverCard } from '@/components/InvoiceHoverCard';
import {
  Wallet,
  ArrowDownCircle,
  ArrowUpCircle,
  Plus,
  Search,
  X,
  Ban,
  Banknote,
  CreditCard,
  Smartphone,
  Building2,
  RefreshCw,
} from 'lucide-react';

import {
  cashDeskApi,
  Cashbox,
  PaymentMethod,
  CustomerPayment,
  SupplierPayment,
  CashboxMovement,
} from '@/api/cash-desk.api';
import { AlertCircle, ArrowLeftRight, Printer } from 'lucide-react';
import { InstitutionLogo } from '@/components/InstitutionLogo';
import { printVoucher } from '@/lib/printVoucher';
// PR-CASH-DESK-REORG-1 — `customersApi` / `suppliersApi` imports
// removed; their lookups live inside `ReceiptModal` /
// `SupplierPayModal` which now reside in `components/cash-desk/`
// and are mounted from the Customers / Suppliers pages instead of
// here. The shared `Modal` + `Field` primitives live in the same
// directory as the lifted modals so DepositModal (still defined
// below) can re-use them.
import { Modal, Field } from '@/components/cash-desk/Modal';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

// PR-FIN-PAYACCT-4C — `PaymentMethod` is now the full POS-aligned enum.
// These dicts cover every value so the dashboard can render any
// historical movement category without falling through.
const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'نقدي',
  card_visa: 'فيزا',
  card_mastercard: 'ماستركارد',
  card_meeza: 'ميزة',
  instapay: 'إنستا باي',
  vodafone_cash: 'فودافون كاش',
  orange_cash: 'أورانج كاش',
  wallet: 'محفظة',
  bank_transfer: 'تحويل بنكي',
};

const METHOD_ICONS: Record<PaymentMethod, any> = {
  cash: Banknote,
  card_visa: CreditCard,
  card_mastercard: CreditCard,
  card_meeza: CreditCard,
  instapay: Smartphone,
  vodafone_cash: Smartphone,
  orange_cash: Smartphone,
  wallet: Smartphone,
  bank_transfer: Building2,
};

/**
 * PR-CASH-DESK-REORG-1 — Tab union narrowed to `movements` only.
 * The dedicated `receipts` and `payments` tabs (customer + supplier
 * payment list views) moved to the Customers + Suppliers pages.
 * Cash desk now keeps the master cashbox-movements feed which
 * already includes those rows when they exist (via the
 * cashbox_transactions reference_type fan-out). Same goes for the
 * action buttons — استلام من عميل + دفع لمورد moved to those pages,
 * the modals are now reusable components under `components/cash-desk`.
 */
type Tab = 'movements';

/**
 * `embedded=true` is used when CashDesk is rendered inside the
 * /cashboxes page. It hides the big page header / KPI grid / "active
 * cashboxes" list (the host page already shows better versions of
 * those) and keeps only the action button (deposit) + the master
 * movements feed.
 */
export default function CashDesk({ embedded = false }: { embedded?: boolean }) {
  const [tab, _setTab] = useState<Tab>('movements');
  // PR-CASH-DESK-REORG-1 — single-tab view; setter retained for API
  // symmetry with future tab additions but not currently called.
  void _setTab;
  const [showDeposit, setShowDeposit] = useState(false);
  const [q, setQ] = useState('');

  const qc = useQueryClient();

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
  });

  const { data: cashflow = [] } = useQuery({
    queryKey: ['cashflow-today'],
    queryFn: cashDeskApi.cashflowToday,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: variances } = useQuery({
    queryKey: ['shift-variances'],
    queryFn: cashDeskApi.shiftVariances,
    refetchInterval: 60_000,
  });

  const { data: movements = [], isLoading: loadingMovements } = useQuery({
    queryKey: ['cashbox-movements'],
    queryFn: () => cashDeskApi.movements({ limit: 300 }),
    enabled: tab === 'movements',
    refetchInterval: tab === 'movements' ? 30_000 : false,
  });

  // PR-CASH-DESK-REORG-1 — `customer-payments` + `supplier-payments`
  // queries removed; their dedicated tabs moved to the Customers and
  // Suppliers pages. The master movements feed below still surfaces
  // the underlying cashbox_transactions when those payments occur.

  const totals = useMemo(() => {
    // Prefer new column names (cash_in_today/cash_out_today); fall back
    // to the legacy inflows_total/outflows_total aliases.
    const sum = (arr: any[], a: string, b: string) =>
      arr.reduce(
        (s, r) => s + Number((r[a] ?? r[b]) || 0),
        0,
      );
    const currentTotal = cashflow.reduce(
      (s, r) => s + Number(r.current_balance || 0),
      0,
    );
    return {
      currentBalance: currentTotal,
      inflowsToday: sum(cashflow, 'cash_in_today', 'inflows_total'),
      outflowsToday: sum(cashflow, 'cash_out_today', 'outflows_total'),
    };
  }, [cashflow]);

  // PR-CASH-DESK-REORG-1 — `filteredReceipts` and `filteredPayments`
  // memos removed alongside the customer/supplier-payments queries.
  // The `q` search field still powers the master `MovementsTable`
  // below (it filters cashbox movements client-side via the same
  // input).

  // Suppress unused-var warnings when embedded — they still power the
  // KPI / cashbox-list sections that are hidden below.
  void totals;
  void variances;
  void cashboxes;

  return (
    <div className="space-y-6">
      {/* Header — hidden when embedded in /cashboxes (host page shows it) */}
      {!embedded && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
              <Wallet className="text-brand-600" /> الصندوق
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              {/* PR-CASH-DESK-REORG-1 — page is now treasury-focused
                  (rصيد/إيداع + حركة الخزنة + ملخصات). Customer
                  receipts moved to the Customers page; supplier
                  payments moved to the Suppliers page. */}
              رصيد الخزنة وحركتها اليومية
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              onClick={() => setShowDeposit(true)}
              title="إيداع يدوي — رصيد افتتاحي أو تمويل"
              data-testid="cash-desk-deposit-button"
            >
              <Plus size={18} /> إيداع/رصيد افتتاحي
            </button>
          </div>
        </div>
      )}

      {/* Embedded action bar — primary operations when header is hidden */}
      {embedded && (
        <div className="card p-3 flex flex-wrap gap-2 bg-slate-50">
          <div className="text-sm font-bold text-slate-700 mr-auto self-center">
            عمليات سريعة:
          </div>
          <button
            className="btn-secondary"
            onClick={() => setShowDeposit(true)}
            title="إيداع يدوي — رصيد افتتاحي أو تمويل"
            data-testid="cash-desk-deposit-button-embedded"
          >
            <Plus size={16} /> إيداع يدوي
          </button>
        </div>
      )}

      {/* KPIs — hidden when embedded (host has richer per-kind tiles) */}
      {!embedded && (
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="الرصيد الحالي"
            value={EGP(totals.currentBalance)}
            icon={<Wallet className="text-brand-600" />}
            color="bg-brand-50"
            hint="إجمالي كل الخزائن النشطة"
          />
          <KpiCard
            title="داخل اليوم"
            value={EGP(totals.inflowsToday)}
            icon={<ArrowDownCircle className="text-emerald-600" />}
            color="bg-emerald-50"
            hint="مبيعات كاش + مقبوضات + إيداعات"
          />
          <KpiCard
            title="خارج اليوم"
            value={EGP(totals.outflowsToday)}
            icon={<ArrowUpCircle className="text-rose-600" />}
            color="bg-rose-50"
            hint="مصروفات + دفعات موردين + سحب"
          />
          <VarianceCard variances={variances} />
        </div>
      )}

      {/* Cashboxes List — hidden when embedded (host page has the grid) */}
      {!embedded && cashboxes.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-bold text-slate-700">
              الخزائن النشطة
            </div>
            <a
              href="/cashboxes"
              className="text-xs text-brand-600 hover:underline"
            >
              إدارة الخزائن ←
            </a>
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            {cashboxes.map((cb: any) => (
              <div
                key={cb.id}
                className="p-3 rounded-lg border border-slate-200 bg-slate-50/40 flex items-center gap-3"
              >
                <InstitutionLogo
                  domain={cb.institution_domain}
                  kind={cb.kind}
                  color={cb.institution_color}
                  label={cb.institution_name || cb.name}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-500 truncate">
                    {cb.name}
                  </div>
                  {cb.institution_name && (
                    <div className="text-[11px] text-slate-400 truncate">
                      {cb.institution_name}
                    </div>
                  )}
                  <div className="font-black text-lg text-slate-800">
                    {EGP(cb.current_balance)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PR-CASH-DESK-REORG-1 — single-tab master movements feed.
          Dedicated مقبوضات العملاء + مدفوعات الموردين tabs moved to
          the Customers and Suppliers pages respectively. */}
      <div className="card p-0 overflow-hidden">
        <div
          className="flex border-b border-slate-200 bg-slate-50/60"
          data-testid="cash-desk-tabs"
        >
          <TabBtn
            active={tab === 'movements'}
            onClick={() => undefined}
            label="حركة الخزنة"
            count={movements.length || undefined}
          />
        </div>

        {/* Search */}
        <div className="p-4 border-b border-slate-100">
          <div className="relative">
            <Search
              size={16}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              className="input pr-9"
              placeholder="بحث برقم السند / المرجع / الملاحظات..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        {/* Table — master movements feed only */}
        <div className="overflow-x-auto" data-testid="cash-desk-movements">
          <MovementsTable rows={movements} loading={loadingMovements} q={q} />
        </div>
      </div>

      {/* Modals — only Deposit remains on the cash desk page.
          ReceiptModal + SupplierPayModal moved to
          `components/cash-desk/` and are mounted from Customers.tsx
          and Suppliers.tsx respectively (PR-CASH-DESK-REORG-1). */}
      {showDeposit && (
        <DepositModal
          cashboxes={cashboxes}
          onClose={() => setShowDeposit(false)}
          onSuccess={() => {
            setShowDeposit(false);
            qc.invalidateQueries({ queryKey: ['cashboxes'] });
            qc.invalidateQueries({ queryKey: ['cashflow-today'] });
          }}
        />
      )}
    </div>
  );
}

// ─── Small components ────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  icon,
  color,
  hint,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  color: string;
  hint?: string;
}) {
  return (
    <div className="card p-5 flex items-center gap-4 h-full min-w-0">
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${color}`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-500 mb-1 break-words">{title}</div>
        <div
          className="font-black text-lg sm:text-xl md:text-2xl text-slate-800 break-words tabular-nums leading-tight"
          title={value}
        >
          {value}
        </div>
        {hint && (
          <div className="text-[11px] text-slate-400 mt-0.5 break-words">{hint}</div>
        )}
      </div>
    </div>
  );
}

/** Shift-variance tile: net surplus/deficit across every closed shift. */
function VarianceCard({
  variances,
}: {
  variances: import('@/api/cash-desk.api').ShiftVariances | undefined;
}) {
  const net = Number(variances?.net_variance || 0);
  const surplus = Number(variances?.total_surplus || 0);
  const deficit = Number(variances?.total_deficit || 0);
  const surplusCount = variances?.surplus_count ?? 0;
  const deficitCount = variances?.deficit_count ?? 0;
  const matched = variances?.matched_count ?? 0;

  const isPositive = net > 0.01;
  const isNegative = net < -0.01;
  const color = isNegative
    ? 'bg-rose-50'
    : isPositive
      ? 'bg-emerald-50'
      : 'bg-slate-50';
  const textColor = isNegative
    ? 'text-rose-700'
    : isPositive
      ? 'text-emerald-700'
      : 'text-slate-700';
  // Status + amount are now rendered as separate lines so neither
  // part ever truncates. The amount stays tabular-nums + no-wrap.
  const statusLabel = isNegative
    ? 'عجز صافي'
    : isPositive
      ? 'زيادة صافية'
      : 'لا فوارق';
  const statusAmount = isNegative
    ? EGP(Math.abs(net))
    : isPositive
      ? EGP(net)
      : null;

  return (
    // h-full + min-w-0 keep grid siblings aligned; shrink-0 icon
    // prevents the title from pushing outside the card on narrow
    // screens.
    <div className="card p-5 flex items-center gap-4 h-full min-w-0">
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${color}`}
      >
        <AlertCircle className={textColor} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-500 mb-1">فوارق الورديات</div>
        {/* Responsive type — text-lg on mobile, text-2xl on desktop.
            break-words as a safety net; tabular-nums keeps the amount
            width predictable. No truncate — label + amount already
            fit because they're on separate lines/whitespace. */}
        <div
          className={`font-black text-lg sm:text-xl md:text-2xl break-words leading-tight ${textColor}`}
        >
          <span>{statusLabel}</span>
          {statusAmount && (
            <span className="tabular-nums whitespace-nowrap"> {statusAmount}</span>
          )}
        </div>
        <div className="text-[11px] text-slate-400 mt-1 break-words">
          <span className="text-emerald-600">+{EGP(surplus)}</span>
          {' · '}
          <span className="text-rose-600">−{EGP(deficit)}</span>
          {' · '}
          {matched} مطابقة / {surplusCount} زيادة / {deficitCount} عجز
        </div>
      </div>
    </div>
  );
}

function MovementsTable({
  rows,
  loading,
  q,
}: {
  rows: CashboxMovement[];
  loading: boolean;
  q: string;
}) {
  const filtered = useMemo(() => {
    if (!q) return rows;
    const s = q.toLowerCase();
    return rows.filter(
      (r) =>
        (r.reference_no || '').toLowerCase().includes(s) ||
        (r.counterparty_name || '').toLowerCase().includes(s) ||
        (r.notes || '').toLowerCase().includes(s) ||
        (r.kind_ar || '').toLowerCase().includes(s),
    );
  }, [rows, q]);

  if (loading) {
    return (
      <div className="text-center py-12 text-slate-400">
        <RefreshCw className="animate-spin mx-auto mb-2" /> جارٍ التحميل...
      </div>
    );
  }
  if (!filtered.length) {
    return (
      <div className="text-center py-12 text-slate-400">
        لا توجد حركات بعد
      </div>
    );
  }
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-slate-50/60 text-slate-600 text-xs font-bold sticky top-0">
        <tr>
          <Th>الوقت</Th>
          <Th>النوع</Th>
          <Th>الخزنة</Th>
          <Th>المرجع</Th>
          <Th>الطرف المقابل</Th>
          <Th>داخل</Th>
          <Th>خارج</Th>
          <Th>الرصيد بعد</Th>
          <Th>المستخدم</Th>
          <Th>ملاحظات</Th>
        </tr>
      </thead>
      <tbody>
        {filtered.map((r) => {
          const isIn = r.direction === 'in';
          return (
            <tr
              key={r.id}
              className="border-t border-slate-100 hover:bg-slate-50/60"
            >
              <Td className="whitespace-nowrap text-xs text-slate-500 font-mono">
                {new Date(r.created_at).toLocaleString('en-GB', {
                  timeZone: 'Africa/Cairo',
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Td>
              <Td>
                <span
                  className={`chip ${
                    isIn
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  <ArrowLeftRight size={12} /> {r.kind_ar}
                </span>
              </Td>
              <Td className="text-xs text-slate-600">{r.cashbox_name || '—'}</Td>
              <Td className="font-mono text-xs font-bold text-brand-700">
                {r.reference_no || '—'}
              </Td>
              <Td className="text-xs">{r.counterparty_name || '—'}</Td>
              <Td className="font-bold text-emerald-700">
                {isIn ? EGP(r.amount) : '—'}
              </Td>
              <Td className="font-bold text-rose-700">
                {isIn ? '—' : EGP(r.amount)}
              </Td>
              <Td className="font-mono text-xs">{EGP(r.balance_after)}</Td>
              <Td className="text-xs text-slate-500">{r.user_name || '—'}</Td>
              <Td className="text-xs text-slate-500 max-w-xs truncate">
                {r.notes || '—'}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TabBtn({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-5 py-3 font-bold text-sm transition border-b-2 ${
        active
          ? 'border-brand-600 text-brand-700 bg-white'
          : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className="mr-2 chip bg-slate-100 text-slate-600">{count}</span>
      )}
    </button>
  );
}



function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-right px-3 py-2">{children}</th>;
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

// ─── Modals ──────────────────────────────────────────────────────────────






function DepositModal({
  cashboxes,
  onClose,
  onSuccess,
}: {
  cashboxes: Cashbox[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [cashboxId, setCashboxId] = useState(cashboxes[0]?.id ?? '');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [txnDate, setTxnDate] = useState(() => {
    // today in Cairo
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    return `${y}-${m}-${d}`;
  });
  const [category, setCategory] = useState('opening_balance');
  const [notes, setNotes] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      cashDeskApi.deposit({
        cashbox_id: cashboxId,
        direction,
        amount: Number(amount),
        category,
        notes: notes || undefined,
        txn_date: txnDate,
      }),
    onSuccess: (r) => {
      toast.success(
        `تم — الرصيد الجديد ${Number(r.new_balance).toLocaleString('en-US', {
          minimumFractionDigits: 2,
        })} ج.م`,
      );
      onSuccess();
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || e.message || 'فشل الإيداع');
    },
  });

  const disabled =
    !cashboxId || !amount || Number(amount) <= 0 || submit.isPending;

  return (
    <Modal title="إيداع / رصيد افتتاحي" onClose={onClose}>
      <div className="space-y-3">
        <Field label="الخزينة">
          <select
            className="input w-full"
            value={cashboxId}
            onChange={(e) => setCashboxId(e.target.value)}
          >
            {cashboxes.map((cb) => (
              <option key={cb.id} value={cb.id}>
                {cb.name} — رصيد {EGP(cb.current_balance)}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="النوع">
            <div className="flex gap-2">
              <button
                type="button"
                className={`flex-1 py-2 rounded-lg text-sm font-bold border ${
                  direction === 'in'
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
                onClick={() => setDirection('in')}
              >
                إيداع +
              </button>
              <button
                type="button"
                className={`flex-1 py-2 rounded-lg text-sm font-bold border ${
                  direction === 'out'
                    ? 'bg-rose-50 border-rose-300 text-rose-700'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
                onClick={() => setDirection('out')}
              >
                سحب −
              </button>
            </div>
          </Field>

          <Field label="المبلغ (ج.م)">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              className="input w-full"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="التاريخ">
            <input
              type="date"
              className="input w-full"
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
            />
          </Field>
          <Field label="التصنيف">
            <select
              className="input w-full"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="opening_balance">رصيد افتتاحي</option>
              <option value="owner_topup">تمويل من المالك</option>
              <option value="bank_deposit">إيداع بنكي</option>
              <option value="adjustment">تسوية يدوية</option>
              <option value="other">أخرى</option>
            </select>
          </Field>
        </div>

        <Field label="ملاحظات">
          <input
            type="text"
            className="input w-full"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="اختياري"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose} disabled={submit.isPending}>
            إلغاء
          </button>
          <button
            className="btn-primary"
            onClick={() => submit.mutate()}
            disabled={disabled}
          >
            {submit.isPending ? 'جارٍ الحفظ…' : 'تأكيد'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
