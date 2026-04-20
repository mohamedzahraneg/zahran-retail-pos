import { ReactNode } from 'react';
import { useAuthStore } from '@/stores/auth.store';

interface CanProps {
  /** One or more permission codes. Shown only when the user has ALL of them. */
  permission?: string | string[];
  /** Alternative: one or more role codes (legacy). Either prop grants access. */
  role?: string | string[];
  /** Content to render when allowed. */
  children: ReactNode;
  /** Optional fallback content when blocked. Defaults to nothing. */
  fallback?: ReactNode;
}

/**
 * Visibility gate for UI elements. Hides the wrapped content unless the user
 * has the required permission (or role). Use this for buttons and admin-only
 * actions that should simply not appear for users who can't use them — rather
 * than showing them and erroring on click.
 */
export function Can({ permission, role, children, fallback = null }: CanProps) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const hasRole = useAuthStore((s) => s.hasRole);

  const perms =
    permission === undefined
      ? []
      : Array.isArray(permission)
        ? permission
        : [permission];
  const roles =
    role === undefined ? [] : Array.isArray(role) ? role : [role];

  const permOk = perms.length > 0 && hasPermission(...perms);
  const roleOk = roles.length > 0 && hasRole(...roles);

  if (perms.length === 0 && roles.length === 0) return <>{children}</>;
  return permOk || roleOk ? <>{children}</> : <>{fallback}</>;
}
