/**
 * EntitySelector — PR-FIN-3
 *
 * Adaptive dropdown that lists only the entities relevant to the
 * active tab:
 *   · gl_account     → leaf accounts from chart_of_accounts
 *   · cashbox_cash   → cashboxes WHERE kind='cash'
 *   · cashbox_bank   → cashboxes WHERE kind='bank'
 *   · cashbox_wallet → cashboxes WHERE kind='ewallet'
 *   · employee       → users WHERE deleted_at IS NULL
 *   · customer       → customers
 *   · supplier       → suppliers
 *
 * When the filtered list is empty (e.g. no banks configured), the
 * select is disabled with an explanatory placeholder so the user
 * isn't left clicking into a dead state.
 */
import { useQuery } from '@tanstack/react-query';
import { accountsApi } from '@/api/accounts.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { customersApi } from '@/api/customers.api';
import { suppliersApi } from '@/api/suppliers.api';
import { usersApi } from '@/api/users.api';
import type { StatementTab } from './StatementsTabs';

export interface EntityOption {
  id: string;
  label: string;
  hint?: string;
}

export function EntitySelector({
  tab,
  value,
  onChange,
}: {
  tab: StatementTab;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  // Entity-list queries — each tab fetches only what it needs. Keys
  // include the tab so React Query caches separate results.
  const accounts = useQuery({
    queryKey: ['statements-entity-accounts'],
    queryFn: () => accountsApi.list(false),
    enabled: tab === 'gl_account',
    staleTime: 5 * 60 * 1000,
  });
  const cashboxes = useQuery({
    queryKey: ['statements-entity-cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
    enabled: tab === 'cashbox_cash' || tab === 'cashbox_bank' || tab === 'cashbox_wallet',
    staleTime: 5 * 60 * 1000,
  });
  const employees = useQuery({
    queryKey: ['statements-entity-employees'],
    queryFn: () => usersApi.list(),
    enabled: tab === 'employee',
    staleTime: 5 * 60 * 1000,
  });
  const customers = useQuery({
    queryKey: ['statements-entity-customers'],
    queryFn: () => customersApi.list({ limit: 200 }),
    enabled: tab === 'customer',
    staleTime: 5 * 60 * 1000,
  });
  const suppliers = useQuery({
    queryKey: ['statements-entity-suppliers'],
    queryFn: () => suppliersApi.list(),
    enabled: tab === 'supplier',
    staleTime: 5 * 60 * 1000,
  });

  const options: EntityOption[] = (() => {
    if (tab === 'gl_account') {
      const list = (accounts.data ?? []) as any[];
      return list
        .filter((a) => a.is_leaf && a.is_active !== false)
        .map((a) => ({
          id: a.id,
          label: `${a.code} · ${a.name_ar}`,
          hint: a.account_type,
        }));
    }
    if (tab === 'cashbox_cash' || tab === 'cashbox_bank' || tab === 'cashbox_wallet') {
      const targetKind =
        tab === 'cashbox_cash' ? 'cash' : tab === 'cashbox_bank' ? 'bank' : 'ewallet';
      const list = (cashboxes.data ?? []) as any[];
      return list
        .filter((c) => c.kind === targetKind && c.is_active !== false)
        .map((c) => ({ id: c.id, label: c.name_ar ?? c.name_en ?? c.id }));
    }
    if (tab === 'employee') {
      const list = (employees.data ?? []) as any[];
      return list
        .filter((u) => !u.deleted_at)
        .map((u) => ({
          id: u.id,
          label: u.full_name ?? u.username ?? u.id,
          hint: u.employee_no,
        }));
    }
    if (tab === 'customer') {
      const list = ((customers.data as any)?.data ?? []) as any[];
      return list.map((c) => ({
        id: c.id,
        label: c.full_name ?? c.id,
        hint: c.customer_no,
      }));
    }
    if (tab === 'supplier') {
      const list = (suppliers.data ?? []) as any[];
      return list.map((s) => ({
        id: s.id,
        label: s.name ?? s.id,
        hint: s.supplier_no,
      }));
    }
    return [];
  })();

  const isLoading =
    (tab === 'gl_account' && accounts.isLoading) ||
    ((tab === 'cashbox_cash' || tab === 'cashbox_bank' || tab === 'cashbox_wallet') &&
      cashboxes.isLoading) ||
    (tab === 'employee' && employees.isLoading) ||
    (tab === 'customer' && customers.isLoading) ||
    (tab === 'supplier' && suppliers.isLoading);

  const emptyHint = (() => {
    if (isLoading) return 'جارٍ التحميل…';
    if (options.length === 0) {
      if (tab === 'cashbox_bank') return 'لا يوجد بنوك مفعلة بعد (PR-FIN-6)';
      if (tab === 'cashbox_wallet') return 'لا توجد محافظ مفعلة بعد (PR-FIN-6)';
      return 'لا يوجد عناصر';
    }
    return 'اختر عنصرًا';
  })();

  return (
    <div className="flex flex-col gap-1" dir="rtl">
      <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400">
        الكيان
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={options.length === 0 || isLoading}
        data-testid="statements-entity-select"
        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-[12px] text-slate-700 dark:text-slate-200 px-2 py-1.5 min-w-[260px] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <option value="">{emptyHint}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {o.hint ? ` (${o.hint})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
