import { NavLink } from 'react-router-dom';
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
  Calculator,
  Repeat,
  Users2,
  Settings,
  UserCog,
  LogOut,
  ChevronsRight,
  ChevronsLeft,
  X as XIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuthStore } from '@/stores/auth.store';
import { useLayoutStore } from '@/stores/layout.store';

const items = [
  { to: '/', label: 'لوحة التحكم', icon: LayoutDashboard, roles: ['admin', 'manager', 'accountant'] },
  { to: '/pos', label: 'نقطة البيع', icon: ShoppingCart, roles: ['admin', 'manager', 'cashier'] },
  { to: '/invoices', label: 'الفواتير', icon: ReceiptText, roles: ['admin', 'manager', 'accountant', 'cashier'] },
  { to: '/products', label: 'المنتجات', icon: Package, roles: ['admin', 'manager', 'inventory'] },
  { to: '/stock-adjustments', label: 'تعديلات المخزون', icon: PackagePlus, roles: ['admin', 'manager', 'inventory'] },
  { to: '/barcode-labels', label: 'طباعة الباركود', icon: BarcodeIcon, roles: ['admin', 'manager', 'inventory'] },
  { to: '/stock-transfers', label: 'تحويلات المخازن', icon: Shuffle, roles: ['admin', 'manager', 'inventory'] },
  { to: '/stock-count', label: 'الجرد الفعلي', icon: ClipboardCheck, roles: ['admin', 'manager', 'inventory'] },
  { to: '/purchases', label: 'فواتير المشتريات', icon: FileText, roles: ['admin', 'manager', 'accountant', 'stock_keeper'] },
  { to: '/customers', label: 'العملاء', icon: Users, roles: ['admin', 'manager', 'cashier'] },
  { to: '/customer-groups', label: 'مجموعات العملاء', icon: Users2, roles: ['admin', 'manager'] },
  { to: '/suppliers', label: 'الموردون', icon: Truck, roles: ['admin', 'manager', 'accountant'] },
  { to: '/cash-desk', label: 'الصندوق', icon: Wallet, roles: ['admin', 'manager', 'accountant'] },
  { to: '/accounting', label: 'الحسابات', icon: Calculator, roles: ['admin', 'manager', 'accountant'] },
  { to: '/recurring-expenses', label: 'المصاريف الدورية', icon: Repeat, roles: ['admin', 'manager', 'accountant'] },
  { to: '/commissions', label: 'عمولات المبيعات', icon: Percent, roles: ['admin', 'manager', 'accountant'] },
  { to: '/shifts', label: 'الورديات', icon: Clock, roles: ['admin', 'manager', 'cashier'] },
  { to: '/reservations', label: 'الحجوزات', icon: CalendarClock, roles: ['admin', 'manager', 'cashier'] },
  { to: '/returns', label: 'المرتجعات', icon: Undo2, roles: ['admin', 'manager', 'cashier'] },
  { to: '/returns-analytics', label: 'تحليلات المرتجعات', icon: TrendingDown, roles: ['admin', 'manager', 'accountant'] },
  { to: '/coupons', label: 'الكوبونات', icon: Ticket, roles: ['admin', 'manager'] },
  { to: '/alerts', label: 'التنبيهات', icon: Bell, roles: ['admin', 'manager', 'accountant'] },
  { to: '/reports', label: 'التقارير', icon: BarChart3, roles: ['admin', 'manager', 'accountant'] },
  { to: '/import', label: 'استيراد Excel', icon: FileUp, roles: ['admin', 'manager'] },
  { to: '/users', label: 'المستخدمون', icon: UserCog, roles: ['admin', 'manager'] },
  { to: '/audit-log', label: 'سجل التدقيق', icon: History, roles: ['admin', 'manager'] },
  { to: '/notifications', label: 'الإشعارات (واتساب)', icon: MessageCircle, roles: ['admin', 'manager'] },
  { to: '/settings', label: 'الإعدادات', icon: Settings, roles: ['admin'] },
];

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const role = user?.role || 'guest';
  const collapsed = useLayoutStore((s) => s.collapsed);
  const mobileOpen = useLayoutStore((s) => s.mobileOpen);
  const closeMobile = useLayoutStore((s) => s.closeMobile);
  const toggleCollapsed = useLayoutStore((s) => s.toggleCollapsed);

  const visibleItems = items.filter((it) => it.roles.includes(role));

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
          'bg-white border-l border-slate-200 h-screen flex flex-col transition-all duration-200 z-50',
          // Desktop: sticky, width changes
          'lg:sticky lg:top-0',
          collapsed ? 'lg:w-16' : 'lg:w-64',
          // Mobile: fixed drawer, hidden/shown
          'fixed top-0 right-0 w-64 max-w-[80vw]',
          mobileOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
        )}
      >
        <div
          className={clsx(
            'p-4 border-b border-slate-100 flex items-center gap-3',
            collapsed && 'lg:justify-center lg:p-3',
          )}
        >
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

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {visibleItems.map(({ to, label, icon: Icon }) => (
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
