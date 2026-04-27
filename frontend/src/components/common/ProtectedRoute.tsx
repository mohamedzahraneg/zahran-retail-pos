import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Route gate. Unauthenticated users go to /login; authenticated users who
 * don't satisfy the required check go to "/".
 *
 * Two permission props (mutually exclusive in practice):
 *   • `permissions`     — user must hold ALL listed codes (every).
 *   • `anyPermission`   — user must hold AT LEAST ONE listed code (some).
 *
 * Use `anyPermission` for surfaces that cross feature boundaries (e.g.
 * the shift-reports page is reachable by anyone with `reports.view` OR
 * `shifts.view`). Roles still work as a fallback when neither
 * permission prop is supplied.
 */
export function ProtectedRoute({
  children,
  roles,
  permissions,
  anyPermission,
}: {
  children: ReactNode;
  roles?: string[];
  permissions?: string[];
  anyPermission?: string[];
}) {
  const { accessToken, hasRole, hasPermission } = useAuthStore();
  const location = useLocation();

  if (!accessToken) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (anyPermission && anyPermission.length > 0) {
    const ok = anyPermission.some((p) => hasPermission(p));
    if (!ok) return <Navigate to="/" replace />;
    return <>{children}</>;
  }

  if (permissions && permissions.length > 0) {
    if (!hasPermission(...permissions)) {
      return <Navigate to="/" replace />;
    }
    return <>{children}</>;
  }

  if (roles && roles.length > 0) {
    if (!hasRole(...roles)) {
      return <Navigate to="/" replace />;
    }
    return <>{children}</>;
  }

  return <>{children}</>;
}
