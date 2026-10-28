import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';import { leagueOf, nextStep, LADDER, type SeasonMetrics } from '../src/modules/seasons/seasons.service';

/** Сезоны-рейды: лестница лиг (unit) + текущий сезон/лидерборд (e2e), окно
 *  сезона режет активность, violation-чистота нужна для золота, платина —
 *  только вручную. */

let app: INestApplication;
let base: string;
let tgSeq = 301_000;

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

interface User {
  initData: string;
  id: number;
}

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

async function get(path: string, user: User): Promise<{ status: number; body: Record<string, any> | null }> {
  const res = await fetch(`${base}${path}`, { headers: h(user) });
  let parsed: Record<string, any> | null = null;
  try {
    parsed = (await res.json()) as Record<string, any>;
  } catch {
    /* пустое тело */
  }
  return { status: res.status, body: parsed };
}

function utcDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

async function addEntry(user: User, dayOffset: number, plan = 'сетапы по журналу'): Promise<number> {
  const res = await fetch(`${base}/api/v1/journal/entries`, {
    method: 'POST',
    headers: h(user),
    body: JSON.stringify({ date: utcDate(dayOffset), plan }),
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`entry failed: ${res.status}`);
  const b = (await res.json()) as { entry: { id: number } };
  return b.entry.id;
}

async function addTrade(user: User, entryId: number, r: number): Promise<void> {
  const res = await fetch(`${base}/api/v1/journal/entries/${entryId}/trades`, {
    method: 'POST',
    headers: h(user),
    body: JSON.stringify({
      sym: 'BTCUSDT', dir: 'long', entry: 100, stop: 99, exit: r >= 0 ? 100 + r : 100 + r, r,
    }),
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`trade failed: ${res.status}`);
}

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
});

beforeEach(async () => {
  await truncateAll(db);
  // Окно S1 в тестах шире: старт −40 дней, финиш +30 — чтобы играть датами.
  await db.query(`UPDATE seasons SET starts_at = now() - interval '40 days', ends_at = now() + interval '30 days' WHERE code = 'S1'`);
});

afterAll(async () => {
  await app.close();
});

describe('unit: лестница лиг', () => {
  const m = (over: Partial<SeasonMetrics>): SeasonMetrics => ({
    user_id: '1', nick: 'x', days: 0, trades: 0, r_sum: 0, violations: 0, streak: 0, score: 0, ...over,
  });

  it('новичок — бумажная, следующий шаг деревянная (не хватает дней; R=0 уже норма)', () => {
    const zero = m({});
    expect(leagueOf(zero)).toEqual({ tier: 1, code: 'paper' });
    const n = nextStep(zero)!;
    expect(n.step.code).toBe('wooden');
    expect(n.missing).toEqual({ days: 7 });
    expect(nextStep(m({ r_sum: -0.5 }))!.missing).toEqual({ days: 7, r: 0.5 });
  });

  it('деревянная при 7 днях и R≥0', () => {
    expect(leagueOf(m({ days: 7, r_sum: 0.1 })).code).toBe('wooden');
    expect(leagueOf(m({ days: 7, r_sum: -0.5 })).code).toBe('paper'); // R отрицательный — лига не даётся
  });

  it('каменная: 21 день · R≥0.5 · стрик 5 (все три сразу)', () => {
    expect(leagueOf(m({ days: 21, r_sum: 0.5, streak: 5 })).code).toBe('stone');
    expect(leagueOf(m({ days: 21, r_sum: 0.5, streak: 4 })).code).toBe('wooden');
    expect(leagueOf(m({ days: 30, r_sum: 1.5, streak: 6 })).code).toBe('stone'); // без 50 дней железо не даётся
  });

  it('железная: 50 дней · R≥0.8 · стрик 10', () => {
    expect(leagueOf(m({ days: 50, r_sum: 0.8, streak: 10 })).code).toBe('iron');
    expect(nextStep(m({ days: 50, r_sum: 0.8, streak: 10 }))!.step.code).toBe('gold');
  });

  it('золотая требует ноль нарушений', () => {
    expect(leagueOf(m({ days: 100, r_sum: 1.2, streak: 12, violations: 0 })).code).toBe('gold');
    expect(leagueOf(m({ days: 100, r_sum: 1.2, streak: 12, violations: 1 })).code).toBe('iron');
  });

  it('платина недостижима автоматически и next после золота = null', () => {
    const g = m({ days: 200, r_sum: 3, streak: 30, violations: 0 });
    expect(leagueOf(g).code).toBe('gold');
    expect(nextStep(g)).toBeNull();
    expect(LADDER).toHaveLength(6);
  });
});

describe('e2e: сезон и таблица охоты', () => {
  it('401 без авторизации', async () => {
    const res = await fetch(`${base}/api/v1/seasons/current`);
    expect(res.status).toBe(401);
  });

  it('новичок: бумажная, rank null, journaled_today false', async () => {
    const u = await newUser();
    const r = await get('/api/v1/seasons/current', u);
    expect(r.status).toBe(200);
    expect(r.body!.season.code).toBe('S1');
    expect(r.body!.season.status).toBe('active');
    expect(r.body!.season.participants).toBe(0);
    expect(r.body!.me.days).toBe(0);
    expect(r.body!.me.league.code).toBe('paper');
    expect(r.body!.me.rank).toBeNull();
    expect(r.body!.journaled_today).toBe(false);
  });

  it('активность: дни/стрик/R в зачёте, деревянная лига, rank 1, journaled_today true', async () => {
    const u = await newUser();
    for (let d = -6; d <= 0; d++) {
      const e = await addEntry(u, d);
      if (d === -6) await addTrade(u, e, 0.3);
      if (d === -4) await addTrade(u, e, 0.4);
    }
    const r = await get('/api/v1/seasons/current', u);
    expect(r.body!.me.days).toBe(7);
    expect(r.body!.me.streak).toBe(7);
    expect(r.body!.me.r_sum).toBeCloseTo(0.7, 2);
    expect(r.body!.me.league.code).toBe('wooden');
    expect(r.body!.me.rank).toBe(1);
    expect(r.body!.season.participants).toBe(1);
    expect(r.body!.journaled_today).toBe(true);

    const lb = await get('/api/v1/seasons/leaderboard', u);
    expect(lb.body!.rows).toHaveLength(1);
    const row = lb.body!.rows[0];
    expect(row.nick).toBeTruthy();
    expect(row.me).toBe(true);
    expect(row.disc_pct).toBe(100);
  });

  it('окно сезона: записи ДО старта не в зачёте', async () => {
    const u = await newUser();
    // старт окна = −40 дней; запись за −50 — вне сезона
    const old = await addEntry(u, -50);
    await addTrade(u, old, 5);
    const r = await get('/api/v1/seasons/current', u);
    expect(r.body!.season.participants).toBe(0);
    expect(r.body!.me.days).toBe(0);
    expect(r.body!.me.r_sum).toBe(0);
  });

  it('лидерборд: сортировка по score (ΣR × доля чистых), двое участников', async () => {
    const a = await newUser();
    const b = await newUser();
    for (let d = -3; d <= -1; d++) await addEntry(a, d);
    const ea = await addEntry(a, 0);
    await addTrade(a, ea, 2);
    const eb = await addEntry(b, 0);
    await addTrade(b, eb, 1);

    const lb = await get('/api/v1/seasons/leaderboard', a);
    const rows = lb.body!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].nick).toBe('Tester'); // COALESCE(username, first_name) у тест-юзеров без username
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[1].score);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
    expect(rows[0].me).toBe(true);
    expect(rows[1].me).toBe(false);
  });

  it('score учитывает долю чистых сделок (нарушения режут множитель)', async () => {
    const u = await newUser();
    await addEntry(u, 0);
    const e = await addEntry(u, -1);
    // 2 сделки: одна чистая +1R, одна с нарушением +1R (код из codex_rules-сида)
    const codes = await db.query<{ code: string }>('SELECT code FROM codex_rules LIMIT 1');
    const vc = codes.rows[0]?.code ?? null;
    const res = await fetch(`${base}/api/v1/journal/entries/${e}/trades`, {
      method: 'POST',
      headers: h(u),
      body: JSON.stringify({ sym: 'ETHUSDT', dir: 'short', entry: 200, stop: 201, exit: 198, r: 1, violation_code: vc }),
    });
    expect([200, 201]).toContain(res.status);
    await addTrade(u, e, 1);
    const r = await get('/api/v1/seasons/current', u);
    expect(r.body!.me.trades).toBe(2);
    expect(r.body!.me.violations).toBe(1);
    // score = 2 × (1/2) = 1
    expect(r.body!.me.score).toBeCloseTo(1, 2);
  });
});
