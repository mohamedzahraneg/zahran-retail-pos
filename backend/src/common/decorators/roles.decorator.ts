import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** Public = bypass JWT auth guard (e.g., /health, /auth/login) */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Require one or more permission codes (e.g. "loyalty.adjust").
 * Checked by PermissionsGuard against the user's effective permission set
 * (role.permissions ∪ user.extra_permissions ∖ user.denied_permissions).
 * A user with the wildcard "*" passes every permission check.
 */
export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...perms: string[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);
