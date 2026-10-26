import { Controller, Get } from '@nestjs/common';
import { db } from '../../db/db';
import { errors } from '../../common/errors';

/** Health: процесс жив + БД отвечает (SELECT 1, нед2). БД лежит → 503 {error:'db_unavailable'}. */
@Controller()
export class HealthController {
  @Get('api/v1/health')
  async health(): Promise<{ status: string; db: string }> {
    try {
      await db.query('SELECT 1');
    } catch (e) {
      console.error('health db check failed', e);
      throw errors.dbUnavailable();
    }
    return { status: 'ok', db: 'ok' };
  }
}
