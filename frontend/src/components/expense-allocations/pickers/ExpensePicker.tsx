/**
 * ExpensePicker — single-select for approved expenses (PR-FE-B.1).
 *
 * Reusable; not wired in FE-B.1.  FE-B.3 will mount it from the line
 * modal when the source kind is "expense" (vs "expense category").
 *
 * Filter contract (FE-B.1):
 *   * Caller passes `period_start` / `period_end` from the parent
 *     period record; the picker uses them as the fixed default date
 *     range.
 *   * No internal date-range inputs and no "widen scope" toggle in
 *     FE-B.1 — those are deferred per the design.
 *   * Only `status: 'approved'` expenses are queried (draft / pending
 *     expenses can't be allocated).
 *
 * Search input is debounced 250 ms; query stays disabled until the
 * popover opens.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Search, X as XIcon, Loader2 } from 'lucide-react';
import { accountingApi, type Expense } from '@/api/accounting.api';
import { fmtCairoDate } from '@/lib/dates';

export interface ExpensePickerProps {
  value: string | null;
  onChange: (id: string | null, label?: string) => void;
  /** Period range — both required.  Used verbatim as the from/to
   *  filter on GET /accounting/expenses.  Format: 'YYYY-MM-DD'. */
  period_start: string;
  period_end: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const FETCH_LIMIT = 30;

export function ExpensePicker({
  value,
  onChange,
  period_start,
  period_end,
  disabled,
  placeholder = 'اختر مصروفًا معتمدًا…',
  className = '',
}: ExpensePickerProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { data, isFetching } = useQuery({
    queryKey: [
      'picker',
      'expenses',
      'approved',
      period_start,
      period_end,
      debouncedQ,
    ] as const,
    queryFn: () =>
      accountingApi.listExpenses({
        from: period_start,
        to: period_end,
        status: 'approved',
        q: debouncedQ || undefined,
        limit: FETCH_LIMIT,
      }),
    enabled: open && !!period_start && !!period_end,
    staleTime: 30_000,
  });
  const expenses: Expense[] = data?.items ?? [];

  const selected = expenses.find((e) => e.id === value);
  const displayLabel =
    selected?.expense_no ?? (value ? '…' : null);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex-1 truncate text-right">
          {displayLabel ? (
            <>
              <span className="font-mono tabular-nums">{displayLabel}</span>
              {selected && (
                <span className="ms-2 text-xs text-slate-500">
                  · {Number(selected.amount).toLocaleString('en-EG')} جنيه
                </span>
              )}
            </>
          ) : (
            <span className="text-slate-400">{placeholder}</span>
          )}
        </span>
        {value && !disabled && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onChange(null);
              }
            }}
            aria-label="مسح الاختيار"
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <XIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 max-h-80 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
            النطاق: {fmtCairoDate(period_start)} — {fmtCairoDate(period_end)}{' '}
            · مصاريف معتمدة فقط
          </div>
          <div className="border-b border-slate-100 p-2">
            <div className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1">
              <Search className="h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="بحث برقم المصروف أو الوصف…"
                autoFocus
                dir="rtl"
                className="flex-1 bg-transparent text-sm focus:outline-none"
              />
              {isFetching && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
              )}
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {!isFetching && expenses.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                لا توجد مصاريف معتمدة في هذا النطاق.
              </div>
            ) : (
              expenses.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => {
                    onChange(e.id, e.expense_no);
                    setOpen(false);
                    setInput('');
                  }}
                  className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-slate-50 ${
                    e.id === value ? 'bg-violet-50/60' : ''
                  }`}
                >
                  <div className="flex-1 truncate">
                    <div className="font-mono text-xs tabular-nums text-slate-700">
                      {e.expense_no}
                    </div>
                    <div className="truncate text-[11px] text-slate-500">
                      {fmtCairoDate(e.expense_date)}
                      {e.category_name && <> · {e.category_name}</>}
                    </div>
                  </div>
                  <div className="font-mono tabular-nums text-slate-800">
                    {Number(e.amount).toLocaleString('en-EG', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
