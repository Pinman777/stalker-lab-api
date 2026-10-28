import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

/** Глобальный exception-filter (review #10): ЛЮБОЙ ответ об ошибке — единый контракт
 *  {error: '<code>'}, не nest-дефолт {statusCode, message, error}.
 *  ApiError проходит как есть; прочие HttpException (404 маршрута, битый JSON-body,
 *  405 и т.п.) нормализуются в код по статусу; неизвестное — 500 {error:'internal'}
 *  без стека наружу (стек — в stderr). */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  501: 'not_implemented',
  503: 'service_unavailable',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // наш контракт — ровно {error: code}; nest-дефолт всегда несёт statusCode+message —
      // у него тоже есть поле error ('Not Found', 'Bad Request'), поэтому проверяем отсутствие statusCode.
      if (
        typeof body === 'object' &&
        body !== null &&
        !('statusCode' in body) &&
        !('message' in body) &&
        typeof (body as { error?: unknown }).error === 'string'
      ) {
        res.status(status).json(body);
        return;
      }
      res.status(status).json({ error: CODE_BY_STATUS[status] ?? `http_${status}` });
      return;
    }

    console.error('unhandled exception', exception);
    res.status(500).json({ error: 'internal' });
  }
}
