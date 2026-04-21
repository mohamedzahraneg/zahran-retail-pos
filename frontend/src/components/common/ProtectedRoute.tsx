import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Route gate. Unauthenticated users go to /login; authenticated users who
 * don't satisfy every required check go to "/".
 *
 * Permissions are authoritative: if a permissions list is supplied the user
 * must hold at least one. Roles are treated the same way but no longer act
 * as a bypass for missing permissions — managers without the grant can't
 * sneak past via their role.
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
