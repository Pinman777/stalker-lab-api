import { createHmac, timingSafeEqual } from 'crypto';

/** Проверка подписи Telegram WebApp initData (HMAC-SHA256, «нет секретов наружу»).
 *  Канон invest-pool/src/tgAuth.ts: freshness auth_date ±24ч (снапшот initData
 *  в sessionStorage не бессрочен) + timing-safe сверка (crypto.timingSafeEqual). */
export function verifyInitData(initData: string, botToken: string): Record<string, string> | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.keys()].sort().map((k) => `${k}=${params.get(k)}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secret).update(dataCheckString).digest();
  const a = computed;
  const b = Buffer.from(hash, 'hex'); // невалидный hex → короткий буфер → отвал по длине
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const out: Record<string, string> = {};
  params.forEach((v, k) => (out[k] = v));
  // Freshness ±24ч: повтор старого снапшота initData невозможен после суток
  const ad = Number(out.auth_date || 0);
  if (!ad || Math.abs(Date.now() / 1000 - ad) > 86_400) return null;
  return out;
}

/** Данные юзера из подписанного поля user (JSON). */
export interface TgUser {
  id: number;
  firstName: string | null;
  username: string | null;
  languageCode: string | null;
}

export function parseTgUser(fields: Record<string, string>): TgUser | null {
  const raw = fields.user;
  if (!raw) return null;
  let u: unknown;
  try {
    u = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof u !== 'object' || u === null) return null;
  const r = u as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    firstName: typeof r.first_name === 'string' ? r.first_name : null,
    username: typeof r.username === 'string' ? r.username : null,
    languageCode: typeof r.language_code === 'string' ? r.language_code : null,
  };
}
