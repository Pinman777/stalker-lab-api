import { Injectable, OnModuleInit } from '@nestjs/common';
import { db } from '../../db/db';
import type { Executor } from '../../db/db';
import { errors } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { decryptSecret, encryptSecret, maskKey } from './secret-crypto';
import {
  BingXApiError,
  BingXUnreachableError,
  fetchBalance,
  fetchIncome,
  fetchPositionHistory,
  type BingxPositionHistoryItem,
} from './bingx.client';

/** ════════════════════════════════════════════════════════════════════════
 *  ИДЕОЛОГИЯ НЕДЕЛИ 4 (TMM/IZ-паттерн): АВТО-СДЕЛКИ НЕ ДАЮТ БАЛЛОВ ДИСЦИПЛИНЫ.
 *
 *  Синк пишет ТОЛЬКО факты в auto_trades. Ни одного события в discipline_events
 *  за авто-импорт не начисляется — баллы заслуживаются планом, ручной записью
 *  и разбором, а не тем, что робот дёрнул API биржи. Статистика (count/pnl)
 *  в /me/stats — отдельными полями, отдельно от points.
 *  ════════════════════════════════════════════════════════════════════════ */

export interface ConnectionRow {
  id: string;
  user_id: string;
  venue: string;
  api_key: string;
  api_secret_enc: string;
  masked: string;
  bound_at: Date;
  last_sync_at: Date | null;
}

export interface ConnectionDto {
  venue: string;
  masked: string;
  boundAt: string;
  lastSyncAt: string | null;
}

export interface BindResult {
  venue: 'bingx';
  masked: string;
  bound_at: string;
}

export interface UnbindResult {
  venue: 'bingx';
  unbound: true;
  deleted_trades: number; // w4-fix3: авто-сделок снесено каскадом (предупреждение о потере — в гайде)
}

export interface SyncResult {
  venue: 'bingx';
  from: string;
  to: string;
  symbols_scanned: number;
  positions_seen: number;
  imported: number;
  updated: number;
}

export function toConnectionDto(c: ConnectionRow): ConnectionDto {
  return { venue: c.venue, masked: c.masked, boundAt: c.bound_at.toISOString(), lastSyncAt: c.last_sync_at?.toISOString() ?? null };
}

const CONN_COLUMNS = 'id, user_id, venue, api_key, api_secret_enc, masked, bound_at, last_sync_at';

/** Окно синка: последние 7 дней (АРХИТЕКТУРА нед4; максимум у BingX 90 дней — не упираемся). */
const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** positionHistory: 5 req/s на юзера (доки) — спим между символами, чтобы не ловить 100419. */
const INTER_REQUEST_DELAY_MS = 250;

@Injectable()
export class ConnectionsService implements OnModuleInit {
  /** CONN_ENC_KEY обязателен: без него секреты бирж шифровать нечем.
   *  Падаем на старте с понятной ошибкой, а не на первом bind'е. */
  onModuleInit(): void {
    if (!process.env.CONN_ENC_KEY) {
      throw new Error(
        'CONN_ENC_KEY is not set: ConnectionsModule refuses to start. ' +
          'Set CONN_ENC_KEY (passphrase для AES-256-GCM шифрования apiSecret бирж) в env.',
      );
    }
  }

  /** Подключение юзера к venue (или null). */
  async findConnection(userId: string, venue: string, exec: Executor = db): Promise<ConnectionRow | null> {
    const r = await exec.query<ConnectionRow>(
      `SELECT ${CONN_COLUMNS} FROM connections WHERE user_id = $1 AND venue = $2`,
      [userId, venue],
    );
    return r.rows[0] ?? null;
  }

  /** POST /connections/bingx/bind {apiKey, apiSecret, replace?}:
   *  1) живая валидация ключа GET /user/balance (code !== 0 → 403 invalid_api_key);
   *  2) apiSecret → AES-256-GCM (см. secret-crypto.ts), apiKey — как есть;
   *  3) один юзер = одно подключение на venue: дубль → 409 connection_exists,
   *     replace=true → перезапись существующего. */
  async bindBingx(
    userId: string,
    apiKey: string,
    apiSecret: string,
    replace: boolean,
    ip: string,
  ): Promise<BindResult> {
    try {
      await fetchBalance(apiKey, apiSecret); // code !== 0 → BingXApiError
    } catch (e) {
      if (e instanceof BingXUnreachableError) {
        await writeAudit(userId, ip, 'bingx_bind_fail', 'unreachable');
        throw errors.bingxUnreachable();
      }
      if (e instanceof BingXApiError) {
        // w4-fix1: rate-limit ≠ мёртвый ключ — иначе юзер ротирует рабочий ключ.
        if (e.rateLimited) {
          await writeAudit(userId, ip, 'bingx_bind_fail', `rate_limited code=${e.code} ${e.msg}`);
          throw errors.bingxRateLimited();
        }
        // Прочие ошибочные коды от биржи при проверке ключа = ключ не работает
        // (нет ключа / плохая подпись / нет прав Read). MVP: коды не разделяем.
        await writeAudit(userId, ip, 'bingx_bind_fail', `code=${e.code} ${e.msg}`);
        throw errors.invalidApiKey();
      }
      throw e;
    }

    const secretEnc = encryptSecret(apiKey, apiSecret);
    const masked = maskKey(apiKey);

    const existing = await this.findConnection(userId, 'bingx');
    if (existing && !replace) {
      await writeAudit(userId, ip, 'bingx_bind_fail', 'connection_exists');
      throw errors.connectionExists();
    }

    const row = await db.tx(async (c) => {
      if (existing) {
        // replace: обновляем ключи на существующем подключении (история авто-сделок живёт)
        const r = await c.query<ConnectionRow>(
          `UPDATE connections SET api_key = $3, api_secret_enc = $4, masked = $5, bound_at = now()
           WHERE id = $1 AND user_id = $2 RETURNING ${CONN_COLUMNS}`,
          [existing.id, userId, apiKey, secretEnc, masked],
        );
        return r.rows[0];
      }
      try {
        const r = await c.query<ConnectionRow>(
          `INSERT INTO connections (user_id, venue, api_key, api_secret_enc, masked)
           VALUES ($1, 'bingx', $2, $3, $4) RETURNING ${CONN_COLUMNS}`,
          [userId, apiKey, secretEnc, masked],
        );
        return r.rows[0];
      } catch (e: unknown) {
        if ((e as { code?: string }).code === '23505') throw errors.connectionExists(); // гонка двух bind'ов
        throw e;
      }
    });
    await writeAudit(userId, ip, 'bingx_bind', `masked=${masked} replace=${replace}`);
    return { venue: 'bingx', masked: row.masked, bound_at: row.bound_at.toISOString() };
  }

  /** POST /connections/bingx/unbind — снос подключения (авто-сделки каскадом, см. миграцию 008).
   *  w4-fix3: ответ честно говорит, сколько авто-сделок снесено (deleted_trades),
   *  считаем в той же транзакции, что и удаление — без окна гонки с параллельным синком. */
  async unbindBingx(userId: string, ip: string): Promise<UnbindResult> {
    const existing = await this.findConnection(userId, 'bingx');
    if (!existing) throw errors.notFound();
    const deletedTrades = await db.tx(async (c) => {
      const cnt = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM auto_trades WHERE connection_id = $1',
        [existing.id],
      );
      await c.query('DELETE FROM connections WHERE id = $1 AND user_id = $2', [existing.id, userId]);
      return cnt.rows[0].n;
    });
    await writeAudit(userId, ip, 'bingx_unbind', `masked=${existing.masked} deleted_trades=${deletedTrades}`);
    return { venue: 'bingx', unbound: true, deleted_trades: deletedTrades };
  }

  /** GET /connections — список подключений юзера (секреты наружу не отдаём никогда). */
  async listConnections(userId: string): Promise<ConnectionDto[]> {
    const r = await db.query<ConnectionRow>(
      `SELECT ${CONN_COLUMNS} FROM connections WHERE user_id = $1 ORDER BY bound_at`,
      [userId],
    );
    return r.rows.map(toConnectionDto);
  }

  /** POST /connections/bingx/sync — авто-импорт закрытых позиций за 7 дней.
   *
   *  positionHistory требует symbol (доки v2) → сначала обнаруживаем торгуемые
   *  символы через /user/income (там symbol опционален; каждый закрытый ордер
   *  и фандинг оставляют поток с символом) по обеим расчётным валютам (USDT+USDC),
   *  затем по каждому символу листаем positionHistory (pageIndex от 0, до пустой/короткой
   *  страницы). В журнал идут только ПОЛНОСТЬЮ закрытые позиции (closeAllPositions).
   *  Идемпотентность: UNIQUE(connection_id, exchange_ref) + ON CONFLICT DO UPDATE —
   *  повторный синк обновляет (частичное закрытие доросло до полного), не дублирует.
   *
   *  w4-fix2: весь синк — ОДНА транзакция с pg_try_advisory_xact_lock по user_id.
   *  Лок держится всё время синка (включая HTTP-запросы к бирже): параллельные синки
   *  того же юзера удваивали бы 5 req/s биржи → второй синк сразу 409 sync_in_progress
   *  (выбран вариант «сразу 409» вместо ожидания — проще и не копит очередь).
   *  xact-лок живёт до COMMIT/ROLLBACK и умирает вместе с соединением — утечки нет. */
  async syncBingx(userId: string, ip: string): Promise<SyncResult> {
    return db.tx<SyncResult>(async (c) => {
      const lock = await c.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        [userId],
      );
      if (!lock.rows[0].locked) throw errors.syncInProgress();

      const conn = await this.findConnection(userId, 'bingx', c);
      if (!conn) throw errors.notFound();

      // w4-fix4: битая строка api_secret_enc или ротация CONN_ENC_KEY — раньше был голый
      // 500 без аудита. Теперь: явная ошибка + аудит + это подключение пропускается
      // (не роняет синк целиком и не трогает ключ — лечится re-bind с replace).
      let apiSecret: string;
      try {
        apiSecret = decryptSecret(conn.api_key, conn.api_secret_enc);
      } catch (e) {
        await writeAudit(userId, ip, 'bingx_sync_fail', `conn_decrypt_failed masked=${conn.masked}: ${String(e)}`);
        throw errors.connDecryptFailed();
      }

      const endTime = Date.now();
      const startTime = endTime - SYNC_WINDOW_MS;

      let symbols: string[];
      try {
        symbols = await this.discoverSymbols(conn.api_key, apiSecret, startTime, endTime);
      } catch (e) {
        await this.handleSyncError(e, userId, ip);
        throw e; // handleSyncError всегда бросает
      }

      let positionsSeen = 0;
      const closed: BingxPositionHistoryItem[] = [];
      try {
        for (const symbol of symbols) {
          // пагинация pageIndex=0.. до короткой страницы (pageSize < запрошенного = хвост)
          for (let pageIndex = 0; ; pageIndex++) {
            const page = await fetchPositionHistory(conn.api_key, apiSecret, symbol, startTime, endTime, pageIndex);
            positionsSeen += page.length;
            closed.push(...page.filter((p) => p.closeAllPositions));
            if (page.length < 100) break; // 100 = pageSize по умолчанию (доки)
            await delay(INTER_REQUEST_DELAY_MS);
          }
          await delay(INTER_REQUEST_DELAY_MS);
        }
      } catch (e) {
        await this.handleSyncError(e, userId, ip);
        throw e;
      }

      let ins = 0;
      let upd = 0;
      for (const p of closed) {
        // xmax = 0 → строка вставлена этим запросом; иначе обновлена (канон pg для INSERT..ON CONFLICT)
        const r = await c.query<{ inserted: boolean }>(
          `INSERT INTO auto_trades
             (connection_id, exchange_ref, symbol, side, open_time, close_time, entry_price, exit_price, pnl_usd, leverage)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (connection_id, exchange_ref) DO UPDATE SET
             symbol = EXCLUDED.symbol, side = EXCLUDED.side, open_time = EXCLUDED.open_time,
             close_time = EXCLUDED.close_time, entry_price = EXCLUDED.entry_price,
             exit_price = EXCLUDED.exit_price, pnl_usd = EXCLUDED.pnl_usd, leverage = EXCLUDED.leverage
           RETURNING (xmax = 0) AS inserted`,
          [
            conn.id,
            p.positionId, // string! BIGINT > MAX_SAFE_INTEGER
            p.symbol,
            p.positionSide === 'LONG' ? 'long' : 'short',
            new Date(p.openTime),
            new Date(p.updateTime), // updateTime закрытой позиции = время закрытия (доки)
            p.avgPrice,
            p.avgClosePrice,
            p.realizedProfit,
            p.leverage,
          ],
        );
        if (r.rows[0].inserted) ins += 1;
        else upd += 1;
      }
      await c.query('UPDATE connections SET last_sync_at = now() WHERE id = $1', [conn.id]);

      return {
        venue: 'bingx',
        from: new Date(startTime).toISOString(),
        to: new Date(endTime).toISOString(),
        symbols_scanned: symbols.length,
        positions_seen: positionsSeen,
        imported: ins,
        updated: upd,
      };
    }).then(async (result) => {
      // аудит успеха — после COMMIT: неудача аудита не откатывает синк
      await writeAudit(userId, ip, 'bingx_sync', `symbols=${result.symbols_scanned} imported=${result.imported} updated=${result.updated}`);
      return result;
    });
  }

  private async discoverSymbols(
    apiKey: string,
    apiSecret: string,
    startTime: number,
    endTime: number,
  ): Promise<string[]> {
    const symbols = new Set<string>();
    // обе расчётные валюты: без currency income по умолчанию отдаёт только USDT (доки)
    for (const currency of ['USDT', 'USDC'] as const) {
      const flows = await fetchIncome(apiKey, apiSecret, startTime, endTime, currency);
      for (const f of flows) symbols.add(f.symbol);
      await delay(INTER_REQUEST_DELAY_MS);
    }
    return [...symbols].sort();
  }

  /** Единая обработка ошибок синка: биржа недоступна → 502, rate-limit → 502 bingx_rate_limited
   *  (НЕ «ключ невалиден» — рабочий ключ ротировать не надо), ключ умер → 403 (+audit всем). */
  private async handleSyncError(e: unknown, userId: string, ip: string): Promise<never> {
    if (e instanceof BingXUnreachableError) {
      await writeAudit(userId, ip, 'bingx_sync_fail', 'unreachable');
      throw errors.bingxUnreachable();
    }
    if (e instanceof BingXApiError) {
      // w4-fix1: 100419 — биржа тормозит нас, ключ живой
      if (e.rateLimited) {
        await writeAudit(userId, ip, 'bingx_sync_fail', `rate_limited code=${e.code} ${e.msg}`);
        throw errors.bingxRateLimited();
      }
      // ключ отозван/права сняли после bind'а — следующая привязка это починит
      await writeAudit(userId, ip, 'bingx_sync_fail', `code=${e.code} ${e.msg}`);
      throw errors.invalidApiKey();
    }
    await writeAudit(userId, ip, 'bingx_sync_fail', String(e));
    throw e;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
