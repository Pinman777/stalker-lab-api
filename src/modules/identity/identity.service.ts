import { HttpException, Injectable } from '@nestjs/common';
import { verifyInitData, parseTgUser } from '../../common/tg-auth';
import { authRateLimiter } from '../../common/rate-limit';
import { errors } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { db } from '../../db/db';
import { config } from '../../config';
import { findUserByTelegramId, insertUser, toUserDto, type UserDto, type UserRow } from './users.repository';
import { InvitesService } from '../invites/invites.service';
import { insertReferral } from '../referrals/referrals.service';

export interface AuthResult {
  user: UserDto;
  isNew: boolean;
}

/** POST /api/v1/auth/telegram: stateless initData + INVITE-ONLY.
 *  Существующий юзер — свободно; новый — только с валидным одноразовым инвайтом,
 *  создание аккаунта и погашение кода атомарны в одной tx (нед1, задачи 2-3). */
@Injectable()
export class IdentityService {
  constructor(private readonly invites: InvitesService) {}

  async authenticate(initData: string, inviteCode: string | undefined, ip: string): Promise<AuthResult> {
    // brute-force: rate-limit на попытки ДО какой-либо проверки + audit
    if (!authRateLimiter.check(ip)) {
      await writeAudit(null, ip, 'auth_rate_limited');
      throw errors.rateLimited();
    }

    const fields = verifyInitData(initData, config.botToken);
    if (!fields) {
      await writeAudit(null, ip, 'auth_fail', 'bad_init_data');
      throw errors.invalidInitData();
    }
    const tg = parseTgUser(fields);
    if (!tg) {
      await writeAudit(null, ip, 'auth_fail', 'no_user_field');
      throw errors.invalidInitData();
    }

    const existing = await findUserByTelegramId(db, tg.id);
    if (existing) {
      if (existing.is_blocked) {
        await writeAudit(existing.id, ip, 'auth_fail', 'blocked');
        throw errors.blocked();
      }
      await writeAudit(existing.id, ip, 'auth_ok');
      return { user: toUserDto(existing), isNew: false };
    }

    if (!inviteCode) {
      await writeAudit(null, ip, 'auth_fail', 'invite_required');
      throw errors.inviteRequired();
    }

    // Новый юзер: аккаунт + погашение инвайта (+ реферальная привязка, нед3) атомарны;
    // битый/чужой код → rollback, аккаунта-сироты нет.
    // tx возвращает UserRow ЛИБО маркер «уже создан параллельным запросом» (review #3).
    const ALREADY = Symbol('already-created');
    let user: UserRow;
    try {
      const res = await db.tx(async (c): Promise<UserRow | typeof ALREADY> => {
        let u: UserRow;
        try {
          u = await insertUser(c, tg);
        } catch (e: unknown) {
          const code = (e as { code?: string }).code;
          if (code === '23505') {
            const again = await findUserByTelegramId(c, tg.id);
            if (again) return ALREADY;
          }
          throw e;
        }
        const consumed = await this.invites.consume(c, inviteCode, u.id);
        if (!consumed.ok) throw errors.inviteRequired();
        // Реферальный бейдж (нед3): вход по коду юзера X → привязка к X в той же tx.
        // CLI/бутстрап-коды (created_by NULL) привязки не создают; самоприглашение исключено.
        if (consumed.referrerUid && consumed.referrerUid !== String(u.id)) {
          await insertReferral(c, String(u.id), consumed.referrerUid, inviteCode);
        }
        return u;
      });
      if (res === ALREADY) {
        const again = await findUserByTelegramId(db, tg.id);
        if (again) {
          await writeAudit(again.id, ip, 'auth_ok');
          return { user: toUserDto(again), isNew: false };
        }
        throw errors.inviteRequired();
      }
      user = res;
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 403) {
        await writeAudit(null, ip, 'auth_fail', 'bad_invite_code');
      }
      throw e;
    }

    await writeAudit(user.id, ip, 'invite_used', inviteCode);
    await writeAudit(user.id, ip, 'auth_ok');
    return { user: toUserDto(user), isNew: true };
  }

  /** POST /api/v1/auth/invite/redeem (нед5-фикс веб-входа): юзер, уже опознанный
   *  TmaAuthGuard (initData ИЛИ Bearer из /auth/code/verify), гасит инвайт-код
   *  ОТДЕЛЬНО от входа. Флага инвайта в users НЕТ (гейт нед1: строка users
   *  создаётся только вместе с погашением кода в tx выше), поэтому «уже гасил» =
   *  invite_codes.used_by = user.id. FOR UPDATE на строке юзера сериализует
   *  параллельные redeem: второй код того же юзера не сгорает (чужой путь не гасим). */
  async redeemInvite(user: UserRow, code: string, ip: string): Promise<UserDto> {
    // перебор кодов — та же угроза, что и /auth/telegram: лимитер ДО проверок
    if (!authRateLimiter.check(ip)) {
      await writeAudit(user.id, ip, 'invite_redeem_rate_limited');
      throw errors.rateLimited();
    }

    const res = await db.tx(async (c): Promise<'ok' | 'already' | 'bad'> => {
      await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      const mine = await c.query('SELECT 1 FROM invite_codes WHERE used_by = $1 LIMIT 1', [user.id]);
      if (mine.rowCount) return 'already';
      const consumed = await this.invites.consume(c, code, user.id);
      return consumed.ok ? 'ok' : 'bad';
    });
    if (res === 'already') {
      await writeAudit(user.id, ip, 'invite_redeem_fail', 'already_invited');
      throw errors.alreadyInvited();
    }
    if (res === 'bad') {
      await writeAudit(user.id, ip, 'invite_redeem_fail', 'bad_invite_code');
      throw errors.badInviteCode();
    }
    await writeAudit(user.id, ip, 'invite_redeemed', maskInviteCode(code));
    return toUserDto(user);
  }
}

/** 'r_AbC12345' → 'r_…45': код целиком в аудите не храним (канон maskUsername). */
function maskInviteCode(code: string): string {
  if (code.length <= 4) return `${code.slice(0, 1)}…`;
  return `${code.slice(0, 2)}…${code.slice(-2)}`;
}
