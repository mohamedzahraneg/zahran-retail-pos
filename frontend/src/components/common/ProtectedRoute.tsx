import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Route gate. Unauthenticated users go to /login; authenticated users who
 * don't match the required roles or permissions go to "/".
 *
 * If both `roles` and `permissions` are provided, access is granted when
 * EITHER matches (OR semantics) — so callers can keep legacy role lists and
 * add a permission safely.
 */
export function ProtectedRoute({
  children,
  roles,
  permissions,
}: {
  children: ReactNode;
  roles?: string[];
  permissions?: string[];
}) {
  const { accessToken, hasRole, hasPermission } = useAuthStore();
  const location = useLocation();

  if (!accessToken) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  const roleOk = !roles || roles.length === 0 || hasRole(...roles);
  const permOk =
    !permissions || permissions.length === 0 || hasPermission(...permissions);

  // When BOTH are specified, either one grants access (OR). When only one is
  // specified, that one must pass.
  const pass =
    roles && permissions
      ? roleOk || permOk
      : roles
        ? roleOk
        : permissions
          ? permOk
          : true;

  if (!pass) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
