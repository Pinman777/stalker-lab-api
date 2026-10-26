import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import { errors } from '../../common/errors';
import { getIp } from '../../common/ip';
import { writeAudit } from '../../common/audit';
import { SlidingWindowRateLimiter } from '../../common/rate-limit';
import { ConnectionsService, type BindResult, type ConnectionDto, type SyncResult } from './connections.service';
import { BINGX_GUIDE, type BingxBindGuide } from './guide';
import type { AuthedRequest } from '../../common/authed-request';

/** Подключения к биржам (нед4 — автожурнал BingX). Все эндпоинты за TmaAuthGuard.
 *
 *  Rate-limit: 10 действий/мин на юзера (bind/unbind/sync/list/guide — всё вместе):
 *  bind и sync ходят в биржу, гонять их чаще незачем. Отказ под лимитом — в audit. */
export const connectionsRateLimiter = new SlidingWindowRateLimiter(10, 60_000);

@Controller('api/v1/connections')
@UseGuards(TmaAuthGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  /** Пошаговый гайд привязки (статика для фронта, меняем только с релизом). */
  @Get('bingx/guide')
  async guide(@Req() req: AuthedRequest): Promise<BingxBindGuide> {
    this.limited(req, 'guide');
    return BINGX_GUIDE;
  }

  /** Привязка ключа: валидация живым запросом → шифрование секрета → запись. */
  @Post('bingx/bind')
  async bind(@Body() body: unknown, @Req() req: AuthedRequest): Promise<BindResult> {
    this.limited(req, 'bind');
    const b = parseBindBody(body);
    return this.connections.bindBingx(req.user!.id, b.apiKey, b.apiSecret, b.replace, getIp(req));
  }

  /** Отвязка (+ аудит; авто-сделки каскадом — см. миграцию 008). */
  @Post('bingx/unbind')
  @HttpCode(200)
  async unbind(@Req() req: AuthedRequest): Promise<{ venue: 'bingx'; unbound: true }> {
    this.limited(req, 'unbind');
    return this.connections.unbindBingx(req.user!.id, getIp(req));
  }

  /** Ручной синк: импорт закрытых позиций за 7 дней. */
  @Post('bingx/sync')
  @HttpCode(200)
  async sync(@Req() req: AuthedRequest): Promise<SyncResult> {
    this.limited(req, 'sync');
    return this.connections.syncBingx(req.user!.id, getIp(req));
  }

  /** Список подключений юзера. */
  @Get()
  async list(@Req() req: AuthedRequest): Promise<{ connections: ConnectionDto[] }> {
    this.limited(req, 'list');
    return { connections: await this.connections.listConnections(req.user!.id) };
  }

  private limited(req: AuthedRequest, action: string): void {
    if (!connectionsRateLimiter.check(`conn:${req.user!.id}`)) {
      // лимит не тратит audit на каждый спам-удар, но один отказ фиксируем отдельным действием
      void writeAudit(req.user!.id, getIp(req), 'connections_rate_limited', action);
      throw errors.rateLimited();
    }
  }
}

function parseBindBody(body: unknown): { apiKey: string; apiSecret: string; replace: boolean } {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const b = body as Record<string, unknown>;
  if (typeof b.apiKey !== 'string' || typeof b.apiSecret !== 'string') throw errors.invalidRequest();
  const apiKey = b.apiKey.trim();
  const apiSecret = b.apiSecret.trim();
  // BingX: apiKey/secret — длинные алфавитно-цифровые строки; отсекаем мусор заранее,
  // финальную проверку всё равно делает живой запрос к бирже.
  if (apiKey.length < 16 || apiKey.length > 256 || apiSecret.length < 16 || apiSecret.length > 512) {
    throw errors.invalidRequest();
  }
  const replace = b.replace === undefined ? false : b.replace === true;
  if (b.replace !== undefined && typeof b.replace !== 'boolean') throw errors.invalidRequest();
  return { apiKey, apiSecret, replace };
}
