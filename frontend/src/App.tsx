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
import RecurringExpenses from '@/pages/RecurringExpenses';
import CustomerGroups from '@/pages/CustomerGroups';
import Settings from '@/pages/Settings';
import Users from '@/pages/Users';
import Loyalty from '@/pages/Loyalty';
import Attendance from '@/pages/Attendance';
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
            <AppLayout title="زهران — نظام البيع" />
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
            <ProtectedRoute roles={['admin', 'manager']}>
              <CustomerGroups />
            </ProtectedRoute>
          }
        />
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="purchases" element={<Purchases />} />
        <Route path="stock-adjustments" element={<StockAdjustments />} />
        <Route path="barcode-labels" element={<BarcodeLabels />} />
        <Route path="invoices" element={<Invoices />} />
        <Route
          path="notifications"
          element={
            <ProtectedRoute roles={['admin', 'manager']}>
              <Notifications />
            </ProtectedRoute>
          }
        />
        <Route path="commissions" element={<Commissions />} />
        <Route
          path="audit-log"
          element={
            <ProtectedRoute roles={['admin', 'manager']}>
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
            <ProtectedRoute roles={['admin', 'manager', 'accountant']}>
              <ReturnsAnalytics />
            </ProtectedRoute>
          }
        />
        <Route path="reports" element={<Reports />} />
        <Route path="import" element={<Import />} />
        <Route path="shifts" element={<Shifts />} />
        <Route path="stock-transfers" element={<StockTransfers />} />
        <Route path="stock-count" element={<StockCount />} />
        <Route path="coupons" element={<Coupons />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="accounting" element={<Accounting />} />
        <Route
          path="recurring-expenses"
          element={
            <ProtectedRoute roles={['admin', 'manager', 'accountant']}>
              <RecurringExpenses />
            </ProtectedRoute>
          }
        />
        <Route
          path="loyalty"
          element={
            <ProtectedRoute roles={['admin', 'manager', 'accountant']}>
              <Loyalty />
            </ProtectedRoute>
          }
        />
        <Route path="attendance" element={<Attendance />} />
        <Route path="settings" element={<Settings />} />
        <Route
          path="users"
          element={
            <ProtectedRoute roles={['admin', 'manager']}>
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
