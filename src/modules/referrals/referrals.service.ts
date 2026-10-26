import { randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { db } from '../../db/db';
import type { Executor } from '../../db/db';
import { errors } from '../../common/errors';

/** Рефералка (нед3, анти-MLM канон): только счётчики приглашённых — никаких оборотов/комиссий.
 *  Юзер сам генерит r_-инвайты (продолжение INVITE-ONLY нед1); вход по r_-коду юзера X
 *  в момент регистрации пишет строку в referrals (см. identity.service, та же tx). */

/** Лимит АКТИВНЫХ (не погашенных) инвайтов юзера. Ранг вырастет — лимит вырастет (потом). */
export const ACTIVE_INVITE_LIMIT = 3;

/** Алфавит без омоглифов 0/O, 1/l — код диктуют в голос, ошибка дорого стоит. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export interface ReferralDto {
  username: string | null;
  first_name: string | null;
  joined_at: string;
  is_active_journal: boolean;
}

export interface ReferralsDto {
  invited: ReferralDto[];
  count: number;
}

/** Привязка реферала — внутри tx создания юзера (identity.service). PK = invited_uid:
 *  у приглашённого ровно один реферер, повторная вставка невозможна по построению. */
export async function insertReferral(
  c: Executor,
  invitedUid: string,
  referrerUid: string,
  inviteCode: string,
): Promise<void> {
  await c.query(
    'INSERT INTO referrals (invited_uid, referrer_uid, invite_code) VALUES ($1, $2, $3)',
    [invitedUid, referrerUid, inviteCode],
  );
}

@Injectable()
export class ReferralsService {
  /** POST /referrals/invite: свой код 'r_' + 8 символов. Лимит активных — 3 (409 invite_limit_reached).
   *  Коллизия кода (PK) практически исключена (35^8), но честно ретраится. */
  async generateInvite(userId: string): Promise<string> {
    return db.tx(async (c) => {
      const active = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM invite_codes WHERE created_by = $1 AND used_by IS NULL',
        [userId],
      );
      if ((active.rows[0]?.n ?? 0) >= ACTIVE_INVITE_LIMIT) throw errors.inviteLimitReached();

      for (let attempt = 0; attempt < 5; attempt++) {
        const code =
          'r_' + Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
        try {
          await c.query('INSERT INTO invite_codes (code, created_by, quota) VALUES ($1, $2, 1)', [code, userId]);
          return code;
        } catch (e: unknown) {
          if ((e as { code?: string }).code !== '23505') throw e; // редкая коллизия → новый код
        }
      }
      throw errors.inviteLimitReached(); // недостижимо на практике; честный выход из цикла
    });
  }

  /** GET /referrals: свои приглашённые (username/имя, дата, активность в журнале). Только счётчики. */
  async listReferrals(userId: string): Promise<ReferralsDto> {
    const r = await db.query<{
      username: string | null;
      first_name: string | null;
      joined_at: Date;
      is_active_journal: boolean;
    }>(
      `SELECT u.username, u.first_name, r.created_at AS joined_at,
              EXISTS (SELECT 1 FROM journal_entries e WHERE e.user_id = r.invited_uid) AS is_active_journal
       FROM referrals r
       JOIN users u ON u.id = r.invited_uid
       WHERE r.referrer_uid = $1
       ORDER BY r.created_at`,
      [userId],
    );
    return {
      invited: r.rows.map((row) => ({
        username: row.username,
        first_name: row.first_name,
        joined_at: row.joined_at.toISOString(),
        is_active_journal: row.is_active_journal,
      })),
      count: r.rows.length,
    };
  }
}
