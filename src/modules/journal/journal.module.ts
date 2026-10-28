import { Module } from '@nestjs/common';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';

/** Журнал (нед2): entries/trades/review + дисциплина через awardDisciplinePoints (в tx). */
@Module({
  controllers: [JournalController],
  providers: [JournalService],
})
export class JournalModule {}
