import { Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import type { AuthedRequest } from '../../common/authed-request';
import { ReferralsService, type ReferralsDto } from './referrals.service';

/** Рефералка (нед3): генерация своего инвайта + список приглашённых (только счётчики). */
@Controller('api/v1/referrals')
@UseGuards(TmaAuthGuard)
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  /** Сгенерировать свой инвайт-код: {code: 'r_xxxxxxxx'}. Лимит 3 активных → 409. */
  @Post('invite')
  @HttpCode(200)
  async invite(@Req() req: AuthedRequest): Promise<{ code: string }> {
    return { code: await this.referrals.generateInvite(req.user!.id) };
  }

  /** Моя постоянная ссылка: активный код (переиспользуется, генерится только если нет ни одного). Идемпотентно. */
  @Get('invite')
  async myInvite(@Req() req: AuthedRequest): Promise<{ code: string }> {
    return { code: await this.referrals.generateInvite(req.user!.id) };
  }

  /** Кого пригласил: {invited: [{username?, first_name?, joined_at, is_active_journal}], count}. */
  @Get()
  list(@Req() req: AuthedRequest): Promise<ReferralsDto> {
    return this.referrals.listReferrals(req.user!.id);
  }
}
