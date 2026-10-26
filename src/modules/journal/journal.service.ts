import { Injectable } from '@nestjs/common';
import { db } from '../../db/db';
import type { Executor } from '../../db/db';
import { errors, ApiError } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { awardDisciplinePoints } from '../discipline/discipline.service';

/** Веса дисциплины (АРХИТЕКТУРА §2, нед2): журнал = ядро продукта.
 *  journal_entry +5, journal_trade +5 (кроме сделок с нарушением кодекса), journal_review +3. */
export const DISCIPLINE_POINTS = { entry: 5, trade: 5, review: 3 } as const;

/** DATE из pg парсится в Date по локальной таймзоне (сдвиг дня на negative-offset) —
 *  поэтому наружу отдаём текстом: to_char(date, 'YYYY-MM-DD'). */
const ENTRY_COLUMNS = `id, user_id, to_char(date, 'YYYY-MM-DD') AS date, plan, review, status, created_at, updated_at`;

export interface EntryRow {
  id: string;
  user_id: string;
  date: string;
  plan: string;
  review: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  trades_count?: number;
}

export interface TradeRow {
  id: string;
  entry_id: string;
  sym: string;
  dir: string;
  entry: string; // NUMERIC → string из pg
  stop: string;
  exit: string;
  r: string | null;
  setup: string | null;
  violation_code: string | null;
  created_at: Date;
}

export interface EntryDto {
  id: number;
  date: string;
  plan: string;
  review: string | null;
  status: string;
  tradesCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TradeDto {
  id: number;
  sym: string;
  dir: 'long' | 'short';
  entry: number;
  stop: number;
  exit: number;
  r: number | null;
  setup: string | null;
  violationCode: string | null;
  createdAt: string;
}

export interface TradeInput {
  sym: string;
  dir: 'long' | 'short';
  entry: number;
  stop: number;
  exit: number;
  r: number | null;
  setup: string | null;
  violationCode: string | null;
}

/** ════════════════════════════════════════════════════════════════════════
 *  ИДЕОЛОГИЯ НЕДЕЛИ 4: АВТО-СДЕЛКИ НЕ ДАЮТ БАЛЛОВ ДИСЦИПЛИНЫ.
 *  listAutoTrades (ниже) читает ТОЛЬКО факты из auto_trades; ни при каком
 *  событии синка дисциплина не начисляется. Баллы — за план/ручную запись/разбор.
 *  ════════════════════════════════════════════════════════════════════════ */

export interface AutoTradeDto {
  id: number;
  symbol: string;
  side: 'long' | 'short';
  openTime: string;
  closeTime: string;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  leverage: number;
  venue: string; // авто-сделка всегда через подключение (join connections)
}

export function toEntryDto(e: EntryRow): EntryDto {
  return {
    id: Number(e.id),
    date: e.date,
    plan: e.plan,
    review: e.review,
    status: e.status,
    ...(e.trades_count !== undefined ? { tradesCount: e.trades_count } : {}),
    createdAt: e.created_at.toISOString(),
    updatedAt: e.updated_at.toISOString(),
  };
}

export function toTradeDto(t: TradeRow): TradeDto {
  return {
    id: Number(t.id),
    sym: t.sym,
    dir: t.dir as 'long' | 'short',
    entry: Number(t.entry),
    stop: Number(t.stop),
    exit: Number(t.exit),
    r: t.r === null ? null : Number(t.r),
    setup: t.setup,
    violationCode: t.violation_code,
    createdAt: t.created_at.toISOString(),
  };
}

/** Классификация «строка не изменилась/не найдена» для :id-операций:
 *  нет записи → 404; чужая → 403 forbidden; в остальных случаях сессия закрыта. */
async function classifyEntryMiss(
  exec: Executor,
  id: number,
  userId: string,
  closedError: () => ApiError,
): Promise<never> {
  const r = await exec.query<{ user_id: string; status: string }>(
    'SELECT user_id, status FROM journal_entries WHERE id = $1',
    [id],
  );
  const row = r.rows[0];
  if (!row) throw errors.notFound();
  if (String(row.user_id) !== String(userId)) throw errors.forbidden();
  throw closedError();
}

@Injectable()
export class JournalService {
  /** POST /entries: сессия дня + journal_entry(+5) — атомарно. Дубль дня → 409 entry_exists.
   *  КАНОН ДНЯ ДЛЯ ДИСЦИПЛИНЫ (решение ревью нед2, п.4): днём события считается entry.date —
   *  день, заданный юзером при создании сессии, а НЕ created_at: дебриф задним числом
   *  относится к дню вылазки, и баллы относятся к тому же дню. Кнопка здесь, день — из данных. */
  async createEntry(userId: string, date: string, plan: string): Promise<EntryDto> {
    return db.tx(async (c) => {
      let row: EntryRow;
      try {
        const r = await c.query<EntryRow>(
          `INSERT INTO journal_entries (user_id, date, plan) VALUES ($1, $2, $3) RETURNING ${ENTRY_COLUMNS}`,
          [userId, date, plan],
        );
        row = r.rows[0];
      } catch (e: unknown) {
        if ((e as { code?: string }).code === '23505') throw errors.entryExists(); // UNIQUE(user_id, date)
        throw e;
      }
      await awardDisciplinePoints(c, {
        userId,
        eventType: 'journal_entry',
        refType: 'journal',
        refId: Number(row.id),
        points: DISCIPLINE_POINTS.entry,
      });
      return toEntryDto(row);
    });
  }

  /** GET /entries?from&to: только свои, дата убыв. from/to опциональны, включительно. */
  async listEntries(userId: string, from: string | null, to: string | null): Promise<EntryDto[]> {
    const r = await db.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS}, (SELECT count(*)::int FROM journal_trades t WHERE t.entry_id = e.id) AS trades_count
       FROM journal_entries e
       WHERE e.user_id = $1 AND ($2::date IS NULL OR e.date >= $2::date) AND ($3::date IS NULL OR e.date <= $3::date)
       ORDER BY e.date DESC, e.id DESC`,
      [userId, from, to],
    );
    return r.rows.map(toEntryDto);
  }

  /** GET /entries/:id: сессия + её сделки. Только владелец (403), иначе 404. */
  async getEntry(userId: string, id: number): Promise<{ entry: EntryDto; trades: TradeDto[] }> {
    const e = await db.query<EntryRow>(`SELECT ${ENTRY_COLUMNS} FROM journal_entries WHERE id = $1`, [id]);
    const row = e.rows[0];
    if (!row) throw errors.notFound();
    if (String(row.user_id) !== String(userId)) throw errors.forbidden();
    const t = await db.query<TradeRow>(
      'SELECT * FROM journal_trades WHERE entry_id = $1 ORDER BY id',
      [id],
    );
    return { entry: toEntryDto(row), trades: t.rows.map(toTradeDto) };
  }

  /** PATCH /entries/:id {review, status:'closed'}: разбор дня закрывает сессию + journal_review(+3).
   *  Атомарный условный UPDATE (row lock): гонка «двойное закрытие» даёт rowCount 0 второму. */
  async closeEntry(userId: string, id: number, review: string): Promise<EntryDto> {
    const row = await db.tx(async (c) => {
      const r = await c.query<EntryRow>(
        `UPDATE journal_entries SET review = $2, status = 'closed', updated_at = now()
         WHERE id = $1 AND user_id = $3 AND status = 'draft'
         RETURNING ${ENTRY_COLUMNS}`,
        [id, review, userId],
      );
      if (!r.rowCount) {
        await classifyEntryMiss(c, id, userId, () => errors.entryAlreadyClosed()); // throws
      }
      const entry = r.rows[0];
      await awardDisciplinePoints(c, {
        userId,
        eventType: 'journal_review',
        refType: 'journal',
        refId: id,
        points: DISCIPLINE_POINTS.review,
      });
      return entry;
    });
    return toEntryDto(row);
  }

  /** POST /entries/:id/trades: только в свою ОТКРЫТУЮ сессию.
   *  Фикс ревью нед2 (п.1): перед INSERT — SELECT ... FOR SHARE на строке сессии.
   *  Атомарного INSERT..SELECT хватало против «вставки в уже закрытую», но закрытие,
   *  стартовавшее между snapshot-ом INSERT и его коммитом, могло пройти «сквозь» сделку.
   *  SHARE-лок выстраивает порядок: либо сделка коммитится раньше закрытия (валидна),
   *  либо закрытие коммитится первым — и SELECT уже не видит status='draft' (EvalPlanQual
   *  перепроверяет предикат после ожидания лока).
   *  Сделка с violation_code: БЕЗ баллов, нарушение — в audit (после коммита). */
  async addTrade(userId: string, entryId: number, t: TradeInput, ip: string): Promise<TradeDto> {
    if (t.violationCode) {
      const known = await db.query('SELECT 1 FROM codex_rules WHERE code = $1', [t.violationCode]);
      if (!known.rowCount) throw errors.unknownViolationCode();
    }

    const row = await db.tx(async (c) => {
      const lock = await c.query(
        `SELECT 1 FROM journal_entries WHERE id = $1 AND user_id = $2 AND status = 'draft' FOR SHARE`,
        [entryId, userId],
      );
      if (!lock.rowCount) {
        await classifyEntryMiss(c, entryId, userId, () => errors.entryClosed()); // throws
      }
      const r = await c.query<TradeRow>(
        `INSERT INTO journal_trades (entry_id, sym, dir, entry, stop, exit, r, setup, violation_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [entryId, t.sym, t.dir, t.entry, t.stop, t.exit, t.r, t.setup, t.violationCode],
      );
      const trade = r.rows[0];
      if (!t.violationCode) {
        await awardDisciplinePoints(c, {
          userId,
          eventType: 'journal_trade',
          refType: 'journal',
          refId: Number(trade.id),
          points: DISCIPLINE_POINTS.trade,
        });
      }
      return trade;
    });

    if (t.violationCode) {
      await writeAudit(userId, ip, 'codex_violation', `${t.violationCode} trade=${row.id}`);
    }
    return toTradeDto(row);
  }

  /** GET /journal/auto?from&to (нед4): авто-сделки юзера — все его биржевые
   *  подключения (join connections). Фильтр from/to — по ДАТЕ ЗАКРЫТИЯ позиции
   *  (close_time, дни YYYY-MM-DD, включительно; «сделка принадлежит» дню закрытия).
   *  Статистика, не дисциплина: см. комментарий об идеологии выше. */
  async listAutoTrades(userId: string, from: string | null, to: string | null): Promise<AutoTradeDto[]> {
    const r = await db.query<{
      id: string;
      symbol: string;
      side: 'long' | 'short';
      open_time: Date;
      close_time: Date;
      entry_price: string;
      exit_price: string;
      pnl_usd: string;
      leverage: number;
      venue: string;
    }>(
      `SELECT a.id, a.symbol, a.side, a.open_time, a.close_time,
              a.entry_price, a.exit_price, a.pnl_usd, a.leverage, c.venue
       FROM auto_trades a
       JOIN connections c ON c.id = a.connection_id
       WHERE c.user_id = $1
         AND ($2::date IS NULL OR a.close_time >= $2::date)
         AND ($3::date IS NULL OR a.close_time < ($3::date + 1))
       ORDER BY a.close_time DESC, a.id DESC`,
      [userId, from, to],
    );
    return r.rows.map((t) => ({
      id: Number(t.id),
      symbol: t.symbol,
      side: t.side,
      openTime: t.open_time.toISOString(),
      closeTime: t.close_time.toISOString(),
      entryPrice: Number(t.entry_price),
      exitPrice: Number(t.exit_price),
      pnlUsd: Number(t.pnl_usd),
      leverage: Number(t.leverage),
      venue: t.venue,
    }));
  }
}
