/**
 * CashRecordsTab — PR-ESS-2A
 * ────────────────────────────────────────────────────────────────────
 *
 * Self-service "السجلات النقدية" tab on /me. Shows ONLY the cash-
 * impacting movements from the employee's own GL ledger:
 *   · سلف نقدية   (DR 1123 / CR cashbox)
 *   · صرف مستحقات (DR 213  / CR cashbox)
 *   · صرف يومية   (subset of settlements with attendance linkage)
 *
 * Read-only. No mutation buttons. The data comes from the existing
 * `GET /employees/me/ledger` endpoint — we filter client-side to rows
 * where the linked account is a cashbox (`account_code` family
 * starting with the cashbox prefix per chart-of-accounts), keeping the
 * tab a derived view rather than a new API surface.
 *
 * Why a separate tab and not a section inside القبض والصرف:
 *   The user explicitly asked for "السجلات النقدية" to live on its
 *   own tab so cash-only movements are easy to scan at a glance,
 *   without scrolling past the broader settlements ledger. Both tabs
 *   read from the same `/me/ledger` response — the QueryClient
 *   dedupes the network request.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Coins, ArrowDown, ArrowUp } from 'lucide-react';
import { employeesApi, EmployeeGlLedgerEntry } from '@/api/employees.api';

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

type CashKind = 'advance_out' | 'settlement_out' | 'other_cash';

interface CashRow extends EmployeeGlLedgerEntry {
  cash_kind: CashKind;
  type_label: string;
  direction_label: 'داخل' | 'خارج';
  /** Positive number representing the cash amount moved. */
  cash_amount: number;
}

function classifyCashRow(e: EmployeeGlLedgerEntry): CashRow | null {
  const rt = e.reference_type || '';

  // Advances on the employee's ledger appear as DR 1123 (employee
  // receivable). The cash leg is on the OTHER side of the JE which
  // isn't included in /me/ledger; the magnitude is on this row.
  if (rt.includes('advance') || (e.account_code === '1123' && e.debit > 0)) {
    return {
      ...e,
      cash_kind: 'advance_out',
      type_label: 'سلفة نقدية',
      direction_label: 'خارج',
      cash_amount: Number(e.debit) || 0,
    };
  }

  // Settlement: DR 213 / CR cashbox. Employee ledger sees the DR 213
  // leg as "the money that was paid out".
  if (rt.includes('settlement') && e.account_code === '213' && e.debit > 0) {
    return {
      ...e,
      cash_kind: 'settlement_out',
      type_label: 'صرف مستحقات',
      direction_label: 'خارج',
      cash_amount: Number(e.debit) || 0,
    };
  }

  // No other ledger row currently maps to a cash-only audit lane on
  // the employee's view. Bonuses/deductions are GL-only (no cashbox).
  return null;
}

export function CashRecordsTab() {
  const range = useMemo(() => monthBounds(), []);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  const { data: ledger, isFetching } = useQuery({
    queryKey: ['employee-ledger-self', from, to],
    queryFn: () => employeesApi.myLedger(from, to),
  });

  const cashRows = useMemo<CashRow[]>(() => {
    const out: CashRow[] = [];
    for (const e of ledger?.gl_entries ?? []) {
      const classified = classifyCashRow(e);
      if (classified) out.push(classified);
    }
    return out;
  }, [ledger]);

  const totals = useMemo(() => {
    let inSum = 0;
    let outSum = 0;
    for (const r of cashRows) {
      if (r.is_voided) continue;
      if (r.direction_label === 'داخل') inSum += r.cash_amount;
      else outSum += r.cash_amount;
    }
    return { inSum, outSum, net: inSum - outSum };
  }, [cashRows]);

  return (
    <div className="space-y-5">
      <HeaderCard />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          tone="emerald"
          icon={<ArrowDown size={16} />}
          label="إجمالي الداخل (الشهر)"
          value={EGP(totals.inSum)}
        />
        <StatCard
          tone="rose"
          icon={<ArrowUp size={16} />}
          label="إجمالي الخارج (الشهر)"
          value={EGP(totals.outSum)}
        />
        <StatCard
          tone={totals.net >= 0 ? 'emerald' : 'rose'}
          icon={<Coins size={16} />}
          label="صافي الحركة"
          value={EGP(totals.net)}
        />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
          <div>
            <h4 className="text-sm font-black text-slate-800">
              السجلات النقدية
            </h4>
            <div className="text-xs text-slate-500 mt-0.5">
              السلف نقدية + صرف المستحقات. القيود الملغاة معروضة بالأثر
              صفر للمراجعة.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-700"
              title="من"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-700"
              title="إلى"
            />
          </div>
        </div>

        {isFetching ? (
          <div className="text-center text-xs text-slate-400 py-10">
            جارٍ التحميل…
          </div>
        ) : cashRows.length === 0 ? (
          <div className="text-center text-xs text-slate-400 py-10 px-4 leading-relaxed">
            لا توجد حركات نقدية في هذه الفترة.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <Th>التاريخ</Th>
                  <Th>نوع الحركة</Th>
                  <Th>الاتجاه</Th>
                  <Th>المبلغ</Th>
                  <Th>الوصف</Th>
                  <Th>رقم القيد</Th>
                  <Th>الحالة</Th>
                </tr>
              </thead>
              <tbody>
                {cashRows.map((r, i) => (
                  <tr
                    key={`${r.entry_no}-${i}`}
                    className={`border-t border-slate-100 ${
                      r.is_voided ? 'opacity-60 bg-slate-50/60' : ''
                    }`}
                  >
                    <Td className="font-mono tabular-nums whitespace-nowrap">
                      {fmtDate(r.entry_date)}
                    </Td>
                    <Td>
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border bg-violet-50 text-violet-700 border-violet-200">
                        {r.type_label}
                      </span>
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border bg-amber-50 text-amber-800 border-amber-200">
                        <ArrowUp size={11} />
                        {r.direction_label}
                      </span>
                    </Td>
                    <Td className="font-mono tabular-nums font-bold text-slate-800">
                      <span className={r.is_voided ? 'line-through' : ''}>
                        {EGP(r.cash_amount)}
                      </span>
                    </Td>
                    <Td
                      className="text-[11px] text-slate-600 max-w-[260px] truncate"
                      title={r.description ?? undefined}
                    >
                      {r.description || '—'}
                    </Td>
                    <Td className="font-mono text-[10px] text-slate-500">
                      {r.entry_no}
                    </Td>
                    <Td>
                      {r.is_voided ? (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border bg-rose-50 text-rose-700 border-rose-200">
                          ملغاة
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border bg-emerald-50 text-emerald-700 border-emerald-200">
                          نشطة
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderCard() {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
          <Banknote size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-black text-amber-900">
            السجلات النقدية
          </h3>
          <p className="text-sm text-amber-900/70 mt-0.5">
            ملخص الحركات النقدية الخاصة بي — للعرض فقط.
          </p>
        </div>
      </div>
    </div>
  );
}

type Tone = 'emerald' | 'rose';

function StatCard({
  tone,
  icon,
  label,
  value,
}: {
  tone: Tone;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  const toneMap: Record<Tone, string> = {
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-[11px] font-bold text-slate-500">
        {icon}
        {label}
      </div>
      <div
        className={`text-lg font-black mt-1 tabular-nums ${toneMap[tone]}`}
      >
        {value}
      </div>
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
