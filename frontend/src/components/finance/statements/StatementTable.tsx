/**
 * StatementTable — PR-FIN-3
 *
 * Single read-only table that renders rows from any statement type.
 * Columns: التاريخ · البيان · المرجع · مدين · دائن · الرصيد · الطرف
 * المقابل. Voided rows render struck-through; their running_balance
 * matches the previous live row (handled by the backend service).
 *
 * Drilldown is intentionally a disabled placeholder pointing at
 * PR-FIN-4 — clicking does nothing.
 */
import type { StatementResponse, StatementRow } from '@/api/statements.api';

const fmtEGP = (n: number | null | undefined) => {
  const x = Number(n ?? 0);
  if (!isFinite(x)) return '0.00';
  return x.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

export function StatementTable({ data }: { data: StatementResponse }) {
  if (data.rows.length === 0) {
    return (
      <div
        className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-8 text-center"
        data-testid="statement-empty-state"
        dir="rtl"
      >
        <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
          لا توجد حركات
        </div>
        {data.confidence.note && (
          <div
            className="text-[12px] text-slate-500 dark:text-slate-400 mt-2 leading-relaxed max-w-xl mx-auto"
            data-testid="statement-empty-note"
          >
            {data.confidence.note}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden"
      data-testid="statement-table"
      dir="rtl"
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
            <tr>
              <Th>التاريخ</Th>
              <Th>البيان</Th>
              <Th>المرجع</Th>
              <Th align="left">مدين</Th>
              <Th align="left">دائن</Th>
              <Th align="left">الرصيد</Th>
              <Th>الطرف المقابل</Th>
            </tr>
          </thead>
          <tbody>
            {/* Opening row */}
            <tr className="bg-slate-50/40 dark:bg-slate-800/40 font-bold border-t border-slate-100 dark:border-slate-800">
              <Td className="font-mono tabular-nums">{fmtDate(data.range.from)}</Td>
              <Td colSpan={5}>الرصيد الافتتاحي</Td>
              <Td className="font-mono tabular-nums text-left">
                {fmtEGP(data.opening_balance)}
              </Td>
            </tr>
            {data.rows.map((row, i) => (
              <Row
                key={`${row.journal_entry_no ?? row.reference_no ?? i}-${i}`}
                row={row}
              />
            ))}
            {/* Closing row */}
            <tr className="bg-brand-50 dark:bg-brand-900/30 font-bold border-t-2 border-brand-200 dark:border-brand-800">
              <Td className="font-mono tabular-nums">{fmtDate(data.range.to)}</Td>
              <Td colSpan={2}>الرصيد الختامي</Td>
              <Td className="font-mono tabular-nums text-left">
                {fmtEGP(data.totals.debit)}
              </Td>
              <Td className="font-mono tabular-nums text-left">
                {fmtEGP(data.totals.credit)}
              </Td>
              <Td className="font-mono tabular-nums text-left text-brand-700 dark:text-brand-400">
                {fmtEGP(data.closing_balance)}
              </Td>
              <Td>—</Td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ row }: { row: StatementRow }) {
  const voided = row.is_voided;
  return (
    <tr
      className={`border-t border-slate-100 dark:border-slate-800 ${voided ? 'line-through text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-200'}`}
      data-testid="statement-row"
      data-voided={voided ? 'true' : 'false'}
      // PR-FIN-3 — drilldown drawer is wired in PR-FIN-4. Until then,
      // clicking is a no-op (cursor stays default).
    >
      <Td className="font-mono tabular-nums whitespace-nowrap">
        {fmtDate(row.event_date)}
      </Td>
      <Td className="max-w-[280px] truncate" title={row.description}>
        {row.description}
      </Td>
      <Td className="font-mono text-[10px] whitespace-nowrap">
        {row.reference_no ?? row.reference_type ?? '—'}
      </Td>
      <Td className="font-mono tabular-nums text-left text-emerald-700 dark:text-emerald-400">
        {row.debit ? fmtEGP(row.debit) : '—'}
      </Td>
      <Td className="font-mono tabular-nums text-left text-rose-700 dark:text-rose-400">
        {row.credit ? fmtEGP(row.credit) : '—'}
      </Td>
      <Td className="font-mono tabular-nums text-left">
        {fmtEGP(row.running_balance)}
      </Td>
      <Td>{row.counterparty ?? '—'}</Td>
    </tr>
  );
}

function Th({
  children,
  align = 'right',
}: {
  children: React.ReactNode;
  align?: 'right' | 'left';
}) {
  return (
    <th
      className={`text-${align} px-3 py-2 text-[10px] font-bold whitespace-nowrap`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
  colSpan,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  colSpan?: number;
  title?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`px-3 py-2 text-[11px] ${className}`}
      title={title}
    >
      {children}
    </td>
  );
}
