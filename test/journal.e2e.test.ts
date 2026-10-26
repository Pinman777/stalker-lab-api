import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';

/** E2E журнал (нед2): CRUD сессий+сделок, UNIQUE(user_id,date), чужая сессия 403,
 *  закрытая сессия 403 на trade, дисциплина из журнала идемпотентна, violation без баллов,
 *  фильтр дат, /me/stats. */

let app: INestApplication;
let base: string;

interface User {
  initData: string;
  id: number;
}

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

let tgSeq = 202_000;

/** Юзер через полный путь: initData + инвайт (rate-limiter — свежий IP). */
async function newUser(): Promise<User> {
  const code = await createInviteCode(db, null, 1);
  const initData = signInitData(tgUserJson(++tgSeq));
  const res = await fetch(`${base}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ initData, inviteCode: code }),
  });
  if (res.status !== 200) throw new Error(`newUser auth failed: ${res.status}`);
  const body = (await res.json()) as { user: { id: number } };
  return { initData, id: body.user.id };
}

function h(u: User): Record<string, string> {
  return { 'content-type': 'application/json', 'x-telegram-init-data': u.initData };
}

async function call(
  method: string,
  path: string,
  user: User,
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: Record<string, any> | null = null;
  try {
    parsed = (await res.json()) as Record<string, any>;
  } catch {
    /* пустое тело */
  }
  return { status: res.status, body: parsed };
}

async function stats(user: User): Promise<Record<string, any>> {
  const r = await call('GET', '/api/v1/me/stats', user);
  expect(r.status).toBe(200);
  return r.body!;
}

const D1 = '2030-01-15';
const D2 = '2030-01-16';

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
});

afterAll(async () => {
  await app.close(); // AppModule.onApplicationShutdown → db.end()
});

beforeEach(async () => {
  await truncateAll(db);
});

// --- POST /entries: сессия-вылазка ---

it('создание сессии → 201, entry в ответе, journal_entry(+5) начислен', async () => {
  const u = await newUser();
  const r = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'Разведка BTC на открытии' });
  expect(r.status).toBe(201);
  expect(r.body?.entry?.date).toBe(D1);
  expect(r.body?.entry?.status).toBe('draft');
  expect(r.body?.entry?.review).toBeNull();
  const ev = await db.query(
    `SELECT points FROM discipline_events WHERE user_id = $1 AND event_type = 'journal_entry'`,
    [u.id],
  );
  expect(ev.rowCount).toBe(1);
  expect(ev.rows[0].points).toBe(5);
});

it('вторая сессия в тот же день → 409 entry_exists, дубля события нет', async () => {
  const u = await newUser();
  const first = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'a' });
  const dup = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'b' });
  expect(first.status).toBe(201);
  expect(dup.status).toBe(409);
  expect(dup.body?.error).toBe('entry_exists');
  const cnt = await db.query('SELECT count(*)::int AS n FROM journal_entries WHERE user_id = $1', [u.id]);
  expect(cnt.rows[0].n).toBe(1);
  const ev = await db.query('SELECT count(*)::int AS n FROM discipline_events');
  expect(ev.rows[0].n).toBe(1);
});

it('битый body (нет plan / кривая дата / 31 февраля) → 400 invalid_request', async () => {
  const u = await newUser();
  expect((await call('POST', '/api/v1/journal/entries', u, { date: D1 })).status).toBe(400);
  expect((await call('POST', '/api/v1/journal/entries', u, { date: '2030-1-5', plan: 'x' })).status).toBe(400);
  expect((await call('POST', '/api/v1/journal/entries', u, { date: '2030-02-31', plan: 'x' })).status).toBe(400);
  expect((await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: '   ' })).status).toBe(400);
});

// --- POST /entries/:id/trades ---

it('сделка в свою открытую сессию → 201, journal_trade(+5)', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  const r = await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, {
    sym: 'BTCUSDT', dir: 'long', entry: 100000.5, stop: 99000, exit: 102000, r: 2, setup: 'squeeze',
  });
  expect(r.status).toBe(201);
  expect(r.body?.trade?.sym).toBe('BTCUSDT');
  expect(r.body?.trade?.dir).toBe('long');
  expect(r.body?.trade?.entry).toBe(100000.5);
  expect(r.body?.trade?.r).toBe(2);
  expect(r.body?.trade?.violationCode).toBeNull();
  const s = await stats(u);
  expect(s.points).toBe(10); // entry 5 + trade 5
  expect(s.byType.journal_trade).toEqual({ events: 1, points: 5 });
});

it('сделка с violation_code из каталога → 201, БЕЗ баллов, запись в audit', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  const r = await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, {
    sym: 'ETHUSDT', dir: 'short', entry: 3000, stop: 3050, exit: 2900, r: 2, violation_code: 'risk_moved',
  });
  expect(r.status).toBe(201);
  expect(r.body?.trade?.violationCode).toBe('risk_moved');
  const ev = await db.query(
    `SELECT count(*)::int AS n FROM discipline_events WHERE user_id = $1 AND event_type = 'journal_trade'`,
    [u.id],
  );
  expect(ev.rows[0].n).toBe(0); // нарушение кодекса = сделка есть, баллов нет
  const audit = await db.query(
    `SELECT detail FROM audit_log WHERE user_id = $1 AND action = 'codex_violation'`,
    [u.id],
  );
  expect(audit.rowCount).toBe(1);
  expect(String(audit.rows[0].detail)).toContain('risk_moved');
});

it('неизвестный violation_code → 400 unknown_violation_code, сделки нет', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  const r = await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, {
    sym: 'X', dir: 'long', entry: 1, stop: 0.5, exit: 2, violation_code: 'not_in_codex',
  });
  expect(r.status).toBe(400);
  expect(r.body?.error).toBe('unknown_violation_code');
  expect((await db.query('SELECT count(*)::int AS n FROM journal_trades')).rows[0].n).toBe(0);
});

it('сделка в ЧУЖУЮ сессию → 403 forbidden, строки нет', async () => {
  const owner = await newUser();
  const intruder = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', owner, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  const r = await call('POST', `/api/v1/journal/entries/${entryId}/trades`, intruder, {
    sym: 'BTCUSDT', dir: 'long', entry: 1, stop: 0.5, exit: 2,
  });
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('forbidden');
  expect((await db.query('SELECT count(*)::int AS n FROM journal_trades')).rows[0].n).toBe(0);
  // нарушителю ничего не начислено (у него вообще нет событий)
  const s = await stats(intruder);
  expect(s.points).toBe(0);
  expect(s.byType.journal_trade).toBeUndefined();
});

it('сделка в несуществующую сессию → 404 not_found', async () => {
  const u = await newUser();
  const r = await call('POST', '/api/v1/journal/entries/999999/trades', u, {
    sym: 'X', dir: 'long', entry: 1, stop: 0.5, exit: 2,
  });
  expect(r.status).toBe(404);
  expect(r.body?.error).toBe('not_found');
});

it('невалидная сделка (dir/цены/числа) → 400', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  const base = { sym: 'BTCUSDT', entry: 100, stop: 90, exit: 120 };
  expect((await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, { ...base, dir: 'buy' })).status).toBe(400);
  expect((await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, { ...base, dir: 'long', entry: -5 })).status).toBe(400);
  expect((await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, { ...base, dir: 'long', stop: 'abc' })).status).toBe(400);
  expect((await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, { ...base, dir: 'long', r: 'abc' })).status).toBe(400);
  expect((await db.query('SELECT count(*)::int AS n FROM journal_trades')).rows[0].n).toBe(0);
});

// --- PATCH /entries/:id — разбор дня закрывает сессию ---

it('разбор дня → 200 закрыта, journal_review(+3); тотал 5+5+3=13', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, { sym: 'BTCUSDT', dir: 'long', entry: 1, stop: 0.5, exit: 2 });

  const r = await call('PATCH', `/api/v1/journal/entries/${entryId}`, u, { review: 'Зона отработала чисто', status: 'closed' });
  expect(r.status).toBe(200);
  expect(r.body?.entry?.status).toBe('closed');
  expect(r.body?.entry?.review).toBe('Зона отработала чисто');

  const s = await stats(u);
  expect(s.points).toBe(13);
  expect(s.events).toBe(3);
  expect(s.byType).toEqual({
    journal_entry: { events: 1, points: 5 },
    journal_trade: { events: 1, points: 5 },
    journal_review: { events: 1, points: 3 },
  });
});

it('сделка в ЗАКРЫТУЮ сессию → 403 entry_closed', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  await call('PATCH', `/api/v1/journal/entries/${entryId}`, u, { review: 'done', status: 'closed' });
  const r = await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, {
    sym: 'X', dir: 'long', entry: 1, stop: 0.5, exit: 2,
  });
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('entry_closed');
});

it('повторное закрытие → 409 entry_closed, review-баллы не дублируются', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  await call('PATCH', `/api/v1/journal/entries/${entryId}`, u, { review: 'one', status: 'closed' });
  const again = await call('PATCH', `/api/v1/journal/entries/${entryId}`, u, { review: 'two', status: 'closed' });
  expect(again.status).toBe(409);
  expect(again.body?.error).toBe('entry_closed');
  const ev = await db.query(
    `SELECT count(*)::int AS n FROM discipline_events WHERE user_id = $1 AND event_type = 'journal_review'`,
    [u.id],
  );
  expect(ev.rows[0].n).toBe(1);
});

it('закрытие ЧУЖОЙ сессии → 403 forbidden', async () => {
  const owner = await newUser();
  const intruder = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', owner, { date: D1, plan: 'plan' });
  const r = await call('PATCH', `/api/v1/journal/entries/${e.body!.entry.id}`, intruder, { review: 'x', status: 'closed' });
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('forbidden');
  const row = await db.query('SELECT status FROM journal_entries WHERE id = $1', [e.body!.entry.id]);
  expect(row.rows[0].status).toBe('draft');
});

it('PATCH без status:closed → 400 (другие переходы не поддерживаются)', async () => {
  const u = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const r = await call('PATCH', `/api/v1/journal/entries/${e.body!.entry.id}`, u, { review: 'x', status: 'draft' });
  expect(r.status).toBe(400);
});

// --- GET /entries?from&to, GET /entries/:id ---

it('список: только свои, от новых к старым, tradesCount; from/to фильтруют включительно', async () => {
  const u1 = await newUser();
  const u2 = await newUser();
  await call('POST', '/api/v1/journal/entries', u1, { date: '2030-03-01', plan: 'c' });
  const mid = (await call('POST', '/api/v1/journal/entries', u1, { date: '2030-03-10', plan: 'b' })).body!.entry.id;
  await call('POST', '/api/v1/journal/entries', u1, { date: '2030-03-20', plan: 'a' });
  await call('POST', `/api/v1/journal/entries/${mid}/trades`, u1, { sym: 'X', dir: 'long', entry: 1, stop: 0.5, exit: 2 });
  await call('POST', '/api/v1/journal/entries', u2, { date: '2030-03-15', plan: 'чужой день' });

  const all = await call('GET', '/api/v1/journal/entries', u1);
  expect(all.status).toBe(200);
  expect(all.body!.entries.map((x: any) => x.date)).toEqual(['2030-03-20', '2030-03-10', '2030-03-01']); // DESC
  expect(all.body!.entries.find((x: any) => x.id === mid).tradesCount).toBe(1);

  const ranged = await call('GET', '/api/v1/journal/entries?from=2030-03-05&to=2030-03-15', u1);
  expect(ranged.body!.entries.map((x: any) => x.date)).toEqual(['2030-03-10']);

  const fromOnly = await call('GET', '/api/v1/journal/entries?from=2030-03-10', u1);
  expect(fromOnly.body!.entries.map((x: any) => x.date)).toEqual(['2030-03-20', '2030-03-10']);

  expect((await call('GET', '/api/v1/journal/entries?from=2030-03-15&to=2030-03-05', u1)).status).toBe(400); // from > to
  expect((await call('GET', '/api/v1/journal/entries?from=knock-knock', u1)).status).toBe(400);
});

it('детали сессии: свои trades внутри; чужая → 403; несуществующая → 404', async () => {
  const u = await newUser();
  const other = await newUser();
  const e = await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'plan' });
  const entryId = e.body!.entry.id;
  await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, { sym: 'BTCUSDT', dir: 'long', entry: 1, stop: 0.5, exit: 2 });
  await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, { sym: 'ETHUSDT', dir: 'short', entry: 3, stop: 3.5, exit: 2.5 });

  const own = await call('GET', `/api/v1/journal/entries/${entryId}`, u);
  expect(own.status).toBe(200);
  expect(own.body!.entry.id).toBe(entryId);
  expect(own.body!.trades).toHaveLength(2);
  expect(own.body!.trades[0].sym).toBe('BTCUSDT');
  expect(own.body!.trades[1].sym).toBe('ETHUSDT');

  expect((await call('GET', `/api/v1/journal/entries/${entryId}`, other)).status).toBe(403);
  expect((await call('GET', '/api/v1/journal/entries/424242', u)).status).toBe(404);
  expect((await call('GET', '/api/v1/journal/entries/abc', u)).status).toBe(400);
});

// --- дисциплина: идемпотентность через журнал ---

it('дисциплина из журнала идемпотентна: ретрай начисления тем же ключом — no-op', async () => {
  const u = await newUser();
  await call('POST', '/api/v1/journal/entries', u, { date: D1, plan: 'a' });
  // прямая проверка механики: тот же (user,event,ref) повторно → applied=false
  const { awardDisciplinePoints } = await import('../src/modules/discipline/discipline.service');
  const e = await db.query<{ ref_id: string }>(
    `SELECT ref_id FROM discipline_events WHERE user_id = $1 AND event_type = 'journal_entry'`,
    [u.id],
  );
  const retry = await awardDisciplinePoints(db, {
    userId: String(u.id), eventType: 'journal_entry', refType: 'journal', refId: Number(e.rows[0].ref_id), points: 5,
  });
  expect(retry.applied).toBe(false);
  const s = await stats(u);
  expect(s.points).toBe(5);
  expect(s.events).toBe(1);
});
