import { db } from '../src/db/db';
import { awardDisciplinePoints } from '../src/modules/discipline/discipline.service';
import { ensureTestDb, resetSchema } from './helpers';

/** Дисциплина (нед1, задача 5): идемпотентность начисления по UNIQUE-ключу. */

let userId: string;

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  const r = await db.query('INSERT INTO users (telegram_id) VALUES ($1) RETURNING id', [555_001n]);
  userId = String(r.rows[0].id);
});

afterAll(async () => {
  await db.end();
});

it('повторное начисление с тем же ключом → applied=false, событие и баллы не дублируются', async () => {
  const award = { userId, eventType: 'journal_violation', refType: 'journal_trade', refId: 42, points: -2 };
  const first = await awardDisciplinePoints(db, award);
  const retry = await awardDisciplinePoints(db, award);
  expect(first.applied).toBe(true);
  expect(first.eventId).not.toBeNull();
  expect(retry.applied).toBe(false);
  expect(retry.eventId).toBeNull();

  const stats = await db.query<{ cnt: number; total: number }>(
    'SELECT count(*)::int AS cnt, coalesce(sum(points), 0)::int AS total FROM discipline_events',
  );
  expect(stats.rows[0].cnt).toBe(1);
  expect(stats.rows[0].total).toBe(-2);
});

it('другой ref_id → отдельное событие (applied=true)', async () => {
  const r = await awardDisciplinePoints(db, {
    userId,
    eventType: 'journal_violation',
    refType: 'journal_trade',
    refId: 43,
    points: -2,
  });
  expect(r.applied).toBe(true);
  const stats = await db.query<{ cnt: number }>('SELECT count(*)::int AS cnt FROM discipline_events');
  expect(stats.rows[0].cnt).toBe(2);
});
