/** Конфиг из env. Читается один раз при импорте.
 *  BOT_TOKEN обязателен (подпись initData); DATABASE_URL опционален —
 *  локально без неё unix socket + peer auth (канон invest-pool/src/db.ts). */
export const config = {
  port: Number(process.env.PORT || 8910),
  botToken: process.env.BOT_TOKEN || '',
  databaseUrl: process.env.DATABASE_URL || '',
} as const;
