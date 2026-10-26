import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { LoginCodesService } from './login-codes.service';
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
  constructor(
    private readonly identity: IdentityService,
    private readonly loginCodes: LoginCodesService,
  ) {}

  /** Вход: подписанный Telegram initData (+ inviteCode для нового юзера). */
  @Post('api/v1/auth/telegram')
  @HttpCode(200)
  async telegram(@Body() body: unknown, @Req() req: AuthedRequest) {
    const b = parseAuthBody(body);
    return this.identity.authenticate(b.initData, b.inviteCode, getIp(req));
  }

  /** Web-login (нед5): просить одноразовый код в личку бота (username | числовой tg-id). */
  @Post('api/v1/auth/code/request')
  @HttpCode(200)
  requestCode(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.loginCodes.request(parseUsername(body), getIp(req));
  }

  /** Web-login: код → JWT {tg, exp:24h} для Authorization: Bearer. */
  @Post('api/v1/auth/code/verify')
  @HttpCode(200)
  verifyCode(@Body() body: unknown, @Req() req: AuthedRequest) {
    const b = parseVerifyBody(body);
    return this.loginCodes.verify(b.username, b.code, getIp(req));
  }

  /** Кто я: initData в заголовке x-telegram-init-data ИЛИ Bearer-JWT на каждый запрос (stateless). */
  @Get('api/v1/me')
  @UseGuards(TmaAuthGuard)
  me(@Req() req: AuthedRequest) {
    if (!req.user) throw errors.unauthenticated();
    return { user: toUserDto(req.user) };
  }

  /** Нед5-фикс веб-входа: гашение инвайта ОТДЕЛЬНО от входа — юзер уже опознан
   *  гвардом (TMA initData ИЛИ Bearer из /auth/code/verify). Ответ как у /me. */
  @Post('api/v1/auth/invite/redeem')
  @HttpCode(200)
  @UseGuards(TmaAuthGuard)
  async redeemInvite(@Body() body: unknown, @Req() req: AuthedRequest) {
    if (!req.user) throw errors.unauthenticated();
    const user = await this.identity.redeemInvite(req.user, parseInviteBody(body), getIp(req));
    return { user };
  }
}

function parseAuthBody(body: unknown): AuthTelegramBody {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const b = body as Record<string, unknown>;
  if (typeof b.initData !== 'string' || b.initData.length === 0) throw errors.invalidRequest();
  if (b.inviteCode !== undefined && typeof b.inviteCode !== 'string') throw errors.invalidRequest();
  return { initData: b.initData, inviteCode: b.inviteCode };
}

function parseUsername(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const username = (body as Record<string, unknown>).username;
  if (typeof username !== 'string' || username.length === 0 || username.length > 64) {
    throw errors.invalidRequest();
  }
  return username;
}

function parseVerifyBody(body: unknown): { username: string; code: string } {
  const username = parseUsername(body);
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const code = (body as Record<string, unknown>).code;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw errors.invalidRequest();
  return { username, code };
}

function parseInviteBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const code = (body as Record<string, unknown>).code;
  if (typeof code !== 'string' || code.length === 0 || code.length > 64) throw errors.invalidRequest();
  return code;
}
