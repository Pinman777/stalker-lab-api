import { Module } from '@nestjs/common';
import { DisciplineController } from './discipline.controller';

/** Дисциплина — ledger-only, начисление через awardDisciplinePoints() (потребитель — журнал).
 *  Публичный эндпоинт один: GET /api/v1/me/stats (нед2). */
@Module({
  controllers: [DisciplineController],
})
export class DisciplineModule {}
