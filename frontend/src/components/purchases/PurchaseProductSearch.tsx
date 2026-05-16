/**
 * PurchaseProductSearch — PR-PURCHASES-P1
 *
 * Variant-level product search box for the purchase invoice line
 * entry. Replaces the cascading product → variant dropdowns with a
 * single typeahead that:
 *
 *   • debounces the query (200ms)
 *   • queries `purchasesApi.productSearch` with the optional
 *     warehouse_id (so each row shows available_stock for THIS
 *     warehouse — important for the operator about to receive stock)
 *   • renders exact-match hits FIRST with a "تطابق كامل" badge
 *   • on Enter, if the result list has exactly ONE exact match,
 *     auto-selects it (the operator's barcode-scanner flow)
 *   • when zero results, surfaces a "+ إضافة منتج سريع" CTA that
 *     the parent wires to the QuickAddProductModal
 *   • each row shows: image · product+color+size · code/barcode ·
 *     stock · cost · last purchase price · last supplier
 *   • selecting a row calls onSelect(row) and clears the input
 *
 * All visual styling matches the existing Purchases.tsx Tailwind
 * idioms (input, label, btn-primary, etc.) so the embedded usage in
 * CreatePurchaseModal feels native.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, Search } from 'lucide-react';
import {
  purchasesApi,
  type PurchaseProductSearchRow,
} from '@/api/purchases.api';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export interface PurchaseProductSearchProps {
  warehouseId?: string;
  /** Called when the operator picks a variant from the result list. */
  onSelect: (row: PurchaseProductSearchRow) => void;
  /** Called when the operator clicks "Quick add product" (no results). */
  onQuickAdd?: (queryText: string) => void;
  /** Optional autoFocus on mount. */
  autoFocus?: boolean;
  placeholder?: string;
}

export function PurchaseProductSearch({
  warehouseId,
  onSelect,
  onQuickAdd,
  autoFocus,
  placeholder = 'ابحث بالكود / الباركود / الاسم / اللون / المقاس...',
}: PurchaseProductSearchProps) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 200ms debounce.
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setDebounced('');
      return;
    }
    const t = setTimeout(() => setDebounced(trimmed), 200);
    return () => clearTimeout(t);
  }, [text]);

  const { data, isFetching } = useQuery({
    queryKey: ['purchase-product-search', debounced, warehouseId ?? ''],
    queryFn: () =>
      purchasesApi.productSearch({
        q: debounced,
        warehouse_id: warehouseId,
        limit: 25,
      }),
    enabled: debounced.length >= 1,
    staleTime: 10_000,
  });

  const results = useMemo(() => data?.results ?? [], [data]);
  const exactMatches = useMemo(
    () => results.filter((r) => r.exact_match),
    [results],
  );

  const choose = (row: PurchaseProductSearchRow) => {
    onSelect(row);
    setText('');
    setDebounced('');
    // Keep the input focused for the next scan/search.
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    if (debounced.length === 0) return;
    e.preventDefault();
    // Barcode-scanner flow: exactly one exact match → auto-select.
    if (exactMatches.length === 1) {
      choose(exactMatches[0]);
      return;
    }
    // No results AND quick-add is wired → open the quick-add modal
    // with the typed text as seed.
    if (results.length === 0 && onQuickAdd) {
      onQuickAdd(debounced);
    }
  };

  return (
    <div data-testid="purchase-product-search" className="relative space-y-2">
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          className="input pr-9"
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          data-testid="purchase-product-search-input"
        />
        {isFetching ? (
          <Loader2
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400"
            aria-hidden
          />
        ) : null}
      </div>

      {debounced.length > 0 && !isFetching && results.length === 0 ? (
        <div
          data-testid="purchase-product-search-empty"
          className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3 flex items-center justify-between gap-2"
        >
          <span className="text-sm text-slate-500">
            لا توجد نتائج لـ "{debounced}"
          </span>
          {onQuickAdd ? (
            <button
              type="button"
              onClick={() => onQuickAdd(debounced)}
              className="btn-primary text-xs"
              data-testid="purchase-product-quick-add-btn"
            >
              <Plus className="w-3.5 h-3.5" /> إضافة منتج سريع
            </button>
          ) : null}
        </div>
      ) : null}

      {results.length > 0 ? (
        <div
          data-testid="purchase-product-search-results"
          className="rounded-xl border border-slate-200 bg-white max-h-72 overflow-y-auto divide-y divide-slate-100"
        >
          {results.map((row) => (
            <button
              type="button"
              key={row.variant_id}
              onClick={() => choose(row)}
              className="w-full px-3 py-2 hover:bg-slate-50 text-right flex items-start justify-between gap-3"
              data-testid={`purchase-product-row-${row.variant_id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-800 truncate">
                    {row.name_ar}
                  </span>
                  {row.color ? (
                    <span className="text-xs text-slate-500">{row.color}</span>
                  ) : null}
                  {row.size ? (
                    <span className="text-xs text-slate-500">{row.size}</span>
                  ) : null}
                  {row.exact_match ? (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700"
                      data-testid="purchase-product-exact-badge"
                    >
                      تطابق كامل
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5 flex-wrap">
                  <span className="font-mono">{row.variant_sku}</span>
                  {row.variant_barcode ? (
                    <span className="font-mono">· {row.variant_barcode}</span>
                  ) : null}
                  <span>·</span>
                  <span>المخزون: {row.available_stock}</span>
                  {row.last_purchase_price != null ? (
                    <>
                      <span>·</span>
                      <span>آخر شراء: {EGP(row.last_purchase_price)}</span>
                    </>
                  ) : null}
                  {row.last_supplier_name ? (
                    <>
                      <span>·</span>
                      <span>المورد السابق: {row.last_supplier_name}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="text-xs text-slate-700 whitespace-nowrap">
                التكلفة: <span className="font-bold">{EGP(row.cost_price)}</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
