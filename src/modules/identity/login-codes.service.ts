import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomInt } from 'crypto';
import { config } from '../../config';
import { db } from '../../db/db';
import { errors } from '../../common/errors';
import { signJwt } from '../../common/jwt';
import { writeAudit } from '../../common/audit';
import { findUserByUsernameOrTelegramId, toUserDto, type UserDto, type UserRow } from './users.repository';
import { TelegramBotApiSender, type TgSender } from './tg-sender';

const MAX_PER_USER_PER_HOUR = 5; // rate-limit по факту созданных кодов (login_codes — источник правды)
const MAX_PER_IP_PER_HOUR = 10;
const MAX_VERIFY_ATTEMPTS = 5;
const JWT_TTL_SEC = 24 * 3600;

interface LoginCodeRow {
  id: string;
  code: string;
  expires_at: Date;
  used_at: Date | null;
  attempts: number;
}

/** Web-login (нед5): юзер в TMA → POST /auth/code/request → код в личку бота →
 *  POST /auth/code/verify → JWT {tg, exp:24h} для Authorization: Bearer в браузере.
 *  TTL кода 10 минут (interval ниже = текст сообщения «Действителен 10 минут»). */
@Injectable()
export class LoginCodesService implements OnModuleInit {
  constructor(@Inject(TelegramBotApiSender) private readonly tg: TgSender) {}

  /** Как CONN_ENC_KEY: без секрета JWT веб-вход не поднимается (ошибка запуска, не рантайма). */
  onModuleInit(): void {
    if (!config.jwtSecret) throw new Error('JWT_SECRET is required (env)');
  }

  async request(username: string, ip: string): Promise<{ sent: true }> {
    const user = await findUserByUsernameOrTelegramId(db, username);
    if (!user) throw errors.userNotFound(404);

    const byUser = await db.query(
      `SELECT count(*)::int AS n FROM login_codes
       WHERE telegram_user_id = $1 AND created_at > now() - interval '1 hour'`,
      [user.telegram_id],
    );
    if (byUser.rows[0].n >= MAX_PER_USER_PER_HOUR) throw errors.tooManyRequests();
    const byIp = await db.query(
      `SELECT count(*)::int AS n FROM login_codes
       WHERE ip = $1 AND created_at > now() - interval '1 hour'`,
      [ip],
    );
    if (byIp.rows[0].n >= MAX_PER_IP_PER_HOUR) throw errors.tooManyRequests();

    // один активный код: прежние неиспользованные гасим
    await db.query('UPDATE login_codes SET used_at = now() WHERE telegram_user_id = $1 AND used_at IS NULL', [
      user.telegram_id,
    ]);

    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const inserted = await db.query(
      `INSERT INTO login_codes (telegram_user_id, code, expires_at, ip)
       VALUES ($1, $2, now() + interval '10 minutes', $3) RETURNING id`,
      [user.telegram_id, code, ip],
    );
    try {
      await this.tg.sendMessageTo(
        user.telegram_id,
        `Код для входа в Stalker Lab: ${code}. Действителен 10 минут. Если это не ты — проигнорируй.`,
      );
    } catch {
      // недоставленный код мёртв; причину наружу не раскрываем (404 = «юзера нет»)
      await db.query('UPDATE login_codes SET used_at = now() WHERE id = $1', [inserted.rows[0].id]);
      await writeAudit(user.id, ip, 'login_code_send_fail', maskUsername(username));
      throw errors.userNotFound(404);
    }
    await writeAudit(user.id, ip, 'login_code_requested', maskUsername(username));
    return { sent: true };
  }

  async verify(username: string, code: string, ip: string): Promise<{ token: string; user: UserDto }> {
    const user = await findUserByUsernameOrTelegramId(db, username);
    if (user) {
      const r = await db.query(
        `SELECT id, code, expires_at, used_at, attempts FROM login_codes
         WHERE telegram_user_id = $1 AND used_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [user.telegram_id],
      );
      const row = r.rows[0] as LoginCodeRow | undefined;
      if (row && row.expires_at.getTime() > Date.now() && row.attempts < MAX_VERIFY_ATTEMPTS) {
        if (row.code === code) {
          // атомарное погашение: параллельные verify не расходуют код дважды
          const burn = await db.query(
            'UPDATE login_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
            [row.id],
          );
          if (burn.rowCount) {
            const token = signJwt(
              { tg: Number(user.telegram_id), exp: Math.floor(Date.now() / 1000) + JWT_TTL_SEC },
              config.jwtSecret,
            );
            await writeAudit(user.id, ip, 'login_code_success', maskUsername(username));
            return { token, user: toUserDto(user) };
          }
        } else {
          // промах: +попытка; 5-й промах гасит код
          await db.query(
            `UPDATE login_codes SET attempts = attempts + 1,
               used_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE used_at END
             WHERE id = $1`,
            [row.id, MAX_VERIFY_ATTEMPTS],
          );
        }
      }
    }
    // единый отказ: не раскрываем, существует ли юзер / код / что именно не сошлось
    await writeAudit(user ? user.id : null, ip, 'login_code_fail', maskUsername(username));
    throw errors.invalidCode();
  }
}

/** 'stalker_main' → 'st…in': аудит не хранит полный username. */
function maskUsername(u: string): string {
  if (u.length <= 4) return `${u.slice(0, 1)}…`;
  return `${u.slice(0, 2)}…${u.slice(-2)}`;
}
