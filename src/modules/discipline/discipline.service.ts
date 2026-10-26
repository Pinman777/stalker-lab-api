import type { Executor } from '../../db/db';

export interface DisciplineAward {
  userId: string;
  eventType: string;
  refType: string;
  refId: number | string;
  points: number;
}

export interface AwardResult {
  applied: boolean;
  eventId: number | null;
}

/** Идемпотентное начисление баллов (нед1, задача 5):
 *  UNIQUE(user_id, event_type, ref_type, ref_id) + ON CONFLICT DO NOTHING —
 *  повтор (ретрай, пересчёт) не дублирует событие. Ledger-only: правок и апдейтов нет. */
export async function awardDisciplinePoints(exec: Executor, a: DisciplineAward): Promise<AwardResult> {
  const r = await exec.query(
    `INSERT INTO discipline_events (user_id, event_type, ref_type, ref_id, points)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, event_type, ref_type, ref_id) DO NOTHING
     RETURNING id`,
    [a.userId, a.eventType, a.refType, a.refId, a.points],
  );
  const row = r.rows[0] as { id: string | number } | undefined;
  return { applied: !!row, eventId: row ? Number(row.id) : null };
}
