import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { verifyInitData, parseTgUser } from '../tg-auth';
import { config } from '../../config';
import { db } from '../../db/db';
import { findUserByTelegramId } from '../../modules/identity/users.repository';
import { errors } from '../errors';
import type { AuthedRequest } from '../authed-request';

/** Stateless-аутентификация per request (АРХИТЕКТУРА §1, канон invest-pool AuthGuard):
 *  initData в заголовке x-telegram-init-data на каждый запрос. Обмен на токен — V1. */
@Injectable()
export class TmaAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['x-telegram-init-data'];
    const initData = Array.isArray(header) ? header[0] : header;
    if (!initData) throw errors.unauthenticated();

    const fields = verifyInitData(initData, config.botToken);
    if (!fields) throw errors.invalidInitData();
    const tg = parseTgUser(fields);
    if (!tg) throw errors.invalidInitData();

    const user = await findUserByTelegramId(db, tg.id);
    if (!user) throw errors.userNotFound(); // юзер не прошёл invite-гейт в /auth/telegram
    if (user.is_blocked) throw errors.blocked();

    req.user = user;
    return true;
  }
}
