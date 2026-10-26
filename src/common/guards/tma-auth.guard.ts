import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { verifyInitData, parseTgUser } from '../tg-auth';
import { verifyJwt } from '../jwt';
import { config } from '../../config';
import { db } from '../../db/db';
import { findUserByTelegramId } from '../../modules/identity/users.repository';
import { errors, type ApiError } from '../errors';
import { writeAudit } from '../audit';
import { getIp } from '../ip';
import { authRateLimiter } from '../rate-limit';
import type { AuthedRequest } from '../authed-request';
import type { UserRow } from '../../modules/identity/users.repository';

/** Stateless-аутентификация per request (АРХИТЕКТУРА §1). Два способа (нед5):
 *  1) initData в заголовке x-telegram-init-data (TMA — как раньше);
 *  2) Authorization: Bearer <JWT> (браузер: токен от /auth/code/verify, payload.tg → юзер).
 *  Все отказы (401/403) — в audit_log, как и отказы /auth (review #4).
 *
 *  Фикс ревью нед2 → нед3 (п.2): guard-отказы идут ЧЕРЕЗ authRateLimiter (общий с /auth).
 *  Спам-поток с одного IP не заливает audit_log: после исчерпания лимита отказ уходит
 *  как 429 rate_limited БЕЗ audit-записи. Успешные проходы guard лимитер не тратят. */
@Injectable()
export class TmaAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const ip = getIp(req);

    const header = req.headers['x-telegram-init-data'];
    const initData = Array.isArray(header) ? header[0] : header;
    if (initData) {
      const fields = verifyInitData(initData, config.botToken);
      if (!fields) {
        return this.fail(null, ip, 'guard_bad_init_data', errors.invalidInitData());
      }
      const tg = parseTgUser(fields);
      if (!tg) {
        return this.fail(null, ip, 'guard_no_user_field', errors.invalidInitData());
      }
      return this.resolveUser(req, tg.id, ip, 'guard_user_not_found');
    }

    const authHeader = req.headers['authorization'];
    const bearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
      const payload = verifyJwt(bearer.slice('Bearer '.length).trim(), config.jwtSecret);
      const tg = payload?.tg;
      if (!payload || typeof tg !== 'number' || !Number.isInteger(tg) || tg <= 0) {
        return this.fail(null, ip, 'guard_bad_token', errors.unauthenticated());
      }
      return this.resolveUser(req, tg, ip, 'guard_token_user_not_found');
    }

    return this.fail(null, ip, 'guard_no_init_data', errors.unauthenticated());
  }

  /** Общий хвост обоих способов: юзер по telegram_id → blocked → req.user. */
  private async resolveUser(
    req: AuthedRequest,
    telegramId: number,
    ip: string,
    notFoundDetail: string,
  ): Promise<boolean> {
    const user: UserRow | null = await findUserByTelegramId(db, telegramId);
    if (!user) {
      // валидные креды, но юзер не прошёл invite-гейт: фиксируем telegram_id для разбора
      return this.fail(null, ip, `${notFoundDetail} tg=${telegramId}`, errors.userNotFound());
    }
    if (user.is_blocked) {
      return this.fail(user.id, ip, 'guard_blocked', errors.blocked());
    }
    req.user = user;
    return true;
  }

  /** Отказ guard: сначала лимитер (анти-спам audit), потом — если лимит жив — audit
   *  (await: тесты читают audit_log сразу после ответа). */
  private async fail(userId: string | null, ip: string, detail: string, e: ApiError): Promise<never> {
    if (!authRateLimiter.check(ip)) throw errors.rateLimited();
    await writeAudit(userId, ip, 'auth_fail', detail);
    throw e;
  }
}
