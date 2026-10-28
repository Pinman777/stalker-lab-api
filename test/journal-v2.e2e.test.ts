import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';

/** Вылазки v2 (013): статусная машина armed → entered → closed (+cancelled),
 *  R считается бэком, вход по рынку оверрайдит цену, план дня в plan_meta. */

let app: INestApplication;
let base: string;
let tgSeq = 601_000;

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
  const body = (await res.json()) as { user: { id: number } };
  return { initData, id: body.user.id };
}

function h(u: User): Record<string, string> {
  return { 'content-type': 'application/json', 'x-telegram-init-data': u.initData };
}

async function call(method: string, path: string, user: User, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: Record<string, any> | null = null;
  try {
    parsed = (await res.json()) as Record<string, any>;
  } catch {
    /* пусто */
  }
  return { status: res.status, body: parsed };
}

function utcDate(offsetDays: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays))
    .toISOString()
    .slice(0, 10);
}

async function openDay(u: User, planMeta?: unknown): Promise<number> {
  const r = await call('POST', '/api/v1/journal/entries', u, {
    date: utcDate(0), plan: 'план', ...(planMeta ? { plan_meta: planMeta } : {}),
  });
  expect(r.status).toBe(201);
  return r.body!.entry.id as number;
}

async function arm(u: User, entryId: number, over?: Record<string, unknown>): Promise<number> {
  const r = await call('POST', `/api/v1/journal/entries/${entryId}/trades`, u, {
    sym: 'BTC', dir: 'long', entry: 100, stop: 95, take_profit: 115, notional_usd: 2000, risk_usd: 100, risk_pct: 1, setup: 'пробой', ...over,
  });
  expect(r.status).toBe(201);
  return r.body!.trade.id as number;
}

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await app.close();
});

describe('вылазки v2: статусная машина', () => {
  it('сетап без exit → armed (exit null, r null, тейк/калькулятор сохранены)', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day);
    const r = await call('GET', `/api/v1/journal/entries/${day}`, u);
    const tr = r.body!.trades[0];
    expect(tr.status).toBe('armed');
    expect(tr.exit).toBeNull();
    expect(tr.r).toBeNull();
    expect(tr.takeProfit).toBe(115);
    expect(tr.notionalUsd).toBe(2000);
    expect(tr.enteredAt).toBeNull();
  });

  it('вход по рынку оверрайдит цену и фиксирует время', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day);
    const r = await call('POST', `/api/v1/journal/trades/${t}/enter`, u, { price: 101.5 });
    expect(r.status).toBe(200);
    expect(r.body!.trade.status).toBe('entered');
    expect(r.body!.trade.entry).toBe(101.5);
    expect(r.body!.trade.enteredAt).not.toBeNull();
  });

  it('закрытие по стопу: R = −1 авто, баллы начислены', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day);
    await call('POST', `/api/v1/journal/trades/${t}/enter`, u, { price: 100 });
    const r = await call('POST', `/api/v1/journal/trades/${t}/close`, u, { exit_price: 95, kind: 'stop' });
    expect(r.status).toBe(200);
    expect(r.body!.trade.status).toBe('closed');
    expect(r.body!.trade.r).toBe(-1);
    expect(r.body!.trade.exitKind).toBe('stop');
    const pts = await db.query<{ sum: string }>(
      `SELECT coalesce(sum(points),0)::text AS sum FROM discipline_events
       WHERE user_id = $1 AND event_type = 'journal_trade'`, [String(u.id)],
    );
    expect(Number(pts.rows[0].sum)).toBe(5);
  });

  it('закрытие по тейку: R = R:R сетапа (лонг 100→115, стоп 95 → +3R)', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day);
    await call('POST', `/api/v1/journal/trades/${t}/enter`, u, { price: 100 });
    const r = await call('POST', `/api/v1/journal/trades/${t}/close`, u, { exit_price: 115, kind: 'take' });
    expect(r.body!.trade.r).toBe(3);
  });

  it('шорт: R считается зеркально (вход 100, стоп 105, выход 92.5 → +1.5R)', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day, { dir: 'short', stop: 105, take_profit: 85 });
    await call('POST', `/api/v1/journal/trades/${t}/enter`, u, { price: 100 });
    const r = await call('POST', `/api/v1/journal/trades/${t}/close`, u, { exit_price: 92.5, kind: 'manual' });
    expect(r.body!.trade.r).toBe(1.5);
  });

  it('отмена сетапа: cancelled +3 (честный отказ)', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day);
    const r = await call('POST', `/api/v1/journal/trades/${t}/cancel`, u);
    expect(r.status).toBe(200);
    expect(r.body!.trade.status).toBe('cancelled');
    const pts = await db.query<{ sum: string }>(
      `SELECT coalesce(sum(points),0)::text AS sum FROM discipline_events
       WHERE user_id = $1 AND event_type = 'setup_cancel'`, [String(u.id)],
    );
    expect(Number(pts.rows[0].sum)).toBe(3);
  });

  it('машина состояний: armed нельзя закрыть мимо enter (409), повторный enter — 409', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day);
    const c1 = await call('POST', `/api/v1/journal/trades/${t}/close`, u, { exit_price: 110, kind: 'manual' });
    expect(c1.status).toBe(409);
    expect(c1.body!.error).toBe('invalid_trade_state');
    await call('POST', `/api/v1/journal/trades/${t}/enter`, u, { price: 100 });
    const e2 = await call('POST', `/api/v1/journal/trades/${t}/enter`, u, { price: 101 });
    expect(e2.status).toBe(409);
  });

  it('закрытие с нарушением кодекса: без баллов, нарушение записано', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const t = await arm(u, day);
    await call('POST', `/api/v1/journal/trades/${t}/enter`, u, { price: 100 });
    const rules = await db.query<{ code: string }>('SELECT code FROM codex_rules LIMIT 1');
    const vc = rules.rows[0].code;
    const r = await call('POST', `/api/v1/journal/trades/${t}/close`, u, { exit_price: 90, kind: 'manual', violation_code: vc });
    expect(r.status).toBe(200);
    expect(r.body!.trade.violationCode).toBe(vc);
    const pts = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM discipline_events WHERE user_id = $1 AND event_type = 'journal_trade'`, [String(u.id)],
    );
    expect(pts.rows[0].n).toBe(0);
  });

  it('чужой сетап: enter → 403/404, не трогается', async () => {
    const a = await newUser();
    const b = await newUser();
    const day = await openDay(a);
    const t = await arm(a, day);
    const r = await call('POST', `/api/v1/journal/trades/${t}/enter`, b, { price: 100 });
    expect([403, 404]).toContain(r.status);
  });

  it('легаси-регистрация с exit: сразу closed + R авто если не передан', async () => {
    const u = await newUser();
    const day = await openDay(u);
    const r = await call('POST', `/api/v1/journal/entries/${day}/trades`, u, {
      sym: 'ETH', dir: 'long', entry: 2000, stop: 1980, exit: 2050, setup: 'ретест',
    });
    expect(r.status).toBe(201);
    expect(r.body!.trade.status).toBe('closed');
    expect(r.body!.trade.r).toBe(2.5); // (2050−2000)/(2000−1980)
    expect(r.body!.trade.closedAt).not.toBeNull();
  });

  it('план дня: plan_meta валидируется, хранится и возвращается', async () => {
    const u = await newUser();
    const r = await call('POST', '/api/v1/journal/entries', u, {
      date: utcDate(0), plan: 'план',
      plan_meta: { mode: 'trend', risk_day_r: 2, max_trades: 2, watchlist: ['BTC', 'ETH'], no_go: 'не торгую до 14:00', junk: 'отброшено' },
    });
    expect(r.status).toBe(201);
    const list = await call('GET', '/api/v1/journal/entries', u);
    const meta = list.body!.entries[0].planMeta;
    expect(meta.mode).toBe('trend');
    expect(meta.riskDayR).toBe(2);
    expect(meta.maxTrades).toBe(2);
    expect(meta.watchlist).toEqual(['BTC', 'ETH']);
    expect(meta.noGo).toBe('не торгую до 14:00');
    expect(meta.junk).toBeUndefined();
  });

  it('GET /journal/codex: правила для UI-селекта', async () => {
    const u = await newUser();
    const r = await call('GET', '/api/v1/journal/codex', u);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body!.rules)).toBe(true);
    expect(r.body!.rules.length).toBeGreaterThan(0);
    expect(r.body!.rules[0].code).toBeTruthy();
  });
});
