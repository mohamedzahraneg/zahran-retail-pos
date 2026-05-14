/**
 * ProductPicker — searchable single-select for products (PR-FE-B.1).
 *
 * Reusable; not wired into any mounted page in FE-B.1.  FE-B.3 will
 * import it from the line modal to pick a target product when the
 * line's target kind is "product".
 *
 * Data source: GET /products (q/active/limit/page).  Search input is
 * debounced 250 ms.  The query stays disabled until the popover opens
 * so an off-screen picker never fires a request.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Search, X as XIcon, Loader2 } from 'lucide-react';
import { productsApi, type Product } from '@/api/products.api';

export interface ProductPickerProps {
  value: string | null;
  onChange: (id: string | null, label?: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const FETCH_LIMIT = 30;

export function ProductPicker({
  value,
  onChange,
  disabled,
  placeholder = 'اختر منتجًا…',
  className = '',
}: ProductPickerProps) {
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
    queryKey: ['picker', 'products', debouncedQ] as const,
    queryFn: () =>
      productsApi.list({
        q: debouncedQ || undefined,
        active: true,
        limit: FETCH_LIMIT,
      }),
    enabled: open,
    staleTime: 30_000,
  });
  const products: Product[] = data?.data ?? [];

  const selected = products.find((p) => p.id === value);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex-1 truncate text-right">
          {selected?.name_ar ?? (value ? '…' : <span className="text-slate-400">{placeholder}</span>)}
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
                placeholder="بحث بالاسم أو الكود…"
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
            {!isFetching && products.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                لا توجد نتائج.
              </div>
            ) : (
              products.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p.id, p.name_ar);
                    setOpen(false);
                    setInput('');
                  }}
                  className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-slate-50 ${
                    p.id === value ? 'bg-violet-50/60' : ''
                  }`}
                >
                  <span className="flex-1 truncate text-slate-800">
                    {p.name_ar}
                    {p.sku_root && (
                      <span className="ms-2 font-mono text-[11px] text-slate-400">
                        {p.sku_root}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
