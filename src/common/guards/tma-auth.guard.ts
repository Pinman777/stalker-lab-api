import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { verifyInitData, parseTgUser } from '../tg-auth';
import { config } from '../../config';
import { db } from '../../db/db';
import { findUserByTelegramId } from '../../modules/identity/users.repository';
import { errors } from '../errors';
import { writeAudit } from '../audit';
import { getIp } from '../ip';
import type { AuthedRequest } from '../authed-request';

/** Stateless-аутентификация per request (АРХИТЕКТУРА §1, канон invest-pool AuthGuard):
 *  initData в заголовке x-telegram-init-data на каждый запрос. Обмен на токен — V1.
 *  Все отказы (401/403) — в audit_log, как и отказы /auth (review #4). */
@Injectable()
export class TmaAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const ip = getIp(req);
    const header = req.headers['x-telegram-init-data'];
    const initData = Array.isArray(header) ? header[0] : header;
    if (!initData) {
      await writeAudit(null, ip, 'auth_fail', 'guard_no_init_data');
      throw errors.unauthenticated();
    }

    const fields = verifyInitData(initData, config.botToken);
    if (!fields) {
      await writeAudit(null, ip, 'auth_fail', 'guard_bad_init_data');
      throw errors.invalidInitData();
    }
    const tg = parseTgUser(fields);
    if (!tg) {
      await writeAudit(null, ip, 'auth_fail', 'guard_no_user_field');
      throw errors.invalidInitData();
    }

    const user = await findUserByTelegramId(db, tg.id);
    if (!user) {
      // валидная подпись, но юзер не прошёл invite-гейт: фиксируем telegram_id для разбора
      await writeAudit(null, ip, 'auth_fail', `guard_user_not_found tg=${tg.id}`);
      throw errors.userNotFound();
    }
    if (user.is_blocked) {
      await writeAudit(user.id, ip, 'auth_fail', 'guard_blocked');
      throw errors.blocked();
    }

    req.user = user;
    return true;
  }
}
