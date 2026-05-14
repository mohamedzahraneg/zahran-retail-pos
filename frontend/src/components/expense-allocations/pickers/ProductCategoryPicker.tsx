/**
 * ProductCategoryPicker — single-select for product categories
 * (PR-FE-B.1).
 *
 * Reusable; not wired in FE-B.1.  FE-B.3 will mount it from the line
 * modal when the line's target kind is "category".
 *
 * Data source: GET /categories (one-shot list; small N).  Local filter
 * on Arabic name / slug.  Only active categories.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Search, X as XIcon } from 'lucide-react';
import { categoriesApi, type Category } from '@/api/categories.api';

export interface ProductCategoryPickerProps {
  value: string | null;
  onChange: (id: string | null, label?: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function ProductCategoryPicker({
  value,
  onChange,
  disabled,
  placeholder = 'اختر فئة منتجات…',
  className = '',
}: ProductCategoryPickerProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

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

  const { data } = useQuery({
    queryKey: ['picker', 'product-categories'] as const,
    queryFn: () => categoriesApi.list(),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const categories: Category[] = useMemo(() => data ?? [], [data]);
  const active = useMemo(
    () => categories.filter((c) => c.is_active !== false),
    [categories],
  );

  const filtered = useMemo(() => {
    const q = input.trim().toLowerCase();
    if (!q) return active;
    return active.filter(
      (c) =>
        c.name_ar.toLowerCase().includes(q) ||
        (c.slug ?? '').toLowerCase().includes(q),
    );
  }, [active, input]);

  const selected = categories.find((c) => c.id === value);
  const displayLabel = selected?.name_ar ?? (value ? '…' : null);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex-1 truncate text-right">
          {displayLabel ?? <span className="text-slate-400">{placeholder}</span>}
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
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <div className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1">
              <Search className="h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="بحث…"
                autoFocus
                dir="rtl"
                className="flex-1 bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                لا توجد نتائج.
              </div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onChange(c.id, c.name_ar);
                    setOpen(false);
                    setInput('');
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-slate-50 ${
                    c.id === value ? 'bg-violet-50/60' : ''
                  }`}
                >
                  <span className="flex-1 truncate text-slate-800">
                    {c.name_ar}
                  </span>
                  {c.slug && (
                    <span className="font-mono text-[11px] text-slate-400">
                      {c.slug}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
