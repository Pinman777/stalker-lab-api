import { Request } from 'express';

/** Реальный IP за nginx (единственная фронт-дверь, АРХИТЕКТУРА §1) — X-Forwarded-For.
 *  Без прокси — адрес сокета. В тестах IP задаётся заголовком. */
export function getIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (typeof first === 'string' && first.length > 0) return first.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
