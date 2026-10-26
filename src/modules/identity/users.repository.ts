import type { Executor } from '../../db/db';
import type { TgUser } from '../../common/tg-auth';

/** BIGINT из pg приходит строкой — id храним как string, наружу отдаём Number (telegram_id < 2^53). */
export interface UserRow {
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  language: string;
  timezone: string | null;
  is_blocked: boolean;
  created_at: Date;
}

export interface UserDto {
  id: number;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  language: string;
  timezone: string | null;
  createdAt: string;
}

export function toUserDto(u: UserRow): UserDto {
  return {
    id: Number(u.id),
    telegramId: Number(u.telegram_id),
    username: u.username,
    firstName: u.first_name,
    language: u.language,
    timezone: u.timezone,
    createdAt: u.created_at.toISOString(),
  };
}

export async function findUserByTelegramId(exec: Executor, telegramId: number): Promise<UserRow | null> {
  const r = await exec.query('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [telegramId]);
  return (r.rows[0] as UserRow | undefined) ?? null;
}

/** Создание юзера — только внутри tx с погашенным инвайтом (identity.service). */
export async function insertUser(c: Executor, tg: TgUser): Promise<UserRow> {
  const r = await c.query(
    `INSERT INTO users (telegram_id, username, first_name, language)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tg.id, tg.username, tg.firstName, tg.languageCode || 'en'],
  );
  return r.rows[0] as UserRow;
}
