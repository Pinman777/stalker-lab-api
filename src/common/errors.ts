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
  userNotFound: () => new ApiError(401, 'user_not_found'),
  inviteRequired: () => new ApiError(403, 'invite_required'),
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
};
