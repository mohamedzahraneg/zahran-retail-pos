import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from '@/components/common/ProtectedRoute';

import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import POS from '@/pages/POS';
import Products from '@/pages/Products';
import ProductGroups from '@/pages/ProductGroups';
import Customers from '@/pages/Customers';
import Reservations from '@/pages/Reservations';
import Returns from '@/pages/Returns';
import ReturnsAnalytics from '@/pages/ReturnsAnalytics';
import CashDesk from '@/pages/CashDesk';
import Suppliers from '@/pages/Suppliers';
import SupplierDetail from '@/pages/SupplierDetail';
import Purchases from '@/pages/Purchases';
import PurchaseReturns from '@/pages/PurchaseReturns';
import StockAdjustments from '@/pages/StockAdjustments';
import BarcodeLabels from '@/pages/BarcodeLabels';
import Invoices from '@/pages/Invoices';
import Notifications from '@/pages/Notifications';
import Commissions from '@/pages/Commissions';
import AuditLog from '@/pages/AuditLog';
import Reports from '@/pages/Reports';
import Import from '@/pages/Import';
import Shifts from '@/pages/Shifts';
import ShiftReports from '@/pages/ShiftReports';
import StockTransfers from '@/pages/StockTransfers';
import StockCount from '@/pages/StockCount';
// PR-FIX-INVENTORY-UI-SHELL — new read-only inventory section.
// Lives alongside the legacy /products, /stock-* routes; nothing is
// removed or repurposed. Routes: /inventory (dashboard),
// /inventory/balances, /inventory/movements, /products/:id (360°
// view), /products/:id/matrix (variant matrix tab).
import InventoryDashboard from '@/pages/InventoryDashboard';
import InventoryBalances from '@/pages/InventoryBalances';
import InventoryMovements from '@/pages/InventoryMovements';
import InventoryReports from '@/pages/InventoryReports';
import Product360 from '@/pages/Product360';
// PR-BRANCHES-WAREHOUSES-FOUNDATION — new admin surface that lets
// operators curate branches (organisational units) and link them
// to existing warehouses. No stock / financial side effects.
import BranchesWarehouses from '@/pages/BranchesWarehouses';
import Coupons from '@/pages/Coupons';
import Alerts from '@/pages/Alerts';
import Accounts from '@/pages/Accounts';
import Cashboxes from '@/pages/Cashboxes';
import BankReconciliation from '@/pages/BankReconciliation';
import Analytics from '@/pages/Analytics';
import Budgets from '@/pages/Budgets';
import FinancialControls from '@/pages/FinancialControls';
import OpeningBalance from '@/pages/OpeningBalance';
import RecurringExpenses from '@/pages/RecurringExpenses';
import DailyExpenses from '@/pages/DailyExpenses';
// PR-FE-A — read-only Operational Expense Allocation surface
// (list + detail + 2 reports).  Write paths land in FE-B/FE-C.
import ExpenseAllocations from '@/pages/ExpenseAllocations';
import ExpenseAllocationDetail from '@/pages/ExpenseAllocationDetail';
import ProfitWithOverheadReport from '@/pages/ProfitWithOverheadReport';
import ExpensesUnallocatedReport from '@/pages/ExpensesUnallocatedReport';
import FinancialControlTower from '@/pages/FinancialControlTower';
import FinanceDashboard from '@/pages/FinanceDashboard';
import FinanceStatements from '@/pages/FinanceStatements';
import Zakat from '@/pages/Zakat';
import FinancialReports from '@/pages/FinancialReports';
import PricingReports from '@/pages/PricingReports';
import FinancialMovements from '@/pages/FinancialMovements';
import CustomerGroups from '@/pages/CustomerGroups';
import Settings from '@/pages/Settings';
import PaymentAccounts from '@/pages/PaymentAccounts';
import Users from '@/pages/Users';
import UserAccess from '@/pages/UserAccess';
import Loyalty from '@/pages/Loyalty';
// PR-ESS-2A — /me now renders the simplified self-service personal
// employee file. The legacy EmployeeProfile component still exports
// PayWageModal which is consumed by AccountsMovementsTab (admin
// flow), so the file stays — only the /me route binding moved.
import MyProfile from '@/pages/MyProfile';
import Team from '@/pages/Team';
import SetupWizard from '@/pages/SetupWizard';
import NotFound from '@/pages/NotFound';

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupWizard />} />
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout title="" />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="pos" element={<POS />} />
        <Route path="products" element={<Products />} />
        <Route path="product-groups" element={<ProductGroups />} />
        <Route path="customers" element={<Customers />} />
        <Route
          path="customer-groups"
          element={
            <ProtectedRoute permissions={['customer_groups.manage']}>
              <CustomerGroups />
            </ProtectedRoute>
          }
        />
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="suppliers/:id" element={<SupplierDetail />} />
        <Route path="purchases" element={<Purchases />} />
        <Route
          path="purchases/returns"
          element={
            <ProtectedRoute permissions={['purchases.view']}>
              <PurchaseReturns />
            </ProtectedRoute>
          }
        />
        <Route path="stock-adjustments" element={<StockAdjustments />} />
        <Route path="barcode-labels" element={<BarcodeLabels />} />
        <Route path="invoices" element={<Invoices />} />
        <Route
          path="notifications"
          element={
            <ProtectedRoute permissions={['alerts.view']}>
              <Notifications />
            </ProtectedRoute>
          }
        />
        <Route
          path="commissions"
          element={
            <ProtectedRoute permissions={['commissions.view', 'accounting.view']}>
              <Commissions />
            </ProtectedRoute>
          }
        />
        <Route
          path="audit-log"
          element={
            <ProtectedRoute permissions={['audit.view']}>
              <AuditLog />
            </ProtectedRoute>
          }
        />
        <Route path="cash-desk" element={<CashDesk />} />
        <Route path="reservations" element={<Reservations />} />
        <Route path="returns" element={<Returns />} />
        <Route
          path="returns-analytics"
          element={
            <ProtectedRoute permissions={['returns.view', 'returns.analytics']}>
              <ReturnsAnalytics />
            </ProtectedRoute>
          }
        />
        <Route
          path="reports"
          element={
            <ProtectedRoute permissions={['reports.view']}>
              <Reports />
            </ProtectedRoute>
          }
        />
        {/* PR-PURCHASES-P3.4A — pricing/profitability reports. */}
        <Route
          path="pricing-reports"
          element={
            <ProtectedRoute permissions={['reports.view']}>
              <PricingReports />
            </ProtectedRoute>
          }
        />
        <Route
          path="import"
          element={
            <ProtectedRoute permissions={['import.run']}>
              <Import />
            </ProtectedRoute>
          }
        />
        <Route path="shifts" element={<Shifts />} />
        <Route
          path="shift-reports"
          element={
            <ProtectedRoute anyPermission={['reports.view', 'shifts.view']}>
              <ShiftReports />
            </ProtectedRoute>
          }
        />
        <Route path="stock-transfers" element={<StockTransfers />} />
        <Route path="stock-count" element={<StockCount />} />
        {/* PR-FIX-INVENTORY-UI-SHELL — read-only inventory section.
            All five routes gated by the same `products.view`
            permission the products page already uses, so the
            inventory team (and admins) inherit access automatically
            without a new permission slug. */}
        <Route
          path="inventory"
          element={
            <ProtectedRoute permissions={['products.view']}>
              <InventoryDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="inventory/balances"
          element={
            <ProtectedRoute permissions={['products.view']}>
              <InventoryBalances />
            </ProtectedRoute>
          }
        />
        <Route
          path="inventory/movements"
          element={
            <ProtectedRoute permissions={['products.view']}>
              <InventoryMovements />
            </ProtectedRoute>
          }
        />
        <Route
          path="products/:id"
          element={
            <ProtectedRoute permissions={['products.view']}>
              <Product360 />
            </ProtectedRoute>
          }
        />
        <Route
          path="products/:id/matrix"
          element={
            <ProtectedRoute permissions={['products.view']}>
              <Product360 />
            </ProtectedRoute>
          }
        />
        {/* PR-INVENTORY-REPORTS — dedicated inventory analytics page
            with branch-aware valuation / low-stock / dead-stock /
            profitability tabs. Replaces the earlier redirect to
            /reports. Same `products.view` gate the rest of the new
            inventory section uses. */}
        <Route
          path="inventory/reports"
          element={
            <ProtectedRoute permissions={['products.view']}>
              <InventoryReports />
            </ProtectedRoute>
          }
        />
        {/* PR-BRANCHES-WAREHOUSES-FOUNDATION — admin surface gated
            on `warehouses.view`. The new module's POST/PATCH paths
            additionally require `warehouses.manage`; the FE relies
            on the API for enforcement and shows the page to anyone
            who can already see the warehouses list. */}
        <Route
          path="branches"
          element={
            <ProtectedRoute permissions={['warehouses.view']}>
              <BranchesWarehouses />
            </ProtectedRoute>
          }
        />
        <Route path="coupons" element={<Coupons />} />
        <Route path="alerts" element={<Alerts />} />
        {/* Legacy /accounting redirects to the unified /accounts page.
            The older standalone Accounting.tsx page has been retired — any
            existing links now point at /accounts where the merged UI lives. */}
        <Route path="accounting" element={<Navigate to="/accounts" replace />} />
        <Route path="accounting-legacy" element={<Navigate to="/accounts" replace />} />
        <Route
          path="accounts"
          element={
            <ProtectedRoute permissions={['accounts.chart.view']}>
              <Accounts />
            </ProtectedRoute>
          }
        />
        <Route
          path="cashboxes"
          element={
            <ProtectedRoute permissions={['cashdesk.view']}>
              <Cashboxes />
            </ProtectedRoute>
          }
        />
        <Route
          path="bank-reconciliation"
          element={
            <ProtectedRoute permissions={['accounts.reconcile']}>
              <BankReconciliation />
            </ProtectedRoute>
          }
        />
        <Route
          path="analytics"
          element={
            <ProtectedRoute permissions={['accounts.chart.view']}>
              <Analytics />
            </ProtectedRoute>
          }
        />
        <Route
          path="budgets"
          element={
            <ProtectedRoute
              permissions={['accounts.budget', 'accounts.cost_centers']}
            >
              <Budgets />
            </ProtectedRoute>
          }
        />
        <Route
          path="financial-controls"
          element={
            <ProtectedRoute
              permissions={[
                'accounts.approval.decide',
                'accounts.approval.manage',
                'accounts.fx',
              ]}
            >
              <FinancialControls />
            </ProtectedRoute>
          }
        />
        {/* /accounts-audit was the destructive-maintenance page (force-post,
            dedupe, factory-reset). Retired — the repairs it triggered now
            run automatically on boot via database/migrations/056. Any old
            link lands on the regular /accounts page. */}
        <Route path="accounts-audit" element={<Navigate to="/accounts" replace />} />
        <Route
          path="opening-balance"
          element={
            <ProtectedRoute permissions={['accounts.journal.post']}>
              <OpeningBalance />
            </ProtectedRoute>
          }
        />
        <Route
          path="recurring-expenses"
          element={
            <ProtectedRoute permissions={['recurring_expenses.manage']}>
              <RecurringExpenses />
            </ProtectedRoute>
          }
        />
        <Route
          path="daily-expenses"
          element={
            <ProtectedRoute permissions={['expenses.daily.create']}>
              <DailyExpenses />
            </ProtectedRoute>
          }
        />
        {/* PR-FE-A — Operational Expense Allocation read-only surface.
            List + detail of allocation periods, plus the two reports
            (profit-with-overhead, unallocated-expenses). Gated by
            `expense_allocation.view`. Write paths (create/approve/
            reverse + line edits) land in FE-B/FE-C. */}
        <Route
          path="expense-allocations"
          element={
            <ProtectedRoute permissions={['expense_allocation.view']}>
              <ExpenseAllocations />
            </ProtectedRoute>
          }
        />
        <Route
          path="expense-allocations/:id"
          element={
            <ProtectedRoute permissions={['expense_allocation.view']}>
              <ExpenseAllocationDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="reports/profit-with-overhead"
          element={
            <ProtectedRoute permissions={['expense_allocation.view']}>
              <ProfitWithOverheadReport />
            </ProtectedRoute>
          }
        />
        <Route
          path="reports/unallocated-expenses"
          element={
            <ProtectedRoute permissions={['expense_allocation.view']}>
              <ExpensesUnallocatedReport />
            </ProtectedRoute>
          }
        />
        <Route
          path="dashboard/financial"
          element={
            <ProtectedRoute permissions={['dashboard.financial.view']}>
              <FinancialControlTower />
            </ProtectedRoute>
          }
        />
        {/* PR-FIN-2 — Financial Dashboard (read-only).
            Distinct from /dashboard/financial (Control Tower).
            Permission: finance.dashboard.view (admin gets it via the
            `*` wildcard). */}
        <Route
          path="dashboard/finance"
          element={
            <ProtectedRoute permissions={['finance.dashboard.view']}>
              <FinanceDashboard />
            </ProtectedRoute>
          }
        />
        {/* PR-FIN-3 — Advanced Account Statements (read-only).
            Permission: finance.statements.view (admin gets it via
            the `*` wildcard). Flips the sidebar placeholder for
            "كشف الحسابات" from disabled to active. */}
        <Route
          path="finance/statements"
          element={
            <ProtectedRoute permissions={['finance.statements.view']}>
              <FinanceStatements />
            </ProtectedRoute>
          }
        />
        {/* PR-FE-ACCOUNTING-ZAKAT-FRAMING — Zakat framing/planning page
            (read-only). No JE/CT writes, no engine calls, no migrations.
            Permission mirrors the sidebar entry (finance.dashboard.view —
            admin gets it via the `*` wildcard). Flips the sidebar
            placeholder for "الزكاة" from disabled to active. */}
        <Route
          path="finance/zakat"
          element={
            <ProtectedRoute permissions={['finance.dashboard.view']}>
              <Zakat />
            </ProtectedRoute>
          }
        />
        {/* PR-FE-ACCOUNTING-FINANCIAL-REPORTS-FRAMING — Financial
            Reports framing/planning page (read-only). No API calls,
            no JE/CT writes, no engine calls, no migrations.
            Permission mirrors the sidebar entry
            (finance.dashboard.view — admin gets it via the `*`
            wildcard). Flips the sidebar placeholder for "التقارير
            المالية" from disabled to active. */}
        <Route
          path="finance/reports"
          element={
            <ProtectedRoute permissions={['finance.dashboard.view']}>
              <FinancialReports />
            </ProtectedRoute>
          }
        />
        {/* PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING — Financial
            Movements tracking framing/planning page (read-only).
            No API calls, no JE/CT writes, no engine calls, no
            migrations, no reverse/void/approve actions. Permission
            mirrors the sidebar entry (finance.dashboard.view —
            admin gets it via the `*` wildcard). Flips the sidebar
            placeholder for "تتبع الحركات المالية" from disabled to
            active. */}
        <Route
          path="audit/financial-movements"
          element={
            <ProtectedRoute permissions={['finance.dashboard.view']}>
              <FinancialMovements />
            </ProtectedRoute>
          }
        />
        <Route
          path="loyalty"
          element={
            <ProtectedRoute permissions={['loyalty.view']}>
              <Loyalty />
            </ProtectedRoute>
          }
        />
        {/* /attendance — permanent redirect to the unified workspace's
            attendance section. PR-T6 cleanup deleted the legacy
            standalone Attendance page itself. */}
        <Route
          path="attendance"
          element={<Navigate to="/team?section=attendance" replace />}
        />
        <Route
          path="me"
          element={
            <ProtectedRoute permissions={['employee.dashboard.view']}>
              <MyProfile />
            </ProtectedRoute>
          }
        />
        <Route
          path="team"
          element={
            <ProtectedRoute permissions={['employee.team.view']}>
              <Team />
            </ProtectedRoute>
          }
        />
        {/* /payroll — permanent redirect to the unified workspace's
            accounts section. PR-T6 cleanup deleted the legacy
            standalone Payroll page itself. */}
        <Route
          path="payroll"
          element={<Navigate to="/team?section=accounts" replace />}
        />
        <Route path="settings" element={<Settings />} />
        {/* PR-FIN-PAYACCT-4D — `/payment-accounts` was the dedicated
            admin page shipped in PR-4B. The treasury work has since
            been unified under `/cashboxes`, so this route is now a
            redirect (the PaymentAccounts component renders <Navigate
            to="/cashboxes" replace />). The `payment-accounts.read`
            gate remains on the redirect target so users without it
            still bounce to the auth fallback rather than silently
            land on the unified page. */}
        <Route
          path="payment-accounts"
          element={
            <ProtectedRoute permissions={['payment-accounts.read']}>
              <PaymentAccounts />
            </ProtectedRoute>
          }
        />
        <Route
          path="users"
          element={
            <ProtectedRoute permissions={['users.view', 'users.manage']}>
              <Users />
            </ProtectedRoute>
          }
        />
        {/* PR-USER-BRANCH-WAREHOUSE-ACCESS — per-user branch/warehouse
            access editor. Mounted as a child of /users so the legacy
            page is untouched. */}
        <Route
          path="users/:id/access"
          element={
            <ProtectedRoute permissions={['users.view', 'users.manage']}>
              <UserAccess />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<NotFound />} />
      <Route path="/404" element={<NotFound />} />
      <Route path="/home" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function ComingSoon({ name }: { name: string }) {
  return (
    <div className="card p-12 text-center">
      <div className="text-6xl mb-4">🚧</div>
      <h2 className="text-2xl font-black text-slate-800 mb-2">{name}</h2>
      <p className="text-slate-500">هذه الشاشة تحت التطوير</p>
    </div>
  );
}
