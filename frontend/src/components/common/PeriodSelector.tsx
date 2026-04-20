import { useMemo } from 'react';
import { Calendar } from 'lucide-react';

export type PeriodKey = 'day' | 'week' | 'month' | 'year' | 'custom';

export interface PeriodRange {
  key: PeriodKey;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  label: string;
}

const LABELS: Record<PeriodKey, string> = {
  day: 'اليوم',
  week: 'الأسبوع',
  month: 'الشهر',
  year: 'السنة',
  custom: 'مخصص',
};

function toISO(d: Date) {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a period key to a concrete from/to date range anchored to today.
 * Week starts on Saturday to match local retail convention.
 */
export function resolvePeriod(
  key: PeriodKey,
  custom?: { from?: string; to?: string },
): PeriodRange {
  const today = new Date();
  const to = toISO(today);
  let from = to;
  if (key === 'day') {
    from = to;
  } else if (key === 'week') {
    const day = today.getDay(); // Sun=0..Sat=6
    // Saturday = start of our week
    const back = (day + 1) % 7; // distance to previous Saturday
    const start = new Date(today);
    start.setDate(today.getDate() - back);
    from = toISO(start);
  } else if (key === 'month') {
    from = to.slice(0, 7) + '-01';
  } else if (key === 'year') {
    from = to.slice(0, 4) + '-01-01';
  } else if (key === 'custom') {
    return {
      key,
      from: custom?.from || to,
      to: custom?.to || to,
      label: LABELS.custom,
    };
  }
  return { key, from, to, label: LABELS[key] };
}

/**
 * Reusable period switcher used across dashboards and KPIs.
 * Shows اليوم / الأسبوع / الشهر / السنة tabs plus an optional custom range
 * picker. `value` holds the active key + dates; `onChange` receives the
 * resolved PeriodRange.
 */
export function PeriodSelector({
  value,
  onChange,
  includeYear = true,
  includeCustom = true,
  showDates = true,
  className,
}: {
  value: PeriodRange;
  onChange: (p: PeriodRange) => void;
  includeYear?: boolean;
  includeCustom?: boolean;
  showDates?: boolean;
  className?: string;
}) {
  const tabs: PeriodKey[] = useMemo(() => {
    const t: PeriodKey[] = ['day', 'week', 'month'];
    if (includeYear) t.push('year');
    if (includeCustom) t.push('custom');
    return t;
  }, [includeYear, includeCustom]);

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className || ''}`}>
      <div className="inline-flex rounded-lg bg-slate-100 p-1">
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange(resolvePeriod(k, value))}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition ${
              value.key === k
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {LABELS[k]}
          </button>
        ))}
      </div>

      {value.key === 'custom' && (
        <div className="flex items-center gap-1 text-xs">
          <input
            type="date"
            value={value.from}
            onChange={(e) =>
              onChange({ ...value, from: e.target.value, label: LABELS.custom })
            }
            className="border border-slate-300 rounded-md px-2 py-1 text-xs"
          />
          <span className="text-slate-400">←</span>
          <input
            type="date"
            value={value.to}
            onChange={(e) =>
              onChange({ ...value, to: e.target.value, label: LABELS.custom })
            }
            className="border border-slate-300 rounded-md px-2 py-1 text-xs"
          />
        </div>
      )}

      {showDates && value.key !== 'custom' && (
        <div className="text-[11px] text-slate-500 flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          <span className="font-mono">{value.from}</span>
          <span>←</span>
          <span className="font-mono">{value.to}</span>
        </div>
      )}
    </div>
  );
}
