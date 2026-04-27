/**
 * Row5Movements — PR-FIN-2
 *
 * Three side-by-side panels matching the bottom-middle of the image:
 *   1. الخزائن والبنوك والمحافظ        (cash accounts table)
 *   2. آخر الحركات المالية              (recent movements — 8 visible)
 *   3. التحذيرات والتنبيهات             (alerts list)
 *
 * Per Q6 of the plan: API returns 20 movements but the UI shows 8.
 * "عرض الكل" link is a disabled placeholder until PR-FIN-4 lands.
 */
import {
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  Wallet,
  Building2,
  Smartphone,
  Receipt as ReceiptIcon,
} from 'lucide-react';
import type { FinanceDashboard } from '@/api/finance.api';
import { DashboardSection } from './shared/DashboardSection';
import { fmtEGP, fmtDateTime } from './shared/utils';

export function Row5Movements({ data }: { data: FinanceDashboard }) {
  return (
    <div
      className="grid grid-cols-1 xl:grid-cols-12 gap-3"
      dir="rtl"
      data-testid="dashboard-row-5"
    >
      <div className="xl:col-span-5">
        <CashAccountsTable rows={data.cash_accounts} />
      </div>
      <div className="xl:col-span-4">
        <RecentMovementsTable rows={data.recent_movements} />
      </div>
      <div className="xl:col-span-3">
        <AlertsPanel alerts={data.alerts} />
      </div>
    </div>
  );
}

function CashAccountsTable({
  rows,
}: {
  rows: FinanceDashboard['cash_accounts'];
}) {
  // Totals row to match the image footer.
  const totals = rows.reduce(
    (acc, r) => ({
      open: acc.open + r.opening_balance,
      inflow: acc.inflow + r.inflow,
      outflow: acc.outflow + r.outflow,
      current: acc.current + r.current_balance,
    }),
    { open: 0, inflow: 0, outflow: 0, current: 0 },
  );
  return (
    <DashboardSection
      title="الخزائن والبنوك والمحافظ"
      testId="table-cash-accounts"
      viewAllHref={null}
    >
      <div className="overflow-x-auto -mx-4 -my-4">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800">
            <tr>
              <Th>الحساب</Th>
              <Th>النوع</Th>
              <Th>الرصيد الافتتاحي</Th>
              <Th>الداخل</Th>
              <Th>الخارج</Th>
              <Th>الرصيد الحالي</Th>
              <Th>آخر حركة</Th>
              <Th>الحالة</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="text-center py-6 text-slate-400 dark:text-slate-500 text-[11px]"
                >
                  لا توجد حسابات
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const KindIcon = KIND_ICONS[r.kind] ?? Wallet;
                return (
                  <tr
                    key={r.cashbox_id}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <Td>{r.name_ar}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                        <KindIcon size={11} />
                        {KIND_LABEL_AR[r.kind] ?? r.kind}
                      </span>
                    </Td>
                    <Td className="font-mono tabular-nums">
                      {fmtEGP(r.opening_balance)}
                    </Td>
                    <Td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                      {fmtEGP(r.inflow)}
                    </Td>
                    <Td className="font-mono tabular-nums text-rose-700 dark:text-rose-400">
                      {fmtEGP(r.outflow)}
                    </Td>
                    <Td className="font-mono tabular-nums font-bold">
                      {fmtEGP(r.current_balance)}
                    </Td>
                    <Td className="font-mono tabular-nums">
                      {fmtDateTime(r.last_movement_at)}
                    </Td>
                    <Td>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          r.status === 'active'
                            ? 'bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                            : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        <CheckCircle2 size={10} />
                        {r.status === 'active' ? 'سليم' : 'متوقف'}
                      </span>
                    </Td>
                  </tr>
                );
              })
            )}
            {rows.length > 0 && (
              <tr className="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 font-bold">
                <Td colSpan={2}>الإجمالي</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(totals.open)}</Td>
                <Td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                  {fmtEGP(totals.inflow)}
                </Td>
                <Td className="font-mono tabular-nums text-rose-700 dark:text-rose-400">
                  {fmtEGP(totals.outflow)}
                </Td>
                <Td className="font-mono tabular-nums">
                  {fmtEGP(totals.current)}
                </Td>
                <Td colSpan={2}>—</Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardSection>
  );
}

const KIND_LABEL_AR: Record<string, string> = {
  cash: 'خزنة',
  bank: 'بنك',
  ewallet: 'محفظة',
  check: 'شيكات',
};
const KIND_ICONS: Record<string, typeof Wallet> = {
  cash: Wallet,
  bank: Building2,
  ewallet: Smartphone,
  check: ReceiptIcon,
};

function RecentMovementsTable({
  rows,
}: {
  rows: FinanceDashboard['recent_movements'];
}) {
  // Show 8 (per Q6); api returns 20 — the rest are reachable from the
  // future audit-trail page (PR-FIN-4).
  const visible = rows.slice(0, 8);
  return (
    <DashboardSection
      title="آخر الحركات المالية"
      testId="table-recent-movements"
      viewAllHref={null}
    >
      <div className="overflow-x-auto -mx-4 -my-4 max-h-72">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800">
            <tr>
              <Th>الوقت</Th>
              <Th>المستخدم</Th>
              <Th>نوع العملية</Th>
              <Th>المصدر</Th>
              <Th>المبلغ</Th>
              <Th>الحالة</Th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="text-center py-6 text-slate-400 dark:text-slate-500 text-[11px]"
                >
                  لا توجد حركات في الفترة الحالية
                </td>
              </tr>
            ) : (
              visible.map((m, i) => (
                <tr
                  key={`${m.journal_entry_no}-${i}`}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <Td className="font-mono tabular-nums whitespace-nowrap">
                    {fmtDateTime(m.occurred_at)}
                  </Td>
                  <Td className="truncate max-w-[100px]">
                    {m.user_name ?? '—'}
                  </Td>
                  <Td>{m.operation_type}</Td>
                  <Td className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                    {m.source_label}
                  </Td>
                  <Td className="font-mono tabular-nums">{fmtEGP(m.amount)}</Td>
                  <Td>
                    <StatusChip status={m.status} />
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </DashboardSection>
  );
}

function StatusChip({
  status,
}: {
  status: 'active' | 'voided' | 'pending';
}) {
  const map: Record<typeof status, { label: string; tone: string }> = {
    active: {
      label: 'سليم',
      tone:
        'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
    },
    voided: {
      label: 'ملغي',
      tone:
        'bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 border-rose-200 dark:border-rose-800',
    },
    pending: {
      label: 'قيد التنفيذ',
      tone:
        'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
    },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border ${m.tone}`}
    >
      {m.label}
    </span>
  );
}

function AlertsPanel({
  alerts,
}: {
  alerts: FinanceDashboard['alerts'];
}) {
  return (
    <DashboardSection
      title="التحذيرات والتنبيهات"
      testId="alerts-panel"
      viewAllHref={null}
    >
      {alerts.length === 0 ? (
        <div className="text-center py-6 text-slate-400 dark:text-slate-500 text-[11px]">
          لا توجد تحذيرات حالية
        </div>
      ) : (
        <ul className="space-y-2">
          {alerts.map((a, i) => (
            <li
              key={`${a.type}-${i}`}
              data-testid={`alert-${a.type}`}
              className="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-2.5"
            >
              <SeverityIcon severity={a.severity} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold text-slate-800 dark:text-slate-100">
                  {a.label_ar}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                  {a.description}
                </div>
              </div>
              {a.deeplink && (
                <a
                  href={a.deeplink}
                  className="text-[10px] font-bold text-brand-700 dark:text-brand-400 hover:underline shrink-0"
                >
                  عرض
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </DashboardSection>
  );
}

function SeverityIcon({
  severity,
}: {
  severity: 'info' | 'warning' | 'critical';
}) {
  const Icon =
    severity === 'critical'
      ? AlertCircle
      : severity === 'warning'
        ? AlertTriangle
        : Info;
  const tone =
    severity === 'critical'
      ? 'text-rose-700 dark:text-rose-400'
      : severity === 'warning'
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-sky-700 dark:text-sky-400';
  return <Icon size={14} className={`shrink-0 ${tone}`} aria-hidden />;
}

// ─── Tiny table primitives ─────────────────────────────────────────
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">
      {children}
    </th>
  );
}
function Td({
  children,
  className = '',
  colSpan,
}: {
  children: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`px-3 py-2 text-[11px] text-slate-700 dark:text-slate-200 ${className}`}
    >
      {children}
    </td>
  );
}
