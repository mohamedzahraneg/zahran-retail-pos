/**
 * SupplierSearch — Purchases UX fixes
 *
 * Typeahead supplier picker that replaces the long select dropdown in
 * the create / edit purchase modals. Re-uses `suppliersApi.list(q)`
 * (read-only, no new endpoint). Behaviour:
 *
 *   • 200ms debounce on the input
 *   • exact `code` match is hoisted to the top of the list with a
 *     "تطابق كامل" badge
 *   • Enter selects the first highlighted row (or the lone exact
 *     match) — the barcode-scanner flow
 *   • clear/change button after a supplier is picked
 *
 * The component never mutates any data — it only emits `onSelect` with
 * the picked Supplier. The parent owns the selection state and is
 * responsible for rendering SupplierContextCard or similar follow-ups.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, Search, X } from 'lucide-react';
import { suppliersApi, type Supplier } from '@/api/suppliers.api';

export interface SupplierSearchProps {
  /** Currently selected supplier (controlled). */
  value: Supplier | null;
  /** Called when the operator picks a supplier from the result list. */
  onSelect: (supplier: Supplier) => void;
  /** Called when the operator clears the selection (back to search). */
  onClear: () => void;
  /** Optional autoFocus when no selection yet. Defaults to true. */
  autoFocus?: boolean;
  placeholder?: string;
}

export function SupplierSearch({
  value,
  onSelect,
  onClear,
  autoFocus = true,
  placeholder = 'ابحث بالكود أو الاسم أو رقم الهاتف...',
}: SupplierSearchProps) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce the query at 200ms — matches PurchaseProductSearch.
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setDebounced('');
      return;
    }
    const t = setTimeout(() => setDebounced(trimmed), 200);
    return () => clearTimeout(t);
  }, [text]);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['supplier-search', debounced],
    queryFn: () => suppliersApi.list(debounced),
    enabled: debounced.length >= 1,
    staleTime: 10_000,
  });

  // Hoist exact code/name matches to the top with a tag.
  const sorted = useMemo(() => {
    if (debounced.length === 0) return [] as Array<Supplier & { exact?: boolean }>;
    const q = debounced.toLowerCase();
    const exact: Array<Supplier & { exact?: boolean }> = [];
    const rest: Array<Supplier & { exact?: boolean }> = [];
    for (const s of results) {
      const code = (s.code || '').toLowerCase();
      const name = (s.name || '').toLowerCase();
      if (code === q || name === q) exact.push({ ...s, exact: true });
      else rest.push(s);
    }
    return [...exact, ...rest];
  }, [results, debounced]);

  const choose = (s: Supplier) => {
    onSelect(s);
    setText('');
    setDebounced('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // Stop the form from accidentally submitting before the operator
    // confirms the row.
    e.preventDefault();
    if (sorted.length === 0) return;
    // Barcode-scanner flow: if the first result is an exact match, or
    // there's a single result, pick it. Otherwise pick the first.
    choose(sorted[0]);
  };

  // Selected state — render the read-only summary + change button.
  if (value) {
    return (
      <div
        data-testid="supplier-search-selected"
        className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 flex items-center justify-between gap-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Check className="w-4 h-4 text-emerald-600" />
            <span className="font-bold text-slate-800 truncate">
              {value.name}
            </span>
            <span className="text-xs font-mono text-slate-500">
              {value.code}
            </span>
            {value.phone ? (
              <span className="text-xs text-slate-500">· {value.phone}</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onClear();
            // Defer focus so the input is mounted before we grab it.
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="text-xs font-bold text-amber-700 hover:text-amber-900 underline-offset-2 hover:underline whitespace-nowrap"
          data-testid="supplier-search-clear"
        >
          تغيير المورد
        </button>
      </div>
    );
  }

  return (
    <div data-testid="supplier-search" className="space-y-2">
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          className="input pr-9 w-full"
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          data-testid="supplier-search-input"
        />
        {isFetching ? (
          <Loader2
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400"
            aria-hidden
          />
        ) : text.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setText('');
              setDebounced('');
              inputRef.current?.focus();
            }}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            aria-label="مسح"
          >
            <X className="w-4 h-4" />
          </button>
        ) : null}
      </div>

      {debounced.length > 0 && !isFetching && sorted.length === 0 ? (
        <div
          data-testid="supplier-search-empty"
          className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-500"
        >
          لا توجد نتائج لـ &quot;{debounced}&quot;
        </div>
      ) : null}

      {sorted.length > 0 ? (
        <div
          data-testid="supplier-search-results"
          className="rounded-lg border border-slate-200 bg-white max-h-64 overflow-y-auto divide-y divide-slate-100"
        >
          {sorted.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => choose(s)}
              className="w-full px-3 py-2 hover:bg-slate-50 text-right flex items-start justify-between gap-3"
              data-testid={`supplier-search-row-${s.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-800 truncate">
                    {s.name}
                  </span>
                  <span className="text-xs font-mono text-slate-500">
                    {s.code}
                  </span>
                  {s.exact ? (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700"
                      data-testid="supplier-search-exact-badge"
                    >
                      تطابق كامل
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5 flex-wrap">
                  {s.phone ? <span>{s.phone}</span> : null}
                  {s.contact_person ? (
                    <>
                      <span>·</span>
                      <span>{s.contact_person}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
