import { Injectable } from '@nestjs/common';
import { db } from '../../db/db';
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
 *  повтор (ретрай, пересчёт) не дублирует событие. Ledger-only: правок и апдейтов нет.
 *
 *  Инвариант (review #5): при applied=false существующее событие обязано быть с теми же
 *  points. Расхождение означало бы, что одна и та же (user,event,ref)-точка начислялась
 *  разными весами — это баг логики, растущий в сумму. Не молчим: лог-инвариант в stderr. */
export async function awardDisciplinePoints(exec: Executor, a: DisciplineAward): Promise<AwardResult> {
  const r = await exec.query(
    `INSERT INTO discipline_events (user_id, event_type, ref_type, ref_id, points)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, event_type, ref_type, ref_id) DO NOTHING
     RETURNING id`,
    [a.userId, a.eventType, a.refType, a.refId, a.points],
  );
  const row = r.rows[0] as { id: string | number } | undefined;
  if (row) return { applied: true, eventId: Number(row.id) };

  // applied=false: сверяем points существующего события (review #5)
  const prev = await exec.query<{ points: number }>(
    `SELECT points FROM discipline_events
     WHERE user_id = $1 AND event_type = $2 AND ref_type = $3 AND ref_id = $4`,
    [a.userId, a.eventType, a.refType, a.refId],
  );
  const prevPoints = prev.rows[0]?.points;
  if (prevPoints === undefined) {
    console.error(`discipline invariant: ON CONFLICT no-op, но событие не найдено user=${a.userId} ${a.eventType}/${a.refType}/${a.refId}`);
  } else if (prevPoints !== a.points) {
    console.error(`discipline invariant: расхождение points user=${a.userId} ${a.eventType}/${a.refType}/${a.refId}: stored=${prevPoints} attempted=${a.points}`);
  }
  return { applied: false, eventId: null };
}

export interface DisciplineStats {
  points: number;
  events: number;
  byType: Record<string, { events: number; points: number }>;
}

/** GET /api/v1/me/stats: сумма дисциплины пользователя по ledger-у (нед2). */
export async function getDisciplineStats(exec: Executor, userId: string): Promise<DisciplineStats> {
  const total = await exec.query<{ points: number; events: number }>(
    `SELECT coalesce(sum(points), 0)::int AS points, count(*)::int AS events
     FROM discipline_events WHERE user_id = $1`,
    [userId],
  );
  const byType = await exec.query<{ event_type: string; events: number; points: number }>(
    `SELECT event_type, count(*)::int AS events, coalesce(sum(points), 0)::int AS points
     FROM discipline_events WHERE user_id = $1 GROUP BY event_type`,
    [userId],
  );
  const map: Record<string, { events: number; points: number }> = {};
  for (const r of byType.rows) map[r.event_type] = { events: r.events, points: r.points };
  return { points: total.rows[0]?.points ?? 0, events: total.rows[0]?.events ?? 0, byType: map };
}

/** Дисциплина — ledger-only. Сервис-функции выше; контроллер — только /me/stats. */
@Injectable()
export class DisciplineService {}
