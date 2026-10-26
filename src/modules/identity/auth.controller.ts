import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { toUserDto } from './users.repository';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import { getIp } from '../../common/ip';
import { errors } from '../../common/errors';
import type { AuthedRequest } from '../../common/authed-request';

interface AuthTelegramBody {
  initData: string;
  inviteCode?: string;
}

@Controller()
export class AuthController {
  constructor(private readonly identity: IdentityService) {}

  /** Вход: подписанный Telegram initData (+ inviteCode для нового юзера). */
  @Post('api/v1/auth/telegram')
  @HttpCode(200)
  async telegram(@Body() body: unknown, @Req() req: AuthedRequest) {
    const b = parseAuthBody(body);
    return this.identity.authenticate(b.initData, b.inviteCode, getIp(req));
  }

  /** Кто я: initData в заголовке x-telegram-init-data на каждый запрос (stateless). */
  @Get('api/v1/me')
  @UseGuards(TmaAuthGuard)
  me(@Req() req: AuthedRequest) {
    if (!req.user) throw errors.unauthenticated();
    return { user: toUserDto(req.user) };
  }
}

function parseAuthBody(body: unknown): AuthTelegramBody {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const b = body as Record<string, unknown>;
  if (typeof b.initData !== 'string' || b.initData.length === 0) throw errors.invalidRequest();
  if (b.inviteCode !== undefined && typeof b.inviteCode !== 'string') throw errors.invalidRequest();
  return { initData: b.initData, inviteCode: b.inviteCode };
}
