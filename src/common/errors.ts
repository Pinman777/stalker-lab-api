import { HttpException } from '@nestjs/common';

/** Единый формат ошибок API: { error: '<code>' } (контракт нед1: 403 {error:'invite_required'} и т.п.,
 *  не nest-дефолт {statusCode, message}). */
export class ApiError extends HttpException {
  constructor(status: number, code: string) {
    super({ error: code }, status);
  }
}

export const errors = {
  invalidRequest: () => new ApiError(400, 'invalid_request'),
  unknownViolationCode: () => new ApiError(400, 'unknown_violation_code'),
  unauthenticated: () => new ApiError(401, 'unauthenticated'),
  invalidInitData: () => new ApiError(401, 'invalid_init_data'),
  // нед5 web-login: 404 на /auth/code/* не раскрывает причину (нет юзера = бот не пишет)
  userNotFound: (status = 401) => new ApiError(status, 'user_not_found'),
  invalidCode: () => new ApiError(403, 'invalid_code'),
  tooManyRequests: () => new ApiError(429, 'too_many_requests'),
  inviteRequired: () => new ApiError(403, 'invite_required'),
  badInviteCode: () => new ApiError(403, 'bad_invite_code'), // redeem: код не найден/уже погашен
  alreadyInvited: () => new ApiError(403, 'already_invited'), // redeem: юзер уже гасил инвайт
  blocked: () => new ApiError(403, 'blocked'),
  forbidden: () => new ApiError(403, 'forbidden'),
  entryClosed: () => new ApiError(403, 'entry_closed'),
  entryAlreadyClosed: () => new ApiError(409, 'entry_closed'), // PATCH повторного закрытия
  lessonLocked: () => new ApiError(403, 'lesson_locked'), // академия: лестница уроков (нед3)
  inviteLimitReached: () => new ApiError(409, 'invite_limit_reached'), // 3 активных инвайта (нед3)
  rateLimited: () => new ApiError(429, 'rate_limited'),
  notFound: () => new ApiError(404, 'not_found'),
  entryExists: () => new ApiError(409, 'entry_exists'),
  notImplemented: () => new ApiError(501, 'not_implemented'),
  dbUnavailable: () => new ApiError(503, 'db_unavailable'),
  invalidApiKey: () => new ApiError(403, 'invalid_api_key'), // нед4: биржа отвергла ключ (bind/синк)
  connectionExists: () => new ApiError(409, 'connection_exists'), // нед4: venue уже привязан (bind без replace)
  bingxUnreachable: () => new ApiError(502, 'bingx_unreachable'), // нед4: биржа не отвечает (не ошибка ключа)
  bingxRateLimited: () => new ApiError(502, 'bingx_rate_limited'), // w4-fix1: BingX 100419 — лимит запросов, НЕ мёртвый ключ
  syncInProgress: () => new ApiError(409, 'sync_in_progress'), // w4-fix2: advisory-lock — синк этого юзера уже идёт
  invalidTradeState: () => new ApiError(409, 'invalid_trade_state'), // 013: переход статуса сетапа не по машине (armed→closed мимо entered и т.п.)
  connDecryptFailed: () => new ApiError(503, 'conn_decrypt_failed'), // w4-fix4: api_secret_enc не расшифровывается (ротация CONN_ENC_KEY) — лечится re-bind
};
