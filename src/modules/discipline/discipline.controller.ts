import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import { getDisciplineStats, type DisciplineStats } from './discipline.service';
import { db } from '../../db/db';
import type { AuthedRequest } from '../../common/authed-request';

/** GET /api/v1/me/stats — дисциплина пользователя из ledger (нед2: журнал — источник событий). */
@Controller()
@UseGuards(TmaAuthGuard)
export class DisciplineController {
  @Get('api/v1/me/stats')
  async stats(@Req() req: AuthedRequest): Promise<DisciplineStats> {
    return getDisciplineStats(db, req.user!.id);
  }
}
