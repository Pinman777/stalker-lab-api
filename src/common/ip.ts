import { Request } from 'express';

/** Реальный IP за единственным доверенным прокси (nginx/cloudflared — АРХИТЕКТУРА §1).
 *  Прокси аппендит клиента в КОНЕЦ X-Forwarded-For, значит реальный адрес — крайний правый элемент.
 *  Левая часть спуфится клиентом и не используется (review #1). Без прокси — адрес сокета. */
export function getIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (typeof raw === 'string' && raw.length > 0) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}
