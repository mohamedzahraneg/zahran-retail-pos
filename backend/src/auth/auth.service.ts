import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { JwtPayload, mergePermissions } from './strategies/jwt.strategy';

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly cfg: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string, ctx: RequestContext = {}) {
    const user = await this.users.findByUsername(username);
    if (!user) {
      await this.audit.writeActivity({
        user_id: null,
        action: 'login',
        entity: 'user',
        summary: `فشل تسجيل الدخول — ${username} (مستخدم غير موجود)`,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        extra: { success: false, username },
      });
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.is_active) {
      await this.audit.writeActivity({
        user_id: user.id,
        action: 'login',
        entity: 'user',
        entity_id: user.id,
        summary: `فشل تسجيل الدخول — الحساب موقوف`,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        extra: { success: false, reason: 'deactivated' },
      });
      throw new ForbiddenException('Account is deactivated');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw new ForbiddenException(
        `Account locked until ${user.locked_until.toISOString()}`,
      );
    }
    const ok = await this.users.validatePassword(password, user.password_hash);
    if (!ok) {
      await this.users.recordFailedLogin(user.id);
      await this.audit.writeActivity({
        user_id: user.id,
        action: 'login',
        entity: 'user',
        entity_id: user.id,
        summary: `فشل تسجيل الدخول — كلمة مرور خاطئة`,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        extra: { success: false, reason: 'bad_password' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.users.recordLogin(user.id);
    await this.audit.writeActivity({
      user_id: user.id,
      action: 'login',
      entity: 'user',
      entity_id: user.id,
      summary: `تسجيل دخول — ${user.full_name || user.username}`,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      extra: { success: true },
    });

    const access_token = await this.signAccessToken(user);
    const refresh_token = await this.signRefreshToken(user);

    return {
      access_token,
      refresh_token,
      expires_in: this.cfg.get<string>('jwt.expiresIn'),
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        role: user.role?.code,
        role_name: user.role?.name_ar,
        permissions: mergePermissions(
          user.role?.permissions || [],
          (user as any).extra_permissions || [],
          (user as any).denied_permissions || [],
        ),
        branch_id: user.branch_id,
      },
    };
  }

  async logout(userId: string | null, ctx: RequestContext = {}) {
    if (!userId) return { ok: true };
    const user = await this.users.findById(userId).catch(() => null);
    await this.audit.writeActivity({
      user_id: userId,
      action: 'logout',
      entity: 'user',
      entity_id: userId,
      summary: `تسجيل خروج — ${user?.full_name || user?.username || 'مستخدم'}`,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: true };
  }

  async refresh(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Expected a refresh token');
    }
    const user = await this.users.findById(payload.sub);
    if (!user.is_active) {
      throw new ForbiddenException('Account is deactivated');
    }
    const access_token = await this.signAccessToken(user);
    return {
      access_token,
      expires_in: this.cfg.get<string>('jwt.expiresIn'),
    };
  }

  private async signAccessToken(user: any): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role?.code || 'guest',
      permissions: mergePermissions(
        user.role?.permissions || [],
        user.extra_permissions || [],
        user.denied_permissions || [],
      ),
      branchId: user.branch_id,
      type: 'access',
    };
    return this.jwt.signAsync(payload, {
      expiresIn: this.cfg.get<string>('jwt.expiresIn'),
    });
  }

  private async signRefreshToken(user: any): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role?.code || 'guest',
      type: 'refresh',
    };
    const days = this.cfg.get<number>('jwt.refreshDays') || 14;
    return this.jwt.signAsync(payload, { expiresIn: `${days}d` });
  }
}
