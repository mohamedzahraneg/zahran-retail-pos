import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import Dashboard from '@/pages/Dashboard';

/**
 * Index ('/') dispatcher.
 *
 * The same URL is the landing page for everyone, but different roles see
 * different homes:
 *
 *   1. Admin / manager / owner with `dashboard.view` → the company-wide
 *      operational Dashboard (sales, expenses, alerts, …).
 *   2. Plain employee with only `employee.dashboard.view` → their own
 *      personal self-service portal at /me. They never see the admin
 *      dashboard, so the back-end 403s on /api/dashboard/* never paint
 *      a half-broken page.
 *   3. No relevant permission at all → /me as a soft fallback (the
 *      ProtectedRoute on /me will then 403 / bounce them to /login if
 *      they really have nothing).
 *
 * Frontend redirection here is a UX nicety — every backend endpoint
 * the dashboards call already enforces its own permission via
 * @Permissions(...). So even a user who hand-types '/' and lands on
 * the admin dashboard cannot read company data they aren't entitled
 * to: the API requests just return 403.
 */
export default function IndexRoute() {
  const hasPermission = useAuthStore((s) => s.hasPermission);

  if (hasPermission('dashboard.view')) {
    return <Dashboard />;
  }

  if (hasPermission('employee.dashboard.view')) {
    return <Navigate to="/me" replace />;
  }

  // Soft fallback — if the user has neither, /me's ProtectedRoute
  // takes over and routes them sensibly (403 → / loop is broken
  // because hasPermission returns false above too, so Navigate to
  // /me triggers ProtectedRoute → /login).
  return <Navigate to="/me" replace />;
}
