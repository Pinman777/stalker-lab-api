import { createHmac, timingSafeEqual } from 'crypto';

/** JWT HS256 на builtin crypto — без зависимости jsonwebtoken (stdlib-first).
 *  Использование: web-login токены {tg, exp} (нед5), секрет env JWT_SECRET. */

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Подпись сошлась + не протух (exp обязателен, в секундах) → payload; иначе null. */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url'); // битый base64url → мусорный буфер → отвал по длине
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

function b64url(input: Buffer): string {
  return input.toString('base64url');
}
