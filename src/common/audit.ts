import { db } from '../db/db';

/** Аудит юзер-безопасности (АРХИТЕКТУРА §5): auth-попытки, invite-use, rate-limit.
 *  Ошибка аудита не должна ронять сам запрос — пишем в stderr и живём дальше. */
export async function writeAudit(
  userId: string | number | null,
  ip: string,
  action: string,
  detail?: string,
): Promise<void> {
  try {
    await db.query('INSERT INTO audit_log (user_id, ip, action, detail) VALUES ($1, $2, $3, $4)', [
      userId,
      ip,
      action,
      detail ?? null,
    ]);
  } catch (e) {
    console.error('audit write failed', action, e);
  }
}
