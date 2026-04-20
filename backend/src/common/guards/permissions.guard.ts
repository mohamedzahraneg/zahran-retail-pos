import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/roles.decorator';

/**
 * Grants access when every required permission is present in the user's
 * effective permission list. "*" in the user's set is a wildcard that passes
 * any check; "area.*" matches any permission in that area.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

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

    const missing = required.filter((p) => !has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `صلاحيات ناقصة: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
