/**
 * StatementsTabs — PR-FIN-3
 *
 * Seven-tab selector matching the order specified in the approved
 * plan §"UX requirements". Cash / bank / wallet share the cashbox
 * endpoint; the tab simply pre-filters which cashboxes appear in
 * the entity selector. RTL.
 */
import {
  BookOpen,
  Wallet,
  Building2,
  Smartphone,
  UserCheck,
  Users,
  Truck,
} from 'lucide-react';

export type StatementTab =
  | 'gl_account'
  | 'cashbox_cash'
  | 'cashbox_bank'
  | 'cashbox_wallet'
  | 'employee'
  | 'customer'
  | 'supplier';

const TABS: { key: StatementTab; label: string; Icon: typeof BookOpen }[] = [
  { key: 'gl_account',     label: 'حساب عام', Icon: BookOpen },
  { key: 'cashbox_cash',   label: 'خزنة',     Icon: Wallet },
  { key: 'cashbox_bank',   label: 'بنك',      Icon: Building2 },
  { key: 'cashbox_wallet', label: 'محفظة',    Icon: Smartphone },
  { key: 'employee',       label: 'موظف',     Icon: UserCheck },
  { key: 'customer',       label: 'عميل',     Icon: Users },
  { key: 'supplier',       label: 'مورد',     Icon: Truck },
];

export function StatementsTabs({
  active,
  onChange,
}: {
  active: StatementTab;
  onChange: (tab: StatementTab) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-1.5 p-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm"
      data-testid="statements-tabs"
      dir="rtl"
      role="tablist"
    >
      {TABS.map((t) => {
        const isActive = t.key === active;
        const Icon = t.Icon;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            data-testid={`statements-tab-${t.key}`}
            className={[
              'inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-bold transition',
              isActive
                ? 'bg-brand-600 text-white shadow'
                : 'bg-slate-50 text-slate-700 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
            ].join(' ')}
          >
            <Icon size={14} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const STATEMENT_TABS = TABS;
