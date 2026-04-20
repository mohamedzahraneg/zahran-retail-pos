import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService, RequestContext } from './auth.service';
import { LoginDto, RefreshTokenDto } from './dto/login.dto';
import { Public } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';

function ctxFrom(req: Request): RequestContext {
  // Prefer real client IP when behind a reverse proxy (X-Forwarded-For).
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(
    ',',
  )[0]?.trim();
  const raw = xff || req.ip || (req.socket as any)?.remoteAddress || '';
  // Strip IPv4-mapped IPv6 prefix.
  const ip = raw.replace(/^::ffff:/, '');
  return {
    ip: ip || null,
    userAgent: (req.headers['user-agent'] as string | undefined) || null,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.username, dto.password, ctxFrom(req));
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(200)
  logout(@CurrentUser() user: JwtUser, @Req() req: Request) {
    return this.auth.logout(user?.userId || null, ctxFrom(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: JwtUser) {
    return user;
  }
}
