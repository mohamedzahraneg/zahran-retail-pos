/**
 * AdjustmentsTab — PR-T4.1
 * ─────────────────────────────────────────────────────────────────────
 *
 * Focused السلف والخصومات tab. Replaces the duplicate that PR-T3
 * accidentally created when the same <AccountsMovementsTab> was wired
 * into both `accounts` and `advances` tab slots. Per the user spec:
 *
 *   · الحسابات والحركات owns the FULL ledger + payout button
 *   · السلف والخصومات owns ONLY the adjustments view —
 *       three focused tables (السلف / الخصومات / المكافآت) +
 *       summary cards focused on net employee receivables/payables +
 *       three focused action buttons
 *
 * No backend changes — reads the same /employees/:id/ledger response
 * that the accounts tab reads, just filters down to the adjustment-
 * type rows. Reuses the existing AdvanceModal / BonusModal /
 * DeductionModal from AccountsMovementsTab.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingDown,
  Gift,
  Minus,
  Wallet,
} from 'lucide-react';
import {
  employeesApi,
  EmployeeGlLedgerEntry,
  TeamRow,
} from '@/api/employees.api';
import { useAuthStore } from '@/stores/auth.store';
import {
  AdvanceModal,
  BonusModal,
  DeductionModal,
} from '@/components/team/AccountsMovementsTab';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

function monthBounds(): { from: string; to: string } {
  const today = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

type Bucket = 'advance' | 'bonus' | 'deduction';
type Modal = Bucket | null;

interface ClassifiedRow extends EmployeeGlLedgerEntry {
  bucket: Bucket;
}

function classify(rows: EmployeeGlLedgerEntry[]): ClassifiedRow[] {
  const out: ClassifiedRow[] = [];
  for (const r of rows) {
    const rt = r.reference_type || '';
    let bucket: Bucket | null = null;
    if (rt.includes('advance') || (r.account_code === '1123' && r.debit > 0))
      bucket = 'advance';
    else if (rt.includes('bonus') || (r.account_code === '213' && r.credit > 0 && rt.includes('bonus')))
      bucket = 'bonus';
    else if (rt.includes('deduction') || (r.account_code === '213' && r.debit > 0 && rt.includes('deduction')))
      bucket = 'deduction';
    if (bucket) out.push({ ...r, bucket });
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────
 * Top-level component
 * ───────────────────────────────────────────────────────────────── */

export function AdjustmentsTab({ employee }: { employee: TeamRow }) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canBonus = hasPermission('employee.bonuses.manage');
  const canDeduct = hasPermission('employee.deductions.manage');
  const canAdvance = hasPermission('employee.deductions.manage');

  const [modal, setModal] = useState<Modal>(null);
  const range = useMemo(() => monthBounds(), []);

  const { data: ledger, isFetching } = useQuery({
    queryKey: ['employee-ledger', employee.id, range.from, range.to],
    queryFn: () => employeesApi.userLedger(employee.id, range.from, range.to),
  });

  const classified = useMemo(
    () => classify(ledger?.gl_entries ?? []),
    [ledger],
  );
  const advances = useMemo(
    () => classified.filter((r) => r.bucket === 'advance'),
    [classified],
  );
  const bonuses = useMemo(
    () => classified.filter((r) => r.bucket === 'bonus'),
    [classified],
  );
  const deductions = useMemo(
    () => classified.filter((r) => r.bucket === 'deduction'),
    [classified],
  );

  const totals = useMemo(() => {
    const sum = (rows: ClassifiedRow[]) =>
      rows
        .filter((r) => !r.is_voided)
        .reduce((s, r) => s + (r.debit || 0) + (r.credit || 0), 0);
    const advancesT = sum(advances);
    const bonusesT = sum(bonuses);
    const deductionsT = sum(deductions);
    // Net effect on employee receivable/payable (sign convention from
    // PR-25's signed_effect): bonuses ADD payable (good for employee),
    // deductions REDUCE payable (bad for employee), advances make the
    // employee owe the company (bad for employee).
    const netImpact = bonusesT - deductionsT - advancesT;
    return { advancesT, bonusesT, deductionsT, netImpact };
  }, [advances, bonuses, deductions]);

  return (
    <div className="space-y-5">
      <HeaderCard />

      {/* Action bar — three focused buttons. Permission-aware. The
          payout button intentionally does NOT live here (it belongs
          on الحسابات والحركات per PR-T3.1). */}
      <div className="flex items-center justify-end flex-wrap gap-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-3">
        {canAdvance && (
          <ActionButton
            tone="indigo"
            icon={<TrendingDown size={15} />}
            onClick={() => setModal('advance')}
          >
            تسجيل سلفة
          </ActionButton>
        )}
        {canDeduct && (
          <ActionButton
            tone="rose"
            icon={<Minus size={15} />}
            onClick={() => setModal('deduction')}
          >
            تسجيل خصم
          </ActionButton>
        )}
        {canBonus && (
          <ActionButton
            tone="emerald"
            icon={<Gift size={15} />}
            onClick={() => setModal('bonus')}
          >
            تسجيل مكافأة
          </ActionButton>
        )}
      </div>

      {/* Summary cards — focused on adjustments only. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          tone="violet"
          label="إجمالي السلف (الشهر)"
          value={EGP(totals.advancesT)}
          sub={`${advances.filter((r) => !r.is_voided).length} حركة نشطة`}
        />
        <StatCard
          tone="rose"
          label="إجمالي الخصومات (الشهر)"
          value={EGP(totals.deductionsT)}
          sub={`${deductions.filter((r) => !r.is_voided).length} حركة نشطة`}
        />
        <StatCard
          tone="green"
          label="إجمالي المكافآت (الشهر)"
          value={EGP(totals.bonusesT)}
          sub={`${bonuses.filter((r) => !r.is_voided).length} حركة نشطة`}
        />
        <StatCard
          tone={totals.netImpact > 0.01 ? 'green' : totals.netImpact < -0.01 ? 'rose' : 'slate'}
          label="صافي الأثر على الموظف"
          value={EGP(Math.abs(totals.netImpact))}
          sub={
            totals.netImpact > 0.01
              ? 'يزيد المستحق له'
              : totals.netImpact < -0.01
                ? 'يقلل المستحق له'
                : 'متعادل'
          }
        />
      </div>

      {isFetching ? (
        <div className="text-center text-xs text-slate-400 py-8">
          جارٍ التحميل…
        </div>
      ) : (
        <>
          <BucketTable
            title="السلف"
            subtitle="DR 1123 / CR cashbox — يُنشئ ذمة على الموظف ويُخرج نقدًا."
            rows={advances}
            tone="violet"
          />
          <BucketTable
            title="الخصومات"
            subtitle="DR 213 / CR 521 — يقلل مستحقات الموظف. لا cashbox."
            rows={deductions}
            tone="rose"
          />
          <BucketTable
            title="المكافآت"
            subtitle="DR 521 / CR 213 — يضيف مستحقًا للموظف. لا cashbox."
            rows={bonuses}
            tone="green"
          />
        </>
      )}

      {/* Modals — reused verbatim from AccountsMovementsTab */}
      {modal === 'advance' && (
        <AdvanceModal employee={employee} onClose={() => setModal(null)} />
      )}
      {modal === 'bonus' && (
        <BonusModal employee={employee} onClose={() => setModal(null)} />
      )}
      {modal === 'deduction' && (
        <DeductionModal employee={employee} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Sections
 * ───────────────────────────────────────────────────────────────── */

function HeaderCard() {
  return (
    <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center shrink-0">
          <Wallet size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-black text-violet-900">
            السلف والخصومات
          </h3>
          <p className="text-sm text-violet-900/70 mt-0.5">
            ملخص مركّز للسلف والخصومات والمكافآت — لا يكرر الكشف الكامل (هذا في
            تبويب الحسابات والحركات).
          </p>
        </div>
      </div>
    </div>
  );
}

function BucketTable({
  title,
  subtitle,
  rows,
  tone,
}: {
  title: string;
  subtitle: string;
  rows: ClassifiedRow[];
  tone: 'violet' | 'rose' | 'green';
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-black text-slate-800">{title}</h4>
          <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
        </div>
        <span className="text-[11px] text-slate-400 tabular-nums">
          {rows.length} حركة
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-8">
          لا توجد حركات في هذا الشهر.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <Th>التاريخ</Th>
                <Th>الوصف</Th>
                <Th>المبلغ</Th>
                <Th>رقم القيد</Th>
                <Th>الحالة</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.entry_no}-${i}`}
                  className={`border-t border-slate-100 ${
                    r.is_voided ? 'opacity-60 bg-slate-50/60' : ''
                  }`}
                >
                  <Td className="font-mono tabular-nums whitespace-nowrap">
                    {fmtDate(r.entry_date)}
                  </Td>
                  <Td className="text-slate-700 max-w-[280px] truncate" title={r.description}>
                    <span className={r.is_voided ? 'line-through' : ''}>
                      {r.description || '—'}
                    </span>
                  </Td>
                  <Td className="font-mono tabular-nums font-bold">
                    <span className={r.is_voided ? 'line-through' : ''}>
                      {EGP((r.debit || 0) + (r.credit || 0))}
                    </span>
                  </Td>
                  <Td className="font-mono text-[10px] text-slate-500">
                    {r.entry_no}
                  </Td>
                  <Td>
                    {r.is_voided ? (
                      <Chip
                        tone="rose"
                        title={r.void_reason || 'تم إلغاؤها'}
                      >
                        ملغاة
                      </Chip>
                    ) : (
                      <Chip tone={tone}>نشطة</Chip>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Small UI primitives
 * ───────────────────────────────────────────────────────────────── */

function ActionButton({
  tone,
  icon,
  onClick,
  children,
}: {
  tone: 'indigo' | 'rose' | 'emerald';
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const map: Record<string, string> = {
    indigo:  'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100',
    rose:    'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-bold ${map[tone]}`}
    >
      {icon}
      {children}
    </button>
  );
}

function StatCard({
  tone,
  label,
  value,
  sub,
}: {
  tone: 'violet' | 'rose' | 'green' | 'slate';
  label: string;
  value: string;
  sub?: string;
}) {
  const map: Record<string, string> = {
    violet: 'text-violet-700',
    rose:   'text-rose-700',
    green:  'text-emerald-700',
    slate:  'text-slate-600',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-bold text-slate-500">{label}</div>
      <div className={`text-lg font-black mt-1 tabular-nums ${map[tone]}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2.5 text-[11px] font-bold text-slate-500 bg-slate-50 whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-2.5 text-xs text-slate-700 ${className}`} title={title}>
      {children}
    </td>
  );
}

function Chip({
  tone,
  children,
  title,
}: {
  tone: 'violet' | 'rose' | 'green';
  children: React.ReactNode;
  title?: string;
}) {
  const map: Record<string, string> = {
    violet: 'bg-violet-50  text-violet-700  border-violet-200',
    rose:   'bg-rose-50    text-rose-700    border-rose-200',
    green:  'bg-emerald-50 text-emerald-700 border-emerald-200',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border ${map[tone]}`}
    >
      {children}
    </span>
  );
}
