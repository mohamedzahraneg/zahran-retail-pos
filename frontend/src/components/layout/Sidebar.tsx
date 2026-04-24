import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { alertsApi } from '@/api/alerts.api';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Users,
  Truck,
  Wallet,
  CalendarClock,
  Undo2,
  TrendingDown,
  BarChart3,
  FileUp,
  Ticket,
  Bell,
  Shuffle,
  ClipboardCheck,
  FileText,
  ReceiptText,
  PackagePlus,
  Barcode as BarcodeIcon,
  MessageCircle,
  Percent,
  History,
  Clock,
  Gift,
  UserCheck,
  BadgeCheck,
  Calculator,
  BookOpen,
  Scale,
  Sparkles,
  Target,
  ShieldCheck,
  Shield,
  Repeat,
  Receipt,
  Activity,
  Users2,
  Settings,
  UserCog,
  LogOut,
  ChevronsRight,
  ChevronsLeft,
  X as XIcon,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useAuthStore } from '@/stores/auth.store';
import { useLayoutStore } from '@/stores/layout.store';

interface NavItem {
  to: string;
  label: string;
  icon: any;
  /** Legacy: role codes allowed to see this item. Kept as a fallback. */
  roles: string[];
  /** Preferred: permission(s) required to see this item. ANY match grants access. */
  permission?: string | string[];
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    title: 'الرئيسية',
    items: [
      { to: '/', label: 'لوحة التحكم', icon: LayoutDashboard, roles: ['admin', 'manager', 'accountant'], permission: 'dashboard.view' },
    ],
  },
  {
    title: 'المبيعات',
    items: [
      { to: '/pos', label: 'نقطة البيع', icon: ShoppingCart, roles: ['admin', 'manager', 'cashier'], permission: 'pos.sell' },
      { to: '/invoices', label: 'الفواتير', icon: ReceiptText, roles: ['admin', 'manager', 'accountant', 'cashier'], permission: 'invoices.view' },
      { to: '/reservations', label: 'الحجوزات', icon: CalendarClock, roles: ['admin', 'manager', 'cashier'], permission: 'reservations.view' },
      { to: '/returns', label: 'المرتجعات', icon: Undo2, roles: ['admin', 'manager', 'cashier'], permission: 'returns.view' },
      { to: '/returns-analytics', label: 'تحليلات المرتجعات', icon: TrendingDown, roles: ['admin', 'manager', 'accountant'], permission: 'returns.analytics' },
      { to: '/shifts', label: 'الورديات', icon: Clock, roles: ['admin', 'manager', 'cashier'], permission: 'shifts.view' },
      { to: '/coupons', label: 'الكوبونات', icon: Ticket, roles: ['admin', 'manager'], permission: 'coupons.view' },
      { to: '/commissions', label: 'عمولات المبيعات', icon: Percent, roles: ['admin', 'manager', 'accountant'], permission: 'commissions.view' },
    ],
  },
  {
    title: 'الحسابات والمالية',
    items: [
      // Unified accounts page — tree, journal, reports, budgets, FX,
      // approvals all live inside as tabs.
      { to: '/accounts', label: 'الحسابات', icon: BookOpen, roles: ['admin', 'manager', 'accountant'], permission: 'accounts.chart.view' },
      { to: '/opening-balance', label: 'فتح الحسابات', icon: BookOpen, roles: ['admin', 'accountant'], permission: 'accounts.journal.post' },
      { to: '/analytics', label: 'التحليلات الذكية', icon: Sparkles, roles: ['admin', 'manager', 'accountant'], permission: 'accounts.chart.view' },
      { to: '/cash-desk', label: 'الصندوق اليومي', icon: Wallet, roles: ['admin', 'manager', 'accountant', 'cashier'], permission: 'cashdesk.view' },
      { to: '/cashboxes', label: 'الخزائن والبنوك', icon: Wallet, roles: ['admin', 'manager', 'accountant'], permission: 'cashdesk.manage_accounts' },
      { to: '/recurring-expenses', label: 'المصاريف الدورية', icon: Repeat, roles: ['admin', 'manager', 'accountant'], permission: 'recurring_expenses.manage' },
      { to: '/daily-expenses', label: 'المصروفات اليومية', icon: Receipt, roles: ['admin', 'manager', 'accountant', 'cashier'], permission: 'expenses.daily.create' },
      { to: '/dashboard/financial', label: 'برج المراقبة المالية', icon: Activity, roles: ['admin', 'manager', 'accountant'], permission: 'dashboard.financial.view' },
      // /accounting (legacy), /budgets, /financial-controls,
      // /bank-reconciliation, /accounts-audit — all routes still work
      // but removed from sidebar to reduce cognitive load. Power users
      // can still navigate by URL when needed.
    ],
  },
  {
    title: 'العملاء',
    items: [
      { to: '/customers', label: 'العملاء', icon: Users, roles: ['admin', 'manager', 'cashier'], permission: 'customers.view' },
      { to: '/customer-groups', label: 'مجموعات العملاء', icon: Users2, roles: ['admin', 'manager'], permission: 'customer_groups.manage' },
      { to: '/loyalty', label: 'برنامج الولاء', icon: Gift, roles: ['admin', 'manager', 'accountant'], permission: 'loyalty.view' },
    ],
  },
  {
    title: 'المخزون',
    items: [
      { to: '/products', label: 'المنتجات', icon: Package, roles: ['admin', 'manager', 'inventory'], permission: 'products.view' },
      { to: '/stock-adjustments', label: 'تعديلات المخزون', icon: PackagePlus, roles: ['admin', 'manager', 'inventory'], permission: 'stock.adjust' },
      { to: '/stock-transfers', label: 'تحويلات المخازن', icon: Shuffle, roles: ['admin', 'manager', 'inventory'], permission: 'stock.transfer' },
      { to: '/stock-count', label: 'الجرد الفعلي', icon: ClipboardCheck, roles: ['admin', 'manager', 'inventory'], permission: 'stock.count' },
      { to: '/barcode-labels', label: 'طباعة الباركود', icon: BarcodeIcon, roles: ['admin', 'manager', 'inventory'], permission: 'products.barcode' },
    ],
  },
  {
    title: 'المشتريات',
    items: [
      { to: '/purchases', label: 'فواتير المشتريات', icon: FileText, roles: ['admin', 'manager', 'accountant', 'stock_keeper'], permission: 'purchases.view' },
      { to: '/suppliers', label: 'الموردون', icon: Truck, roles: ['admin', 'manager', 'accountant'], permission: 'suppliers.view' },
    ],
  },
  {
    title: 'التقارير',
    items: [
      { to: '/reports', label: 'التقارير', icon: BarChart3, roles: ['admin', 'manager', 'accountant'], permission: 'reports.view' },
      { to: '/alerts', label: 'التنبيهات', icon: Bell, roles: ['admin', 'manager', 'accountant'], permission: 'alerts.view' },
    ],
  },
  {
    title: 'الإدارة',
    items: [
      { to: '/users', label: 'المستخدمون', icon: UserCog, roles: ['admin', 'manager'], permission: 'users.view' },
      // Personal attendance + everything-about-you lives on /me. The
      // admin-only team attendance board is still reachable at
      // /attendance (route still registered) but no longer needs its
      // own sidebar entry — it shows up only for users with
      // attendance.view_team.
      { to: '/me', label: 'ملفي الشخصي', icon: BadgeCheck, roles: ['admin', 'manager', 'cashier', 'accountant', 'salesperson', 'inventory'], permission: 'employee.dashboard.view' },
      { to: '/attendance', label: 'حضور الفريق', icon: UserCheck, roles: ['admin', 'manager', 'accountant'], permission: 'attendance.view_team' },
      { to: '/payroll', label: 'حسابات الموظفين', icon: Wallet, roles: ['admin', 'manager', 'accountant'], permission: 'employee.team.view' },
      { to: '/team', label: 'إدارة الفريق', icon: Users2, roles: ['admin', 'manager'], permission: 'employee.team.view' },
      { to: '/settings', label: 'الإعدادات', icon: Settings, roles: ['admin'], permission: 'settings.view' },
      { to: '/import', label: 'استيراد Excel', icon: FileUp, roles: ['admin', 'manager'], permission: 'import.run' },
      { to: '/notifications', label: 'الإشعارات (واتساب)', icon: MessageCircle, roles: ['admin', 'manager'], permission: 'notifications.manage' },
      { to: '/audit-log', label: 'سجل التدقيق', icon: History, roles: ['admin', 'manager'], permission: 'audit.view' },
    ],
  },
];

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const role = user?.role || 'guest';
  const collapsed = useLayoutStore((s) => s.collapsed);
  const mobileOpen = useLayoutStore((s) => s.mobileOpen);
  const closeMobile = useLayoutStore((s) => s.closeMobile);
  const toggleCollapsed = useLayoutStore((s) => s.toggleCollapsed);

  // An item is visible only when the user has at least one of the
  // declared permissions. The old "role fallback" was leaking menu
  // items (Excel import, audit log, etc.) to managers just because
  // their role was listed — even when the admin hadn't granted them
  // the corresponding permission. Permission-only is the one rule.
  const allowed = (it: NavItem) => {
    const perms = Array.isArray(it.permission)
      ? it.permission
      : it.permission
        ? [it.permission]
        : [];
    // Items without any declared permission are treated as admin-only
    // (safe default) — the admin wildcard '*' passes hasPermission on
    // anything, so admins still see them.
    if (perms.length === 0) return hasPermission('*');
    return perms.some((p) => hasPermission(p));
  };

  const visibleGroups = groups
    .map((g) => ({ ...g, items: g.items.filter(allowed) }))
    .filter((g) => g.items.length > 0);

  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  const navigate = useNavigate();
  const { data: alertCounts } = useQuery({
    queryKey: ['alerts-counts'],
    queryFn: alertsApi.counts,
    refetchInterval: 30_000,
  });
  const unread = alertCounts?.unread ?? 0;
  const critical = alertCounts?.critical ?? 0;

  // Make sure no stale 'dark' class leftover from the removed toggle lingers on <html>.
  useEffect(() => {
    document.documentElement.classList.remove('dark');
    try { localStorage.removeItem('theme'); } catch {}
  }, []);

  return (
    <>
      {/* Backdrop (mobile only) */}
      <div
        className={clsx(
          'fixed inset-0 z-40 bg-slate-900/50 lg:hidden transition-opacity',
          mobileOpen
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none',
        )}
        onClick={closeMobile}
      />

      <aside
        className={clsx(
          'bg-white border-l border-slate-200 h-screen flex flex-col transition-all duration-200',
          // Mobile: fixed drawer that slides in/out
          'fixed top-0 right-0 w-64 max-w-[80vw] z-50',
          mobileOpen ? 'translate-x-0' : 'translate-x-full',
          // Desktop: in-flow sticky column, no transform, always visible
          'lg:sticky lg:top-0 lg:z-auto lg:translate-x-0',
          collapsed ? 'lg:w-16' : 'lg:w-64',
        )}
      >
        <div
          className={clsx(
            'p-4 border-b border-slate-100 flex flex-col gap-2',
            collapsed && 'lg:p-3',
          )}
        >
          <div className={clsx('flex items-center gap-3', collapsed && 'lg:justify-center')}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center text-white font-black text-xl shadow-glow shrink-0">
              ز
            </div>
            {(!collapsed || mobileOpen) && (
              <div className="lg:block">
                <div className="font-black text-slate-800">زهران</div>
                <div className="text-xs text-slate-500">v1.0 · POS</div>
              </div>
            )}
            {/* Close button (mobile only) */}
            <button
              onClick={closeMobile}
              className="mr-auto p-1 rounded hover:bg-slate-100 lg:hidden"
              aria-label="إغلاق"
            >
              <XIcon size={18} />
            </button>
          </div>

          {/* Connection · notifications · theme toggle — under the brand */}
          <div className={clsx('flex items-center gap-1', collapsed && !mobileOpen && 'lg:flex-col')}>
            <div
              title={online ? 'متصل' : 'غير متصل'}
              className={clsx(
                'flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold flex-1',
                online
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-rose-50 text-rose-700',
                collapsed && !mobileOpen && 'lg:justify-center lg:flex-none lg:w-full',
              )}
            >
              {online ? <Wifi size={12} /> : <WifiOff size={12} />}
              <span className={clsx(collapsed && !mobileOpen && 'lg:hidden')}>
                {online ? 'متصل' : 'غير متصل'}
              </span>
            </div>
            <button
              onClick={() => {
                navigate('/alerts');
                closeMobile();
              }}
              title="التنبيهات"
              className="relative flex items-center justify-center rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 w-8 h-7"
            >
              <Bell size={14} />
              {unread > 0 && (
                <span
                  className={clsx(
                    'absolute -top-1 -right-1 min-w-[15px] h-[15px] rounded-full text-[9px] font-bold text-white flex items-center justify-center px-1',
                    critical > 0 ? 'bg-rose-500' : 'bg-amber-500',
                  )}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-3 overflow-y-auto">
          {visibleGroups.map((group) => (
            <div key={group.title}>
              {(!collapsed || mobileOpen) && (
                <div className="px-3 pt-2 pb-1 text-[11px] font-black tracking-wide text-slate-400 uppercase lg:text-[11px]">
                  {group.title}
                </div>
              )}
              {collapsed && !mobileOpen && (
                <div className="mx-2 my-2 border-t border-slate-200 lg:block hidden" />
              )}
              <div className="space-y-0.5">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === '/'}
                    onClick={closeMobile}
                    title={collapsed ? label : undefined}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center gap-3 rounded-lg font-semibold transition',
                        collapsed && !mobileOpen
                          ? 'lg:justify-center lg:px-2 lg:py-2.5 px-3 py-2.5'
                          : 'px-3 py-2.5',
                        isActive
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-600 hover:bg-slate-50',
                      )
                    }
                  >
                    <Icon size={20} className="shrink-0" />
                    <span
                      className={clsx(
                        'truncate',
                        collapsed && !mobileOpen && 'lg:hidden',
                      )}
                    >
                      {label}
                    </span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User + logout + collapse toggle */}
        <div className="p-2 border-t border-slate-100 space-y-1">
          {(!collapsed || mobileOpen) && (
            <div className="px-3 py-1 text-sm">
              <div className="font-semibold text-slate-800 truncate">
                {user?.full_name || user?.username}
              </div>
              <div className="text-xs text-slate-500 truncate">
                {user?.role_name || user?.role}
              </div>
            </div>
          )}
          <button
            onClick={logout}
            title={collapsed ? 'تسجيل الخروج' : undefined}
            className={clsx(
              'w-full flex items-center gap-3 rounded-lg text-slate-600 hover:bg-rose-50 hover:text-rose-600 transition px-3 py-2',
              collapsed && !mobileOpen && 'lg:justify-center',
            )}
          >
            <LogOut size={18} className="shrink-0" />
            <span
              className={clsx(
                'font-semibold',
                collapsed && !mobileOpen && 'lg:hidden',
              )}
            >
              تسجيل الخروج
            </span>
          </button>

          {/* Desktop-only collapse toggle */}
          <button
            onClick={toggleCollapsed}
            className={clsx(
              'w-full hidden lg:flex items-center gap-3 rounded-lg text-slate-500 hover:bg-slate-100 transition px-3 py-2 text-xs',
              collapsed && 'lg:justify-center',
            )}
            title={collapsed ? 'توسيع الشريط' : 'تصغير الشريط'}
          >
            {collapsed ? (
              <ChevronsLeft size={16} />
            ) : (
              <>
                <ChevronsRight size={16} />
                <span>تصغير</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </>
  );
}
