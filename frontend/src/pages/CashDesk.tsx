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
import { AlertCircle, ArrowLeftRight } from 'lucide-react';
import { InstitutionLogo } from '@/components/InstitutionLogo';
import { customersApi, Customer } from '@/api/customers.api';
import { suppliersApi, Supplier } from '@/api/suppliers.api';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'نقدي',
  card: 'بطاقة',
  instapay: 'إنستا باي',
  bank_transfer: 'تحويل بنكي',
};

const METHOD_ICONS: Record<PaymentMethod, any> = {
  cash: Banknote,
  card: CreditCard,
  instapay: Smartphone,
  bank_transfer: Building2,
};

type Tab = 'receipts' | 'payments' | 'movements';

export default function CashDesk() {
  const [tab, setTab] = useState<Tab>('receipts');
  const [showReceipt, setShowReceipt] = useState(false);
  const [showSupplierPay, setShowSupplierPay] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [voidTarget, setVoidTarget] = useState<CustomerPayment | null>(null);
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

  const { data: receipts = [], isLoading: loadingReceipts } = useQuery({
    queryKey: ['customer-payments'],
    queryFn: () => cashDeskApi.listCustomerPayments(),
  });

  const { data: payments = [], isLoading: loadingPayments } = useQuery({
    queryKey: ['supplier-payments'],
    queryFn: () => cashDeskApi.listSupplierPayments(),
  });

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

  const filteredReceipts = useMemo(() => {
    if (!q) return receipts;
    const s = q.toLowerCase();
    return receipts.filter(
      (r) =>
        r.doc_no.toLowerCase().includes(s) ||
        (r.reference || '').toLowerCase().includes(s) ||
        (r.notes || '').toLowerCase().includes(s),
    );
  }, [receipts, q]);

  const filteredPayments = useMemo(() => {
    if (!q) return payments;
    const s = q.toLowerCase();
    return payments.filter(
      (r) =>
        r.doc_no.toLowerCase().includes(s) ||
        (r.reference || '').toLowerCase().includes(s) ||
        (r.notes || '').toLowerCase().includes(s),
    );
  }, [payments, q]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Wallet className="text-brand-600" /> الصندوق
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            استلام مقبوضات العملاء ودفع مستحقات الموردين
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => setShowReceipt(true)}>
            <ArrowDownCircle size={18} /> استلام من عميل
          </button>
          <button
            className="btn-secondary"
            onClick={() => setShowSupplierPay(true)}
          >
            <ArrowUpCircle size={18} /> دفع لمورد
          </button>
          <button
            className="btn-secondary"
            onClick={() => setShowDeposit(true)}
            title="إيداع يدوي — رصيد افتتاحي أو تمويل"
          >
            <Plus size={18} /> إيداع/رصيد افتتاحي
          </button>
        </div>
      </div>

      {/* KPIs */}
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

      {/* Cashboxes List */}
      {cashboxes.length > 0 && (
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

      {/* Tabs */}
      <div className="card p-0 overflow-hidden">
        <div className="flex border-b border-slate-200 bg-slate-50/60">
          <TabBtn
            active={tab === 'movements'}
            onClick={() => setTab('movements')}
            label="حركة الخزنة"
            count={movements.length || undefined}
          />
          <TabBtn
            active={tab === 'receipts'}
            onClick={() => setTab('receipts')}
            label="مقبوضات العملاء"
            count={receipts.length}
          />
          <TabBtn
            active={tab === 'payments'}
            onClick={() => setTab('payments')}
            label="مدفوعات الموردين"
            count={payments.length}
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

        {/* Table */}
        <div className="overflow-x-auto">
          {tab === 'receipts' && (
            <ReceiptsTable
              rows={filteredReceipts}
              loading={loadingReceipts}
              onVoid={setVoidTarget}
            />
          )}
          {tab === 'payments' && (
            <PaymentsTable rows={filteredPayments} loading={loadingPayments} />
          )}
          {tab === 'movements' && (
            <MovementsTable rows={movements} loading={loadingMovements} q={q} />
          )}
        </div>
      </div>

      {/* Modals */}
      {showReceipt && (
        <ReceiptModal
          cashboxes={cashboxes}
          onClose={() => setShowReceipt(false)}
          onSuccess={() => {
            setShowReceipt(false);
            qc.invalidateQueries({ queryKey: ['customer-payments'] });
            qc.invalidateQueries({ queryKey: ['cashflow-today'] });
            qc.invalidateQueries({ queryKey: ['cashboxes'] });
          }}
        />
      )}

      {showSupplierPay && (
        <SupplierPayModal
          cashboxes={cashboxes}
          onClose={() => setShowSupplierPay(false)}
          onSuccess={() => {
            setShowSupplierPay(false);
            qc.invalidateQueries({ queryKey: ['supplier-payments'] });
            qc.invalidateQueries({ queryKey: ['cashflow-today'] });
            qc.invalidateQueries({ queryKey: ['cashboxes'] });
          }}
        />
      )}

      {voidTarget && (
        <VoidReceiptModal
          payment={voidTarget}
          onClose={() => setVoidTarget(null)}
          onSuccess={() => {
            setVoidTarget(null);
            qc.invalidateQueries({ queryKey: ['customer-payments'] });
            qc.invalidateQueries({ queryKey: ['cashflow-today'] });
          }}
        />
      )}

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
    <div className="card p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-500 mb-1">{title}</div>
        <div className="font-black text-2xl text-slate-800 truncate">{value}</div>
        {hint && (
          <div className="text-[11px] text-slate-400 mt-0.5 truncate">{hint}</div>
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
  const label = isNegative
    ? `عجز صافي ${EGP(Math.abs(net))}`
    : isPositive
      ? `زيادة صافية ${EGP(net)}`
      : 'لا فوارق';

  return (
    <div className="card p-5 flex items-center gap-4">
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}
      >
        <AlertCircle className={textColor} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-500 mb-1">فوارق الورديات</div>
        <div className={`font-black text-2xl truncate ${textColor}`}>
          {label}
        </div>
        <div className="text-[11px] text-slate-400 mt-0.5 truncate">
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

function ReceiptsTable({
  rows,
  loading,
  onVoid,
}: {
  rows: CustomerPayment[];
  loading: boolean;
  onVoid: (p: CustomerPayment) => void;
}) {
  if (loading) {
    return (
      <div className="text-center py-12 text-slate-400">
        <RefreshCw className="animate-spin mx-auto mb-2" /> جارٍ التحميل...
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="text-center py-12 text-slate-400">
        لا توجد مقبوضات
      </div>
    );
  }
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-slate-50/60 text-slate-600 text-xs font-bold">
        <tr>
          <Th>رقم السند</Th>
          <Th>التاريخ</Th>
          <Th>الطريقة</Th>
          <Th>النوع</Th>
          <Th>المبلغ</Th>
          <Th>المرجع</Th>
          <Th>الحالة</Th>
          <Th></Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const Icon = METHOD_ICONS[r.payment_method] || Banknote;
          const isVoid = r.status === 'void';
          return (
            <tr
              key={r.id}
              className={`border-t border-slate-100 ${isVoid ? 'opacity-50 bg-rose-50/30' : 'hover:bg-slate-50/60'}`}
            >
              <Td className="font-mono font-bold text-brand-700">{r.doc_no}</Td>
              <Td>
                {new Date(r.created_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </Td>
              <Td>
                <span className="chip bg-slate-100 text-slate-700">
                  <Icon size={12} /> {METHOD_LABELS[r.payment_method]}
                </span>
              </Td>
              <Td>
                <span className="text-xs text-slate-600">
                  {r.kind === 'deposit'
                    ? 'عربون'
                    : r.kind === 'refund'
                      ? 'استرجاع'
                      : 'سداد فواتير'}
                </span>
              </Td>
              <Td className="font-bold text-emerald-700">{EGP(r.amount)}</Td>
              <Td className="text-xs text-slate-500">{r.reference || '—'}</Td>
              <Td>
                {isVoid ? (
                  <span className="chip bg-rose-100 text-rose-700">ملغى</span>
                ) : (
                  <span className="chip bg-emerald-100 text-emerald-700">مُرحّل</span>
                )}
              </Td>
              <Td>
                {!isVoid && (
                  <button
                    onClick={() => onVoid(r)}
                    className="text-rose-600 hover:text-rose-800 p-1"
                    title="إلغاء المقبوضة"
                  >
                    <Ban size={16} />
                  </button>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PaymentsTable({
  rows,
  loading,
}: {
  rows: SupplierPayment[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-center py-12 text-slate-400">
        <RefreshCw className="animate-spin mx-auto mb-2" /> جارٍ التحميل...
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="text-center py-12 text-slate-400">
        لا توجد مدفوعات
      </div>
    );
  }
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-slate-50/60 text-slate-600 text-xs font-bold">
        <tr>
          <Th>رقم السند</Th>
          <Th>التاريخ</Th>
          <Th>الطريقة</Th>
          <Th>المبلغ</Th>
          <Th>المرجع</Th>
          <Th>الملاحظات</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const Icon = METHOD_ICONS[r.payment_method] || Banknote;
          return (
            <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/60">
              <Td className="font-mono font-bold text-brand-700">{r.doc_no}</Td>
              <Td>
                {new Date(r.created_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </Td>
              <Td>
                <span className="chip bg-slate-100 text-slate-700">
                  <Icon size={12} /> {METHOD_LABELS[r.payment_method]}
                </span>
              </Td>
              <Td className="font-bold text-rose-700">{EGP(r.amount)}</Td>
              <Td className="text-xs text-slate-500">{r.reference || '—'}</Td>
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
  const w = size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className={`bg-white rounded-2xl w-full ${w} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ReceiptModal({
  cashboxes,
  onClose,
  onSuccess,
}: {
  cashboxes: Cashbox[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQ, setCustomerQ] = useState('');
  const [cashboxId, setCashboxId] = useState(cashboxes[0]?.id || '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'settle_invoices' | 'deposit' | 'refund'>(
    'settle_invoices',
  );
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [allocations, setAllocations] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!cashboxId && cashboxes.length) setCashboxId(cashboxes[0].id);
  }, [cashboxes, cashboxId]);

  const { data: customerSearch = { data: [] } } = useQuery({
    queryKey: ['customers-search', customerQ],
    queryFn: () => customersApi.list({ q: customerQ, limit: 8 }),
    enabled: customerQ.length >= 2,
  });

  const { data: unpaid = [] } = useQuery({
    queryKey: ['unpaid-invoices', customer?.id],
    queryFn: () => customersApi.unpaidInvoices(customer!.id),
    enabled: !!customer && kind === 'settle_invoices',
  });

  const mutation = useMutation({
    mutationFn: cashDeskApi.receive,
    onSuccess: () => {
      toast.success('تم تسجيل المقبوضة');
      onSuccess();
    },
  });

  const totalAllocated = Object.values(allocations).reduce((s, v) => s + v, 0);

  const submit = () => {
    if (!customer) return toast.error('اختر عميلاً');
    if (!cashboxId) return toast.error('اختر الخزينة');
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error('أدخل مبلغاً صحيحاً');
    if (kind === 'settle_invoices' && Math.abs(totalAllocated - amt) > 0.01) {
      return toast.error('مجموع التخصيصات لا يساوي المبلغ');
    }
    mutation.mutate({
      customer_id: customer.id,
      cashbox_id: cashboxId,
      payment_method: method,
      amount: amt,
      kind,
      reference: reference || undefined,
      notes: notes || undefined,
      allocations:
        kind === 'settle_invoices'
          ? Object.entries(allocations)
              .filter(([, v]) => v > 0)
              .map(([invoice_id, amount]) => ({ invoice_id, amount }))
          : undefined,
    });
  };

  return (
    <Modal title="استلام مقبوضة من عميل" onClose={onClose} size="lg">
      <div className="space-y-4">
        {/* Customer search */}
        <Field label="العميل">
          {customer ? (
            <div className="flex items-center justify-between p-3 bg-brand-50 rounded-lg">
              <div>
                <div className="font-bold">{customer.full_name}</div>
                <div className="text-xs text-slate-600 font-mono">{customer.code}</div>
                {typeof customer.current_balance !== 'undefined' && (
                  <div className="text-xs text-rose-600 font-bold mt-1">
                    مستحق: {EGP(customer.current_balance)}
                  </div>
                )}
              </div>
              <button onClick={() => setCustomer(null)} className="text-rose-600">
                <X size={18} />
              </button>
            </div>
          ) : (
            <>
              <input
                autoFocus
                className="input"
                placeholder="ابحث بالاسم أو الرقم..."
                value={customerQ}
                onChange={(e) => setCustomerQ(e.target.value)}
              />
              {customerQ.length >= 2 && customerSearch.data.length > 0 && (
                <div className="mt-2 border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                  {customerSearch.data.map((c: Customer) => (
                    <button
                      key={c.id}
                      className="w-full text-right px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                      onClick={() => {
                        setCustomer(c);
                        setCustomerQ('');
                      }}
                    >
                      <div className="font-bold">{c.full_name}</div>
                      <div className="text-xs text-slate-500">
                        {c.phone} · {c.code}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>

        {/* Type */}
        <div className="grid grid-cols-3 gap-2">
          {(['settle_invoices', 'deposit', 'refund'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`py-2 rounded-lg font-bold text-sm ${
                kind === k
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {k === 'settle_invoices'
                ? 'سداد فواتير'
                : k === 'deposit'
                  ? 'عربون/مقدم'
                  : 'استرجاع'}
            </button>
          ))}
        </div>

        {/* Cashbox + method */}
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الخزينة">
            <select
              className="input"
              value={cashboxId}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              {cashboxes.map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name} ({EGP(cb.current_balance)})
                </option>
              ))}
            </select>
          </Field>

          <Field label="طريقة الدفع">
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            >
              <option value="cash">نقدي</option>
              <option value="card">بطاقة</option>
              <option value="instapay">إنستا باي</option>
              <option value="bank_transfer">تحويل بنكي</option>
            </select>
          </Field>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <Field label="المبلغ">
            <input
              type="number"
              step="0.01"
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="المرجع (اختياري)">
            <input
              className="input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="رقم إيصال/تحويل"
            />
          </Field>
        </div>

        {/* Allocations */}
        {kind === 'settle_invoices' && customer && unpaid.length > 0 && (
          <div className="border border-slate-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-bold">توزيع على الفواتير المستحقة</div>
              <button
                type="button"
                className="text-xs text-brand-600 hover:underline"
                onClick={() => {
                  let left = Number(amount) || 0;
                  const next: Record<string, number> = {};
                  for (const inv of unpaid) {
                    if (left <= 0) break;
                    const rem = Number(inv.remaining);
                    const take = Math.min(rem, left);
                    next[inv.id] = take;
                    left -= take;
                  }
                  setAllocations(next);
                }}
              >
                توزيع تلقائي (الأقدم أولاً)
              </button>
            </div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {unpaid.map((inv) => (
                <div
                  key={inv.id}
                  className="grid grid-cols-[1fr_100px_120px] gap-2 items-center text-sm"
                >
                  <div>
                    <div className="font-mono font-bold text-xs">
                      <InvoiceHoverCard
                        invoiceId={inv.id}
                        label={inv.invoice_no}
                        className="font-mono font-bold text-xs text-slate-800 hover:text-indigo-700 hover:underline"
                      />
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {new Date(inv.completed_at).toLocaleDateString('en-US')}
                    </div>
                  </div>
                  <div className="text-xs text-rose-600 font-bold text-left">
                    متبقي {EGP(inv.remaining)}
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max={inv.remaining}
                    className="input text-sm"
                    placeholder="0.00"
                    value={allocations[inv.id] || ''}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 0;
                      setAllocations({ ...allocations, [inv.id]: v });
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-100 flex justify-between text-sm">
              <span>إجمالي التخصيص</span>
              <span
                className={`font-black ${
                  Math.abs(totalAllocated - Number(amount || 0)) < 0.01
                    ? 'text-emerald-600'
                    : 'text-rose-600'
                }`}
              >
                {EGP(totalAllocated)}
              </span>
            </div>
          </div>
        )}

        <Field label="ملاحظات">
          <textarea
            rows={2}
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={submit}
            disabled={mutation.isPending}
          >
            <Plus size={18} /> حفظ المقبوضة
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SupplierPayModal({
  cashboxes,
  onClose,
  onSuccess,
}: {
  cashboxes: Cashbox[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [supplierQ, setSupplierQ] = useState('');
  const [cashboxId, setCashboxId] = useState(cashboxes[0]?.id || '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!cashboxId && cashboxes.length) setCashboxId(cashboxes[0].id);
  }, [cashboxes, cashboxId]);

  const { data: supplierSearch = [] } = useQuery({
    queryKey: ['suppliers-search', supplierQ],
    queryFn: () => suppliersApi.list(supplierQ),
    enabled: supplierQ.length >= 2,
  });

  const mutation = useMutation({
    mutationFn: cashDeskApi.pay,
    onSuccess: () => {
      toast.success('تم تسجيل الدفعة');
      onSuccess();
    },
  });

  const submit = () => {
    if (!supplier) return toast.error('اختر المورد');
    if (!cashboxId) return toast.error('اختر الخزينة');
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error('أدخل مبلغاً صحيحاً');
    mutation.mutate({
      supplier_id: supplier.id,
      cashbox_id: cashboxId,
      payment_method: method,
      amount: amt,
      reference: reference || undefined,
      notes: notes || undefined,
    });
  };

  return (
    <Modal title="دفعة لمورد" onClose={onClose}>
      <div className="space-y-4">
        <Field label="المورد">
          {supplier ? (
            <div className="flex items-center justify-between p-3 bg-brand-50 rounded-lg">
              <div>
                <div className="font-bold">{supplier.name}</div>
                <div className="text-xs text-slate-600 font-mono">{supplier.code}</div>
              </div>
              <button onClick={() => setSupplier(null)} className="text-rose-600">
                <X size={18} />
              </button>
            </div>
          ) : (
            <>
              <input
                autoFocus
                className="input"
                placeholder="ابحث باسم المورد..."
                value={supplierQ}
                onChange={(e) => setSupplierQ(e.target.value)}
              />
              {supplierQ.length >= 2 && supplierSearch.length > 0 && (
                <div className="mt-2 border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                  {supplierSearch.map((s) => (
                    <button
                      key={s.id}
                      className="w-full text-right px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                      onClick={() => {
                        setSupplier(s);
                        setSupplierQ('');
                      }}
                    >
                      <div className="font-bold">{s.name}</div>
                      <div className="text-xs text-slate-500">
                        {s.phone || '—'} · {s.code}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>

        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الخزينة">
            <select
              className="input"
              value={cashboxId}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              {cashboxes.map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name} ({EGP(cb.current_balance)})
                </option>
              ))}
            </select>
          </Field>
          <Field label="طريقة الدفع">
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            >
              <option value="cash">نقدي</option>
              <option value="card">بطاقة</option>
              <option value="instapay">إنستا باي</option>
              <option value="bank_transfer">تحويل بنكي</option>
            </select>
          </Field>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <Field label="المبلغ">
            <input
              type="number"
              step="0.01"
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="المرجع (اختياري)">
            <input
              className="input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="رقم إيصال"
            />
          </Field>
        </div>

        <Field label="ملاحظات">
          <textarea
            rows={2}
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={submit}
            disabled={mutation.isPending}
          >
            <ArrowUpCircle size={18} /> حفظ الدفعة
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function VoidReceiptModal({
  payment,
  onClose,
  onSuccess,
}: {
  payment: CustomerPayment;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: (r: string) => cashDeskApi.voidCustomerPayment(payment.id, r),
    onSuccess: () => {
      toast.success('تم إلغاء المقبوضة');
      onSuccess();
    },
  });

  return (
    <Modal title={`إلغاء المقبوضة ${payment.doc_no}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm">
          <div className="font-bold text-rose-700">تنبيه</div>
          <div className="text-rose-600">
            سيتم عكس القيد على الخزينة ورصيد العميل ودفتر الأستاذ.
          </div>
        </div>
        <Field label="سبب الإلغاء">
          <textarea
            rows={3}
            className="input"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="اشرح سبب الإلغاء..."
          />
        </Field>
        <div className="flex gap-2">
          <button
            className="flex-1 bg-rose-600 text-white font-bold px-4 py-2 rounded-lg hover:bg-rose-700 disabled:opacity-50"
            onClick={() => reason.length >= 3 && mutation.mutate(reason)}
            disabled={reason.length < 3 || mutation.isPending}
          >
            تأكيد الإلغاء
          </button>
          <button className="btn-secondary" onClick={onClose}>
            رجوع
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

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
