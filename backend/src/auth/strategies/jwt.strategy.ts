import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { JwtUser } from '../../common/decorators/current-user.decorator';

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  permissions?: string[];
  branchId?: string;
  type: 'access' | 'refresh';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    cfg: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: cfg.get<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    const user = await this.users.findById(payload.sub);
    if (!user || !user.is_active) {
      throw new UnauthorizedException('User is inactive or deleted');
    }
    return {
      userId: user.id,
      username: user.username,
      role: user.role?.code || 'guest',
      permissions: user.role?.permissions || [],
      branchId: user.branch_id,
    };
  }
}
