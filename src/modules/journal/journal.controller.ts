import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import { errors } from '../../common/errors';

/** Неделя 1 — скелет: схема в миграциях (journal_entries / journal_trades),
 *  эндпоинты — честные заглушки до недели 2 (АРХИТЕКТУРА §6). */
@Controller()
@UseGuards(TmaAuthGuard)
export class JournalController {
  @Post('api/v1/journal/entries')
  createEntry(): never {
    throw errors.notImplemented();
  }

  @Get('api/v1/journal/entries')
  listEntries(): never {
    throw errors.notImplemented();
  }
}
