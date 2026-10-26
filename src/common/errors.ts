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
  unauthenticated: () => new ApiError(401, 'unauthenticated'),
  invalidInitData: () => new ApiError(401, 'invalid_init_data'),
  userNotFound: () => new ApiError(401, 'user_not_found'),
  inviteRequired: () => new ApiError(403, 'invite_required'),
  blocked: () => new ApiError(403, 'blocked'),
  rateLimited: () => new ApiError(429, 'rate_limited'),
  notImplemented: () => new ApiError(501, 'not_implemented'),
};
