import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { Executor } from '../../db/db';

/** INVITE-ONLY: коды одноразовые. Погашение — условный UPDATE внутри tx создания юзера:
 *  два конкурирующих auth на один код — второй получает rowCount 0 (row lock + re-check) → 403. */
export async function consumeInviteCode(c: Executor, code: string, userId: string): Promise<boolean> {
  const r = await c.query(
    'UPDATE invite_codes SET used_by = $2, used_at = now() WHERE code = $1 AND used_by IS NULL',
    [code, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Генерация кода (CLI scripts/make-invite.ts). createdBy = users.id | NULL (бутстрап). */
export async function createInviteCode(exec: Executor, createdBy: string | null, quota = 1): Promise<string> {
  const code = randomBytes(9).toString('base64url'); // 12 символов
  await exec.query('INSERT INTO invite_codes (code, created_by, quota) VALUES ($1, $2, $3)', [code, createdBy, quota]);
  return code;
}

@Injectable()
export class InvitesService {
  consume(c: Executor, code: string, userId: string): Promise<boolean> {
    return consumeInviteCode(c, code, userId);
  }
}
