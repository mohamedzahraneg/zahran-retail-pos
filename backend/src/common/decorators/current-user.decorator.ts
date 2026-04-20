import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface JwtUser {
  userId: string;
  username: string;
  role: string;
  permissions?: string[];
  branchId?: string;
}

export const CurrentUser = createParamDecorator(
  (field: keyof JwtUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const user: JwtUser = req.user;
    return field ? user?.[field] : user;
  },
);
