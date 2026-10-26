import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { verifyInitData, parseTgUser } from '../tg-auth';
import { config } from '../../config';
import { db } from '../../db/db';
import { findUserByTelegramId } from '../../modules/identity/users.repository';
import { errors, type ApiError } from '../errors';
import { writeAudit } from '../audit';
import { getIp } from '../ip';
import { authRateLimiter } from '../rate-limit';
import type { AuthedRequest } from '../authed-request';

/** Stateless-аутентификация per request (АРХИТЕКТУРА §1, канон invest-pool AuthGuard):
 *  initData в заголовке x-telegram-init-data на каждый запрос. Обмен на токен — V1.
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
    if (!initData) {
      return this.fail(null, ip, 'guard_no_init_data', errors.unauthenticated());
    }

    const fields = verifyInitData(initData, config.botToken);
    if (!fields) {
      return this.fail(null, ip, 'guard_bad_init_data', errors.invalidInitData());
    }
    const tg = parseTgUser(fields);
    if (!tg) {
      return this.fail(null, ip, 'guard_no_user_field', errors.invalidInitData());
    }

    const user = await findUserByTelegramId(db, tg.id);
    if (!user) {
      // валидная подпись, но юзер не прошёл invite-гейт: фиксируем telegram_id для разбора
      return this.fail(null, ip, `guard_user_not_found tg=${tg.id}`, errors.userNotFound());
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
