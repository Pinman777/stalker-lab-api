import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { Executor } from '../../db/db';

/** INVITE-ONLY: коды одноразовые. Погашение — условный UPDATE внутри tx создания юзера:
 *  два конкурирующих auth на один код — второй получает rowCount 0 (row lock + re-check) → 403.
 *  Нед3: погашение возвращает created_by кода — вход по r_-коду юзера X создаёт
 *  реферальную привязку (referrals, см. identity.service). */
export interface ConsumeResult {
  ok: boolean;
  referrerUid: string | null; // владелец кода (NULL у CLI/бутстрап-кодов) — для referrals
}

export async function consumeInviteCode(c: Executor, code: string, userId: string): Promise<ConsumeResult> {
  const r = await c.query<{ created_by: string | null }>(
    'UPDATE invite_codes SET used_by = $2, used_at = now() WHERE code = $1 AND used_by IS NULL RETURNING created_by',
    [code, userId],
  );
  if (!r.rowCount) return { ok: false, referrerUid: null };
  return { ok: true, referrerUid: r.rows[0].created_by === null ? null : String(r.rows[0].created_by) };
}

/** Генерация кода (CLI scripts/make-invite.ts). createdBy = users.id | NULL (бутстрап). */
export async function createInviteCode(exec: Executor, createdBy: string | null, quota = 1): Promise<string> {
  const code = randomBytes(9).toString('base64url'); // 12 символов
  await exec.query('INSERT INTO invite_codes (code, created_by, quota) VALUES ($1, $2, $3)', [code, createdBy, quota]);
  return code;
}

@Injectable()
export class InvitesService {
  consume(c: Executor, code: string, userId: string): Promise<ConsumeResult> {
    return consumeInviteCode(c, code, userId);
  }
}
