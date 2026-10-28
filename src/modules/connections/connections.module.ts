import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

/** Подключения к биржам (нед4): bind/unbind/list/sync/guide BingX + авто-импорт.
 *  Секреты — AES-256-GCM (CONN_ENC_KEY), ключ проверяется живым запросом к бирже.
 *  onModuleInit сервиса роняет старт без CONN_ENC_KEY — ошибка запуска, не рантайма. */
@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
})
export class ConnectionsModule {}
