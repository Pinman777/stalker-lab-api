import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import { getSeasonDto, getLeaderboardDto, journaledToday } from './seasons.service';
import type { AuthedRequest } from '../../common/authed-request';

/** Сезоны-рейды: текущий сезон + моя карточка; таблица охоты. Чтение. */
@Controller('api/v1/seasons')
@UseGuards(TmaAuthGuard)
export class SeasonsController {
  @Get('current')
  async current(@Req() req: AuthedRequest) {
    const dto = await getSeasonDto(req.user ? String(req.user.id) : null);
    return { ...dto, journaled_today: req.user ? await journaledToday(String(req.user.id)) : false };
  }

  @Get('leaderboard')
  async leaderboard(@Req() req: AuthedRequest) {
    return getLeaderboardDto(req.user ? String(req.user.id) : null);
  }
}
