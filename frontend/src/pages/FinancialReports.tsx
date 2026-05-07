/**
 * FinancialReports — central reporting hub
 * ────────────────────────────────────────────────────────────────────
 *
 * History:
 *   · PR-FE-ACCOUNTING-FINANCIAL-REPORTS-FRAMING (#326) introduced
 *     this page as a framing/planning shell with placeholder KPI
 *     cards and a "قريبًا" CTA strip.
 *   · PR-FE-ACCOUNTING-FINANCIAL-REPORTS-HUB (this PR) converts the
 *     page into a real catalog of every read-only report available
 *     across the system, grouped into nine functional sections with
 *     a search-and-filter bar.
 *
 * Strict guarantees (preserved from the framing PR):
 *   · ZERO writes — no JE, no CT, no migrations, no engine touches
 *   · ZERO API calls — page imports zero @/api clients (the catalog
 *     is a static metadata table; reports themselves live on their
 *     existing pages and the user navigates there)
 *   · ZERO formula changes — no calculations performed
 *   · ZERO fake numbers — the page never surfaces an aggregate
 *     amount; only report names, descriptions, statuses, and links
 *   · No mutation surface — every action is either a read-only
 *     `<Link>` to an existing route or a disabled `<button>`
 *
 * Status taxonomy:
 *   · 'ready'      — جاهز: a real FE page renders this report today
 *   · 'read_only'  — قراءة فقط: data exists but the destination is a
 *                     general page (operator drills into the right
 *                     view manually)
 *   · 'planned'    — مخطط: future PR; no destination yet
 *   · 'needs_data' — يحتاج بيانات: requires upstream classification
 *                     or setup before it can render meaningfully
 *
 * Permission gate (handled at the route level): finance.dashboard.view
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  Banknote,
  BookOpen,
  Box,
  Briefcase,
  Calculator,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Coins,
  CreditCard,
  Database,
  FileSpreadsheet,
  FileText,
  HandCoins,
  History,
  Layers,
  PieChart,
  Receipt,
  Repeat,
  Scale,
  Search,
  ShieldAlert,
  ShoppingCart,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  Wallet,
  X,
} from 'lucide-react';

type ReportStatus = 'ready' | 'read_only' | 'planned' | 'needs_data';

type ReportCategory =
  | 'accounting'
  | 'sales'
  | 'purchases'
  | 'inventory'
  | 'cash_payments'
  | 'customers_receivables'
  | 'suppliers_payables'
  | 'expenses'
  | 'payroll_employees'
  | 'operations_audit';

interface ReportSpec {
  key: string;
  name: string;
  description: string;
  category: ReportCategory;
  status: ReportStatus;
  /** Destination route. `null` for non-ready reports. */
  href: string | null;
  /** Lightweight icon hint. */
  icon: typeof FileText;
}

interface CategorySpec {
  key: ReportCategory;
  label: string;
  icon: typeof FileText;
  hint: string;
}

const CATEGORIES: CategorySpec[] = [
  {
    key: 'accounting',
    label: 'القوائم المحاسبية',
    icon: BookOpen,
    hint: 'القوائم المالية الأساسية ودفاتر الحسابات',
  },
  {
    key: 'sales',
    label: 'تقارير المبيعات',
    icon: TrendingUp,
    hint: 'مبيعات الفترة، المرتجعات، الخصومات، الضرائب',
  },
  {
    key: 'purchases',
    label: 'تقارير المشتريات',
    icon: Truck,
    hint: 'مشتريات الفترة، المرتجعات، أرصدة الموردين',
  },
  {
    key: 'inventory',
    label: 'تقارير المخزون',
    icon: Layers,
    hint: 'الأرصدة، الحركات، التقييم، الجرد، التسويات',
  },
  {
    key: 'cash_payments',
    label: 'تقارير الخزائن والمدفوعات',
    icon: Wallet,
    hint: 'حركات الخزائن، طرق الدفع، التسويات البنكية',
  },
  {
    key: 'customers_receivables',
    label: 'تقارير العملاء والذمم المدينة',
    icon: Users,
    hint: 'أرصدة العملاء، كشوف الحساب، الذمم المدينة',
  },
  {
    key: 'suppliers_payables',
    label: 'تقارير الموردين والذمم الدائنة',
    icon: Briefcase,
    hint: 'أرصدة الموردين، كشوف الحساب، الذمم الدائنة',
  },
  {
    key: 'expenses',
    label: 'تقارير المصروفات',
    icon: Receipt,
    hint: 'المصروفات اليومية والدورية وتصنيفاتها',
  },
  {
    key: 'payroll_employees',
    label: 'تقارير الموظفين والرواتب',
    icon: Users,
    hint: 'الرواتب، الحضور، حركات الموظفين',
  },
  {
    key: 'operations_audit',
    label: 'تقارير الرقابة والتدقيق',
    icon: ShieldAlert,
    hint: 'تتبع الحركات، سجل التدقيق، الاستثناءات',
  },
];

const REPORTS: ReportSpec[] = [
  // ── 1) القوائم المحاسبية ──────────────────────────────────────────
  { key: 'trial-balance', name: 'ميزان المراجعة', description: 'إجمالي المدين والدائن مع رصيد كل حساب',
    category: 'accounting', status: 'ready', href: '/accounts', icon: Scale },
  { key: 'income-statement', name: 'قائمة الدخل', description: 'الإيرادات والمصروفات وصافي الربح للفترة',
    category: 'accounting', status: 'ready', href: '/accounts', icon: TrendingUp },
  { key: 'balance-sheet', name: 'الميزانية العمومية', description: 'الأصول والخصوم وحقوق الملكية في تاريخ',
    category: 'accounting', status: 'ready', href: '/accounts', icon: Layers },
  { key: 'cash-flow', name: 'التدفقات النقدية', description: 'حركة النقد التشغيلية والاستثمارية والتمويلية',
    category: 'accounting', status: 'ready', href: '/dashboard/finance', icon: Coins },
  { key: 'general-ledger', name: 'تقرير الأستاذ العام', description: 'حركات الحسابات على مستوى القيد والبند',
    category: 'accounting', status: 'ready', href: '/accounts', icon: BookOpen },
  { key: 'account-statements', name: 'كشف الحسابات', description: 'كشف تفصيلي لكل كيان مالي مع رصيد افتتاحي وختامي',
    category: 'accounting', status: 'ready', href: '/finance/statements', icon: FileText },
  { key: 'journal-entries', name: 'تقرير قيود اليومية', description: 'استعراض قيود اليومية مع التصفية والبحث',
    category: 'accounting', status: 'ready', href: '/accounts', icon: ClipboardList },
  { key: 'cashbox-treasury', name: 'تقرير الخزائن', description: 'حركات الخزائن والأرصدة وتسويات النقدية',
    category: 'accounting', status: 'ready', href: '/cashboxes', icon: Wallet },
  { key: 'banks-wallets', name: 'تقرير البنوك والمحافظ', description: 'الحسابات البنكية والمحافظ الإلكترونية وأرصدتها',
    category: 'accounting', status: 'ready', href: '/cashboxes', icon: Banknote },
  { key: 'zakat-tax', name: 'تقرير الزكاة والضريبة', description: 'جاهزية مصادر الوعاء الزكوي وحالة الربط',
    category: 'accounting', status: 'read_only', href: '/finance/zakat', icon: HandCoins },

  // ── 2) تقارير المبيعات ────────────────────────────────────────────
  { key: 'sales-summary', name: 'ملخص المبيعات', description: 'الإجماليات اليومية والشهرية للمبيعات',
    category: 'sales', status: 'ready', href: '/reports', icon: TrendingUp },
  { key: 'sales-by-period', name: 'المبيعات حسب الفترة', description: 'مقارنة المبيعات بين فترات زمنية',
    category: 'sales', status: 'ready', href: '/reports', icon: Repeat },
  { key: 'sales-by-customer', name: 'المبيعات حسب العميل', description: 'إجمالي مبيعات كل عميل في الفترة',
    category: 'sales', status: 'ready', href: '/analytics', icon: Users },
  { key: 'sales-by-product', name: 'المبيعات حسب المنتج', description: 'أعلى المنتجات مبيعًا والربح لكل منتج',
    category: 'sales', status: 'ready', href: '/reports', icon: Box },
  { key: 'sales-by-category', name: 'المبيعات حسب الفئة', description: 'تجميع المبيعات حسب فئات المنتجات',
    category: 'sales', status: 'planned', href: null, icon: Layers },
  { key: 'sales-by-cashier', name: 'المبيعات حسب الكاشير', description: 'أداء كل كاشير في الفترة',
    category: 'sales', status: 'ready', href: '/reports', icon: Users },
  { key: 'invoices-report', name: 'تقرير الفواتير', description: 'استعراض كامل للفواتير مع البحث والتصفية',
    category: 'sales', status: 'ready', href: '/invoices', icon: FileText },
  { key: 'returns-report', name: 'تقرير المرتجعات', description: 'تحليلات تفصيلية للمرتجعات وأسبابها',
    category: 'sales', status: 'ready', href: '/returns-analytics', icon: Undo2 },
  { key: 'discounts-report', name: 'تقرير الخصومات', description: 'إجمالي الخصومات الممنوحة وتأثيرها على الإيراد',
    category: 'sales', status: 'read_only', href: '/analytics', icon: TrendingDown },
  { key: 'sales-vat', name: 'تقرير ضريبة المبيعات', description: 'ضريبة القيمة المضافة المحصلة على المبيعات',
    category: 'sales', status: 'needs_data', href: null, icon: PieChart },

  // ── 3) تقارير المشتريات ───────────────────────────────────────────
  { key: 'purchases-summary', name: 'ملخص المشتريات', description: 'إجماليات المشتريات اليومية والشهرية',
    category: 'purchases', status: 'ready', href: '/purchases', icon: ShoppingCart },
  { key: 'purchases-by-supplier', name: 'المشتريات حسب المورد', description: 'إجمالي المشتريات لكل مورد',
    category: 'purchases', status: 'ready', href: '/suppliers', icon: Truck },
  { key: 'purchases-by-product', name: 'المشتريات حسب المنتج', description: 'أعلى المنتجات شراءً وتكاليفها',
    category: 'purchases', status: 'read_only', href: '/purchases', icon: Box },
  { key: 'purchase-invoices', name: 'فواتير المشتريات', description: 'استعراض كامل لفواتير المشتريات',
    category: 'purchases', status: 'ready', href: '/purchases', icon: FileText },
  { key: 'purchase-returns', name: 'مرتجعات المشتريات', description: 'تتبع مرتجعات المشتريات وحالتها',
    category: 'purchases', status: 'ready', href: '/purchases', icon: Undo2 },
  { key: 'supplier-balances', name: 'أرصدة الموردين', description: 'الأرصدة الحالية والمستحقة لكل مورد',
    category: 'purchases', status: 'ready', href: '/suppliers', icon: Briefcase },
  { key: 'purchases-vat', name: 'تقرير ضريبة المشتريات', description: 'ضريبة القيمة المضافة على المشتريات',
    category: 'purchases', status: 'needs_data', href: null, icon: PieChart },

  // ── 4) تقارير المخزون ─────────────────────────────────────────────
  { key: 'stock-balances', name: 'أرصدة المخزون', description: 'الكميات الحالية لكل صنف ومخزن',
    category: 'inventory', status: 'ready', href: '/products', icon: Layers },
  { key: 'stock-movements', name: 'حركات المخزون', description: 'دخول وخروج الأصناف من المخازن',
    category: 'inventory', status: 'ready', href: '/stock-adjustments', icon: ArrowLeftRight },
  { key: 'product-ledger', name: 'كشف حركة الصنف', description: 'كشف تفصيلي بحركة الصنف عبر الفترة',
    category: 'inventory', status: 'read_only', href: '/products', icon: BookOpen },
  { key: 'low-stock', name: 'تقرير الأصناف المنخفضة', description: 'الأصناف التي بلغت أو تخطت حد إعادة الطلب',
    category: 'inventory', status: 'ready', href: '/reports', icon: AlertTriangle },
  { key: 'out-of-stock', name: 'تقرير نفاد المخزون', description: 'الأصناف بكمية صفر أو سلبية',
    category: 'inventory', status: 'ready', href: '/reports', icon: AlertTriangle },
  { key: 'stock-valuation', name: 'تقييم المخزون', description: 'القيمة الإجمالية للمخزون بالتكلفة',
    category: 'inventory', status: 'ready', href: '/reports', icon: Calculator },
  { key: 'stock-adjustments', name: 'تسويات المخزون', description: 'سجل تسويات الكميات وأسبابها',
    category: 'inventory', status: 'ready', href: '/stock-adjustments', icon: ClipboardCheck },
  { key: 'stock-counts', name: 'تقرير الجرد الفعلي', description: 'سجل عمليات الجرد ونتائجها',
    category: 'inventory', status: 'ready', href: '/stock-count', icon: ClipboardCheck },
  { key: 'stock-transfers', name: 'تحويلات المخازن', description: 'حركات نقل البضاعة بين المخازن',
    category: 'inventory', status: 'ready', href: '/stock-transfers', icon: ArrowLeftRight },

  // ── 5) تقارير الخزائن والمدفوعات ──────────────────────────────────
  { key: 'cashbox-transactions', name: 'حركات الخزائن', description: 'كل حركات الإيداع والسحب والتحويل',
    category: 'cash_payments', status: 'ready', href: '/cashboxes', icon: ArrowLeftRight },
  { key: 'payment-methods-summary', name: 'ملخص طرق الدفع', description: 'تجميع المبالغ حسب طريقة الدفع',
    category: 'cash_payments', status: 'ready', href: '/cash-desk', icon: CreditCard },
  { key: 'cash-totals', name: 'إجماليات النقدية', description: 'كاش / بطاقة / بنك / محفظة',
    category: 'cash_payments', status: 'ready', href: '/cash-desk', icon: Coins },
  { key: 'expenses-from-cashbox', name: 'مصروفات الخزينة', description: 'المصروفات المسحوبة من الخزائن',
    category: 'cash_payments', status: 'ready', href: '/daily-expenses', icon: Receipt },
  { key: 'bank-reconciliation', name: 'تسوية البنوك', description: 'مطابقة كشف البنك مع حركات النظام',
    category: 'cash_payments', status: 'planned', href: null, icon: Sparkles },
  { key: 'payment-account-report', name: 'تقرير حسابات الدفع', description: 'كشف الحسابات الإلكترونية وأرصدتها',
    category: 'cash_payments', status: 'ready', href: '/cashboxes', icon: Wallet },

  // ── 6) تقارير العملاء والذمم المدينة ──────────────────────────────
  { key: 'customer-balances', name: 'أرصدة العملاء', description: 'الأرصدة الحالية ومتأخرات الدفع لكل عميل',
    category: 'customers_receivables', status: 'ready', href: '/customers', icon: Users },
  { key: 'customer-statement', name: 'كشف حساب العميل', description: 'كشف تفصيلي بمعاملات العميل ورصيده',
    category: 'customers_receivables', status: 'ready', href: '/finance/statements', icon: FileText },
  { key: 'receivables-aging', name: 'أعمار الذمم المدينة', description: 'تصنيف الذمم حسب فترات التأخير',
    category: 'customers_receivables', status: 'needs_data', href: null, icon: ClipboardList },
  { key: 'customer-payments', name: 'مقبوضات العملاء', description: 'سجل الدفعات المستلمة من العملاء',
    category: 'customers_receivables', status: 'ready', href: '/cash-desk', icon: ArrowLeftRight },
  { key: 'top-customers', name: 'أعلى العملاء', description: 'العملاء الأعلى مبيعات وقيمة',
    category: 'customers_receivables', status: 'ready', href: '/analytics', icon: TrendingUp },
  { key: 'customer-debts', name: 'ديون العملاء', description: 'العملاء أصحاب الديون المستحقة',
    category: 'customers_receivables', status: 'ready', href: '/customers', icon: AlertTriangle },

  // ── 7) تقارير الموردين والذمم الدائنة ─────────────────────────────
  { key: 'supplier-balances-r', name: 'أرصدة الموردين', description: 'أرصدة وأعمار ديون الموردين',
    category: 'suppliers_payables', status: 'ready', href: '/suppliers', icon: Briefcase },
  { key: 'supplier-statement', name: 'كشف حساب المورد', description: 'كشف تفصيلي بمعاملات المورد ورصيده',
    category: 'suppliers_payables', status: 'ready', href: '/finance/statements', icon: FileText },
  { key: 'payables-aging', name: 'أعمار الذمم الدائنة', description: 'تصنيف الذمم الدائنة حسب فترات الاستحقاق',
    category: 'suppliers_payables', status: 'needs_data', href: null, icon: ClipboardList },
  { key: 'supplier-payments', name: 'مدفوعات الموردين', description: 'سجل الدفعات المسددة للموردين',
    category: 'suppliers_payables', status: 'ready', href: '/cash-desk', icon: ArrowLeftRight },
  { key: 'top-suppliers', name: 'أعلى الموردين', description: 'الموردون الأكثر مشتريات وقيمة',
    category: 'suppliers_payables', status: 'read_only', href: '/suppliers', icon: TrendingUp },
  { key: 'supplier-debts', name: 'ديون الموردين', description: 'الموردون أصحاب الديون المستحقة',
    category: 'suppliers_payables', status: 'ready', href: '/suppliers', icon: AlertTriangle },

  // ── 8) تقارير المصروفات ───────────────────────────────────────────
  { key: 'expenses-summary', name: 'ملخص المصروفات', description: 'إجماليات المصروفات اليومية والشهرية',
    category: 'expenses', status: 'ready', href: '/daily-expenses', icon: Receipt },
  { key: 'expenses-by-category', name: 'المصروفات حسب الفئة', description: 'تجميع المصروفات حسب التصنيف',
    category: 'expenses', status: 'ready', href: '/daily-expenses', icon: Layers },
  { key: 'expenses-by-period', name: 'المصروفات حسب الفترة', description: 'مقارنة المصروفات بين فترات زمنية',
    category: 'expenses', status: 'ready', href: '/analytics', icon: Repeat },
  { key: 'expenses-by-payment', name: 'المصروفات حسب طريقة الدفع', description: 'كاش / بنك / محفظة',
    category: 'expenses', status: 'read_only', href: '/daily-expenses', icon: CreditCard },
  { key: 'recurring-expenses-r', name: 'المصاريف الدورية', description: 'حالة المصروفات المتكررة وتنفيذها',
    category: 'expenses', status: 'ready', href: '/recurring-expenses', icon: Repeat },

  // ── 9) تقارير الموظفين والرواتب ───────────────────────────────────
  { key: 'salary-report', name: 'تقرير الرواتب', description: 'الرواتب الشهرية لكل موظف وحالاتها',
    category: 'payroll_employees', status: 'ready', href: '/team', icon: HandCoins },
  { key: 'employee-payments', name: 'تقرير دفعات الموظفين', description: 'سجل الدفعات المسددة للموظفين',
    category: 'payroll_employees', status: 'ready', href: '/team', icon: ArrowLeftRight },
  { key: 'attendance-payroll', name: 'الحضور المرتبط بالرواتب', description: 'ربط الحضور بحساب الراتب اليومي',
    category: 'payroll_employees', status: 'ready', href: '/team', icon: ClipboardCheck },
  { key: 'payroll-journal', name: 'دفتر يومية الرواتب', description: 'القيود المحاسبية الناتجة عن الرواتب',
    category: 'payroll_employees', status: 'read_only', href: '/team', icon: BookOpen },

  // ── 10) تقارير الرقابة والتدقيق ───────────────────────────────────
  { key: 'financial-movements', name: 'تتبع الحركات المالية', description: 'مسار الحركة من المصدر إلى القيد والخزينة والمخزون',
    category: 'operations_audit', status: 'read_only', href: '/audit/financial-movements', icon: History },
  { key: 'audit-log', name: 'سجل التدقيق', description: 'سجل العمليات والتغييرات التي قام بها المستخدمون',
    category: 'operations_audit', status: 'ready', href: '/audit-log', icon: FileText },
  { key: 'idempotency-events', name: 'أحداث منع التكرار', description: 'سجل عمليات منع التكرار في الواجهة الخلفية',
    category: 'operations_audit', status: 'planned', href: null, icon: ShieldAlert },
  { key: 'exceptions-report', name: 'تقرير الاستثناءات', description: 'حركات بدون قيد أو دون مطابقة كاش/مخزون',
    category: 'operations_audit', status: 'planned', href: null, icon: AlertTriangle },
  { key: 'missing-je', name: 'حركات بدون قيد محاسبي', description: 'فواتير ومرتجعات لم تُنشئ قيدًا محاسبيًا',
    category: 'operations_audit', status: 'planned', href: null, icon: AlertTriangle },
  { key: 'data-source-readiness', name: 'جاهزية مصادر البيانات', description: 'حالة ربط مصادر التقارير المالية',
    category: 'operations_audit', status: 'read_only', href: '/finance/zakat', icon: Database },
];

// ── Status presentation ────────────────────────────────────────────
const STATUS_PILL: Record<ReportStatus, { label: string; className: string }> = {
  ready: {
    label: 'جاهز',
    className: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  },
  read_only: {
    label: 'قراءة فقط',
    className: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  },
  planned: {
    label: 'مخطط',
    className: 'bg-amber-50 text-amber-700 border border-amber-200',
  },
  needs_data: {
    label: 'يحتاج بيانات',
    className: 'bg-rose-50 text-rose-700 border border-rose-200',
  },
};

const STATUS_OPTIONS: Array<{ value: '' | ReportStatus; label: string }> = [
  { value: '', label: 'كل الحالات' },
  { value: 'ready', label: 'جاهز' },
  { value: 'read_only', label: 'قراءة فقط' },
  { value: 'planned', label: 'مخطط' },
  { value: 'needs_data', label: 'يحتاج بيانات' },
];

export function FinancialReports() {
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'' | ReportCategory>('');
  const [statusFilter, setStatusFilter] = useState<'' | ReportStatus>('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return REPORTS.filter((r) => {
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (!q) return true;
      const hay = `${r.name} ${r.description}`.toLowerCase();
      return hay.includes(q);
    });
  }, [query, categoryFilter, statusFilter]);

  const grouped = useMemo(() => {
    const map = new Map<ReportCategory, ReportSpec[]>();
    for (const c of CATEGORIES) map.set(c.key, []);
    for (const r of filtered) {
      map.get(r.category)?.push(r);
    }
    return map;
  }, [filtered]);

  const totals = useMemo(() => {
    const counts: Record<ReportStatus, number> = {
      ready: 0,
      read_only: 0,
      planned: 0,
      needs_data: 0,
    };
    for (const r of REPORTS) counts[r.status]++;
    return counts;
  }, []);

  const hasResults = filtered.length > 0;

  function clearFilters() {
    setQuery('');
    setCategoryFilter('');
    setStatusFilter('');
  }

  const filtersActive =
    query !== '' || categoryFilter !== '' || statusFilter !== '';

  return (
    <div
      className="p-4 lg:p-6 space-y-5"
      dir="rtl"
      data-testid="financial-reports-page"
    >
      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="financial-reports-header"
      >
        <div className="order-1 flex items-start gap-3">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
            <PieChart size={24} />
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl lg:text-2xl font-black text-slate-900">
                التقارير المالية
              </h1>
              <span
                className="text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5"
                data-testid="financial-reports-hub-badge"
              >
                مركز التقارير
              </span>
              <span
                className="text-[10px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5"
                data-testid="financial-reports-stage-badge"
              >
                مرحلة التوطير
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              فهرس موحّد لكل التقارير القابلة للقراءة عبر النظام: محاسبة،
              مبيعات، مشتريات، مخزون، خزائن، عملاء، موردين، مصروفات، رواتب،
              ورقابة. ابحث عن التقرير الذي تحتاجه أو رشّح حسب القسم والحالة.
            </p>
          </div>
        </div>
      </header>

      {/* ── Framing notice ─────────────────────────────────────────── */}
      <div
        className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 flex items-start gap-3"
        data-testid="financial-reports-framing-notice"
      >
        <AlertTriangle
          size={18}
          className="text-amber-600 shrink-0 mt-0.5"
        />
        <div className="text-[12px] text-amber-900 leading-relaxed">
          هذه الصفحة للتأطير والمراجعة فقط. لا يتم إنشاء قيود أو اعتماد
          تقارير من هنا حاليًا. كل الروابط للقراءة فقط.
        </div>
      </div>

      {/* ── Status totals strip ────────────────────────────────────── */}
      <section
        className="grid grid-cols-2 lg:grid-cols-4 gap-3"
        data-testid="financial-reports-totals"
      >
        <TotalCard
          icon={CheckCircle2}
          tone="emerald"
          label="تقارير جاهزة"
          value={totals.ready}
          testid="financial-reports-total-ready"
        />
        <TotalCard
          icon={BookOpen}
          tone="indigo"
          label="قراءة فقط"
          value={totals.read_only}
          testid="financial-reports-total-read-only"
        />
        <TotalCard
          icon={Sparkles}
          tone="amber"
          label="مخطط"
          value={totals.planned}
          testid="financial-reports-total-planned"
        />
        <TotalCard
          icon={Database}
          tone="rose"
          label="يحتاج بيانات"
          value={totals.needs_data}
          testid="financial-reports-total-needs-data"
        />
      </section>

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div
        className="rounded-2xl border border-slate-200 bg-white p-3 flex flex-wrap items-center gap-3"
        data-testid="financial-reports-filter-bar"
      >
        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={14}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث باسم التقرير أو وصفه…"
            className="w-full bg-slate-50 border border-slate-200 rounded-lg pr-9 pl-3 py-2 text-[12px] text-slate-700 outline-none focus:bg-white focus:border-brand-300"
            data-testid="financial-reports-search-input"
            dir="rtl"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) =>
            setCategoryFilter(e.target.value as '' | ReportCategory)
          }
          className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[12px] text-slate-700 outline-none focus:bg-white focus:border-brand-300"
          data-testid="financial-reports-category-filter"
        >
          <option value="">كل الأقسام</option>
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as '' | ReportStatus)}
          className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[12px] text-slate-700 outline-none focus:bg-white focus:border-brand-300"
          data-testid="financial-reports-status-filter"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-100 text-slate-700 px-2.5 py-2 text-[11px] font-bold hover:bg-slate-200"
            data-testid="financial-reports-clear-filters"
          >
            <X size={12} /> مسح التصفية
          </button>
        )}
      </div>

      {/* ── Empty state ────────────────────────────────────────────── */}
      {!hasResults && (
        <div
          className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/40 p-8 text-center"
          data-testid="financial-reports-empty"
        >
          <Search size={28} className="mx-auto text-slate-400" />
          <div className="mt-2 text-sm font-bold text-slate-700">
            لا توجد تقارير مطابقة لمعايير البحث
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            جرّب تعديل النص أو إزالة التصفية
          </div>
        </div>
      )}

      {/* ── Sections ──────────────────────────────────────────────── */}
      {hasResults &&
        CATEGORIES.map((cat) => {
          const items = grouped.get(cat.key) ?? [];
          if (items.length === 0) return null;
          return (
            <CategorySection
              key={cat.key}
              spec={cat}
              items={items}
            />
          );
        })}
    </div>
  );
}

function TotalCard({
  icon: Icon,
  tone,
  label,
  value,
  testid,
}: {
  icon: typeof FileText;
  tone: 'emerald' | 'indigo' | 'amber' | 'rose';
  label: string;
  value: number;
  testid: string;
}) {
  const TONE: Record<typeof tone, string> = {
    emerald: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  };
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center gap-3"
      data-testid={testid}
    >
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center ${TONE[tone]}`}
      >
        <Icon size={18} />
      </div>
      <div>
        <div className="text-[11px] font-bold text-slate-500">{label}</div>
        <div className="text-xl font-black text-slate-900 tabular-nums">
          {value}
        </div>
      </div>
    </div>
  );
}

function CategorySection({
  spec,
  items,
}: {
  spec: CategorySpec;
  items: ReportSpec[];
}) {
  const Icon = spec.icon;
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid={`financial-reports-section-${spec.key}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-600 flex items-center justify-center">
          <Icon size={16} />
        </div>
        <h2 className="text-sm font-black text-slate-800">{spec.label}</h2>
        <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
          {items.length} تقرير
        </span>
        <span className="text-[10px] text-slate-400">— {spec.hint}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((r) => (
          <ReportCard key={r.key} report={r} />
        ))}
      </div>
    </section>
  );
}

function ReportCard({ report }: { report: ReportSpec }) {
  const Icon = report.icon;
  const pill = STATUS_PILL[report.status];
  const isActive = report.status === 'ready' || report.status === 'read_only';

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-600 flex items-center justify-center shrink-0">
          <Icon size={16} />
        </div>
        <span
          className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${pill.className}`}
          data-testid={`financial-reports-card-status-${report.key}`}
        >
          {pill.label}
        </span>
      </div>
      <div className="text-[12px] font-black text-slate-800 mb-1">
        {report.name}
      </div>
      <div className="text-[10px] text-slate-500 leading-snug">
        {report.description}
      </div>
      <div className="mt-3 flex items-center justify-end">
        {isActive && report.href ? (
          <span className="text-[10px] font-bold text-brand-700 hover:underline">
            استعراض التقرير ←
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400">
            متاح في تحديث لاحق
            <span className="rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5 leading-none text-[8px]">
              قريبًا
            </span>
          </span>
        )}
      </div>
    </>
  );

  if (isActive && report.href) {
    return (
      <Link
        to={report.href}
        className="block rounded-xl border border-slate-200 bg-white p-3 hover:border-brand-300 hover:shadow-sm transition"
        data-testid={`financial-reports-card-${report.key}`}
      >
        {inner}
      </Link>
    );
  }
  return (
    <div
      role="group"
      aria-disabled="true"
      title="متاح في تحديث لاحق"
      className="block rounded-xl border border-dashed border-slate-200 bg-slate-50/30 p-3 opacity-80 cursor-not-allowed"
      data-testid={`financial-reports-card-${report.key}`}
    >
      {inner}
    </div>
  );
}

export default FinancialReports;
