import { Module } from '@nestjs/common';
import { JournalController } from './journal.controller';

@Module({
  controllers: [JournalController],
})
export class JournalModule {}
