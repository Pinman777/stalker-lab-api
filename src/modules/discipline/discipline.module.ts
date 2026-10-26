import { Module } from '@nestjs/common';

/** Дисциплина — ledger-only, начисление через awardDisciplinePoints().
 *  Публичных эндпоинтов в нед1 нет (потребитель — журнал, нед2). */
@Module({})
export class DisciplineModule {}
