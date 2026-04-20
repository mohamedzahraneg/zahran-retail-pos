import { useMemo, useState, ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string = string> {
  key: K | null;
  dir: SortDir;
}

/**
 * Compare two values with locale-aware string ordering and numeric ordering
 * for numbers/date-like strings. Null/undefined always sort last.
 */
function compare(a: any, b: any): number {
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  const aN = Number(a);
  const bN = Number(b);
  if (!Number.isNaN(aN) && !Number.isNaN(bN) && typeof a !== 'boolean') {
    return aN - bN;
  }
  // Treat ISO date strings like numbers via Date.parse
  const aD = Date.parse(a);
  const bD = Date.parse(b);
  if (!Number.isNaN(aD) && !Number.isNaN(bD)) return aD - bD;
  return String(a).localeCompare(String(b), 'ar');
}

/**
 * Generic client-side sorting for list pages. Returns a `sorted` array and
 * helpers to render sortable headers:
 *
 *   const { sorted, thProps, sortIcon } = useTableSort(rows, 'created_at', 'desc');
 *   <th {...thProps('grand_total')}>الإجمالي {sortIcon('grand_total')}</th>
 *
 * Clicking a header toggles asc → desc → clear. Supports custom accessors
 * via `accessors` for nested/derived fields.
 */
export function useTableSort<T extends Record<string, any>>(
  rows: T[] | null | undefined,
  initialKey: string | null = null,
  initialDir: SortDir = 'desc',
  accessors: Record<string, (row: T) => any> = {},
) {
  const [state, setState] = useState<SortState>({
    key: initialKey,
    dir: initialDir,
  });

  const sorted = useMemo(() => {
    const arr = Array.isArray(rows) ? [...rows] : [];
    if (!state.key) return arr;
    const getter =
      accessors[state.key] || ((r: T) => (r as any)[state.key as string]);
    arr.sort((a, b) => compare(getter(a), getter(b)));
    if (state.dir === 'desc') arr.reverse();
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state.key, state.dir]);

  const toggle = (key: string) => {
    setState((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return { key: null, dir: 'desc' };
    });
  };

  const thProps = (key: string) => ({
    role: 'button',
    tabIndex: 0,
    onClick: () => toggle(key),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(key);
      }
    },
    className:
      'cursor-pointer select-none hover:bg-slate-100/60 transition-colors',
    'data-sort-key': key,
  });

  const sortIcon = (key: string): ReactNode => {
    if (state.key !== key) {
      return (
        <ArrowUpDown className="inline-block w-3 h-3 opacity-30 mr-1" />
      );
    }
    return state.dir === 'asc' ? (
      <ArrowUp className="inline-block w-3 h-3 text-indigo-600 mr-1" />
    ) : (
      <ArrowDown className="inline-block w-3 h-3 text-indigo-600 mr-1" />
    );
  };

  return { sorted, state, setState, toggle, thProps, sortIcon };
}
