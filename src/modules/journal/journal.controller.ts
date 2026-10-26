import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import { errors } from '../../common/errors';
import { getIp } from '../../common/ip';
import { JournalService, type AutoTradeDto, type EntryDto, type TradeDto, type TradeInput } from './journal.service';
import type { AuthedRequest } from '../../common/authed-request';

/** Журнал (нед2 — ядро продукта): сессия-вылазка на день + сделки + разбор.
 *  Все эндпоинты за TmaAuthGuard; владелец = req.user (свои данные только). */
@Controller('api/v1/journal')
@UseGuards(TmaAuthGuard)
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Post('entries')
  async createEntry(@Body() body: unknown, @Req() req: AuthedRequest): Promise<{ entry: EntryDto }> {
    const b = parseCreateEntryBody(body);
    const entry = await this.journal.createEntry(req.user!.id, b.date, b.plan);
    return { entry };
  }

  @Get('entries')
  async listEntries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Req() req?: AuthedRequest,
  ): Promise<{ entries: EntryDto[] }> {
    const range = parseDateRange(from, to);
    return { entries: await this.journal.listEntries(req!.user!.id, range.from, range.to) };
  }

  @Get('entries/:id')
  async getEntry(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.journal.getEntry(req.user!.id, parseId(id));
  }

  @Patch('entries/:id')
  async closeEntry(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest): Promise<{ entry: EntryDto }> {
    const b = parseCloseEntryBody(body);
    const entry = await this.journal.closeEntry(req.user!.id, parseId(id), b.review);
    return { entry };
  }

  @Post('entries/:id/trades')
  async addTrade(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest): Promise<{ trade: TradeDto }> {
    const t = parseTradeBody(body);
    const trade = await this.journal.addTrade(req.user!.id, parseId(id), t, getIp(req));
    return { trade };
  }

  /** Авто-сделки (нед4): импорт из биржевых подключений. Только чтение — факты и
   *  статистика, баллов дисциплины за них НЕТ (идеология, см. journal.service). */
  @Get('auto')
  async listAuto(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Req() req?: AuthedRequest,
  ): Promise<{ trades: AutoTradeDto[] }> {
    const range = parseDateRange(from, to);
    return { trades: await this.journal.listAutoTrades(req!.user!.id, range.from, range.to) };
  }
}

// --- валидация входа (канон нед1: parse-функции, 400 invalid_request) ---

/** 'YYYY-MM-DD' + реальная календарная дата (2026-02-31 → 400). */
function parseDate(s: unknown): string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw errors.invalidRequest();
  if (Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
    throw errors.invalidRequest();
  }
  return s;
}

/** Фикс ревью нед2 → нед3 (п.3): дата вылазки — не дальше завтрашнего дня (UTC).
 *  +1d — допуск на таймзону клиента (у нас день канонизирован как entry.date, см. сервис).
 *  Прошлые даты свободны: дебриф задним числом — легальный флоу, «планы на послезавтра» — нет. */
function assertNotFarFuture(date: string): void {
  const now = new Date();
  const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    .toISOString()
    .slice(0, 10);
  if (date > tomorrowUtc) throw errors.invalidRequest();
}

function parseText(v: unknown, max: number): string {
  if (typeof v !== 'string') throw errors.invalidRequest();
  const s = v.trim();
  if (s.length === 0 || s.length > max) throw errors.invalidRequest();
  return s;
}

function parseId(id: string): number {
  if (!/^\d+$/.test(id)) throw errors.invalidRequest();
  return Number(id);
}

function parseCreateEntryBody(body: unknown): { date: string; plan: string } {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const b = body as Record<string, unknown>;
  const date = parseDate(b.date);
  assertNotFarFuture(date); // будущее клампим, прошлое свободно (ревью нед2, п.3)
  return { date, plan: parseText(b.plan, 4000) };
}

function parseCloseEntryBody(body: unknown): { review: string } {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const b = body as Record<string, unknown>;
  if (b.status !== 'closed') throw errors.invalidRequest(); // единственный переход: draft → closed
  return { review: parseText(b.review, 8000) };
}

function parseDateRange(from: unknown, to: unknown): { from: string | null; to: string | null } {
  if (from !== undefined && from !== '') parseDate(from);
  if (to !== undefined && to !== '') parseDate(to);
  const f = typeof from === 'string' && from !== '' ? from : null;
  const t = typeof to === 'string' && to !== '' ? to : null;
  if (f && t && f > t) throw errors.invalidRequest(); // from > to — пустое множество, честный 400
  return { from: f, to: t };
}

function parseTradeBody(body: unknown): TradeInput {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const b = body as Record<string, unknown>;
  const dir = b.dir;
  if (dir !== 'long' && dir !== 'short') throw errors.invalidRequest();
  return {
    sym: parseText(b.sym, 24),
    dir,
    entry: parsePrice(b.entry),
    stop: parsePrice(b.stop),
    exit: parsePrice(b.exit),
    r: b.r === undefined || b.r === null ? null : parseFinite(b.r),
    setup: b.setup === undefined || b.setup === null ? null : parseText(b.setup, 200),
    violationCode: b.violation_code === undefined || b.violation_code === null ? null : parseText(b.violation_code, 64),
  };
}

function parsePrice(v: unknown): number {
  const n = parseFinite(v);
  if (n <= 0) throw errors.invalidRequest(); // цена — положительная
  return n;
}

function parseFinite(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw errors.invalidRequest();
  return n;
}
