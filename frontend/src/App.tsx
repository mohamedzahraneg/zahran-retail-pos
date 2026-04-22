import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from '@/components/common/ProtectedRoute';

import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import POS from '@/pages/POS';
import Products from '@/pages/Products';
import Customers from '@/pages/Customers';
import Reservations from '@/pages/Reservations';
import Returns from '@/pages/Returns';
import ReturnsAnalytics from '@/pages/ReturnsAnalytics';
import CashDesk from '@/pages/CashDesk';
import Suppliers from '@/pages/Suppliers';
import SupplierDetail from '@/pages/SupplierDetail';
import Purchases from '@/pages/Purchases';
import StockAdjustments from '@/pages/StockAdjustments';
import BarcodeLabels from '@/pages/BarcodeLabels';
import Invoices from '@/pages/Invoices';
import Notifications from '@/pages/Notifications';
import Commissions from '@/pages/Commissions';
import AuditLog from '@/pages/AuditLog';
import Reports from '@/pages/Reports';
import Import from '@/pages/Import';
import Shifts from '@/pages/Shifts';
import StockTransfers from '@/pages/StockTransfers';
import StockCount from '@/pages/StockCount';
import Coupons from '@/pages/Coupons';
import Alerts from '@/pages/Alerts';
import Accounting from '@/pages/Accounting';
import Accounts from '@/pages/Accounts';
import Cashboxes from '@/pages/Cashboxes';
import BankReconciliation from '@/pages/BankReconciliation';
import Analytics from '@/pages/Analytics';
import Budgets from '@/pages/Budgets';
import FinancialControls from '@/pages/FinancialControls';
import AccountsAudit from '@/pages/AccountsAudit';
import RecurringExpenses from '@/pages/RecurringExpenses';
import CustomerGroups from '@/pages/CustomerGroups';
import Settings from '@/pages/Settings';
import Users from '@/pages/Users';
import Loyalty from '@/pages/Loyalty';
import Attendance from '@/pages/Attendance';
import EmployeeProfile from '@/pages/EmployeeProfile';
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
        <Route
          path="import"
          element={
            <ProtectedRoute permissions={['import.run']}>
              <Import />
            </ProtectedRoute>
          }
        />
        <Route path="shifts" element={<Shifts />} />
        <Route path="stock-transfers" element={<StockTransfers />} />
        <Route path="stock-count" element={<StockCount />} />
        <Route path="coupons" element={<Coupons />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="accounting" element={<Accounting />} />
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
        <Route
          path="accounts-audit"
          element={
            <ProtectedRoute permissions={['accounts.chart.view']}>
              <AccountsAudit />
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
          path="loyalty"
          element={
            <ProtectedRoute permissions={['loyalty.view']}>
              <Loyalty />
            </ProtectedRoute>
          }
        />
        <Route path="attendance" element={<Attendance />} />
        <Route
          path="me"
          element={
            <ProtectedRoute permissions={['employee.dashboard.view']}>
              <EmployeeProfile />
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
        <Route path="settings" element={<Settings />} />
        <Route
          path="users"
          element={
            <ProtectedRoute permissions={['users.view', 'users.manage']}>
              <Users />
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
