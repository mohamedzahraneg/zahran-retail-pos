import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ANY_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
} from '../decorators/roles.decorator';

/**
 * Grants access when the user satisfies the route's permission contract.
 *
 *   • `@Permissions(...)`     → every code must be present (AND).
 *   • `@AnyPermissions(...)`  → at least one code must be present (OR).
 *
 * If both metadata entries are visible to the resolver, `AnyPermissions`
 * is honoured — the typical use case is a class-level
 * `@Permissions('reports.view')` that a method-level
 * `@AnyPermissions('reports.view', 'shifts.view')` widens for a single
 * cross-feature endpoint.
 *
 * "*" in the user's set is a wildcard that passes any check;
 * "area.*" matches any permission in that area.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const anyRequired = this.reflector.getAllAndOverride<string[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (
      (!required || required.length === 0) &&
      (!anyRequired || anyRequired.length === 0)
    ) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    const userPerms: string[] = Array.isArray(user?.permissions)
      ? user.permissions
      : [];

    const has = (code: string) => {
      if (userPerms.includes('*')) return true;
      if (userPerms.includes(code)) return true;
      // area wildcard: "pos.*" satisfies "pos.sell"
      const area = code.split('.')[0];
      if (userPerms.includes(`${area}.*`)) return true;
      return false;
    };

    if (anyRequired && anyRequired.length > 0) {
      if (!anyRequired.some(has)) {
        throw new ForbiddenException(
          `صلاحيات ناقصة: واحدة من (${anyRequired.join(', ')})`,
        );
      }
      return true;
    }

    const missing = (required ?? []).filter((p) => !has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `صلاحيات ناقصة: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
