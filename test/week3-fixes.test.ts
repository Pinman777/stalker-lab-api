import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll, TEST_DB } from './helpers';

/** Фиксы ревью нед2 (нед3):
 *  1) FOR SHARE на строке сессии перед INSERT сделки — закрытие блокируется, пока
 *     живёт tx сделки (сериализуемая проверка двух параллельных close+trade);
 *  2) guard-отказы через authRateLimiter — спам не заливает audit_log;
 *  3) clamp будущей даты: date > today+1d (UTC) → 400, прошлые свободны. */

let app: INestApplication;
let base: string;

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

let tgSeq = 205_000;

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
  if (res.status !== 200) throw new Error(`newUser failed: ${res.status}`);
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

function utcDate(offsetDays: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays))
    .toISOString()
    .slice(0, 10);
}

const TRADE = { sym: 'BTCUSDT', dir: 'long', entry: 100, stop: 99, exit: 103, r: 3, setup: 'fix-week3' } as const;

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

// --- фикс 1: FOR SHARE против гонки trade-против-закрытия ---

it('гонка: пока tx сделки держит FOR SHARE, закрытие сессии БЛОКИРУЕТСЯ; после релиза — проходит', async () => {
  const u = await newUser();
  const entry = (await call('POST', '/api/v1/journal/entries', u, { date: utcDate(0), plan: 'p' })).body!.entry as { id: number };

  // «tx сделки»: держим FOR SHARE на открытой сессии из отдельного соединения
  const holder = new Client({ user: 'zeon', host: '/var/run/postgresql', database: TEST_DB });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    const lock = await holder.query(
      `SELECT 1 FROM journal_entries WHERE id = $1 AND user_id = $2 AND status = 'draft' FOR SHARE`,
      [entry.id, u.id],
    );
    expect(lock.rowCount).toBe(1); // лок взят — это ровно то, что делает addTrade перед INSERT

    // параллельное закрытие обязано ждать
    const closing = call('PATCH', `/api/v1/journal/entries/${entry.id}`, u, { review: 'r', status: 'closed' });
    await new Promise((r) => setTimeout(r, 700)); // время на дойти до UPDATE и упереться в лок
    let settled = false;
    settled = (await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
    ])) as boolean;
    expect(settled).toBe(false); // закрытие висит на row lock — гонка исключена

    await holder.query('COMMIT'); // сделка «закончилась» — закрытие проходит
    const closed = await closing;
    expect(closed.status).toBe(200);
    expect(closed.body!.entry.status).toBe('closed');
  } finally {
    await holder.end();
  }
});

it('гонка: два параллельных HTTP close+trade — итоговое состояние всегда консистентно', async () => {
  const u = await newUser();
  const entry = (await call('POST', '/api/v1/journal/entries', u, { date: utcDate(0), plan: 'p' })).body!.entry as { id: number };

  const [closeRes, tradeRes] = await Promise.all([
    call('PATCH', `/api/v1/journal/entries/${entry.id}`, u, { review: 'r', status: 'closed' }),
    call('POST', `/api/v1/journal/entries/${entry.id}/trades`, u, TRADE),
  ]);

  // варианты: (trade 200, close 200) — сделка раньше; (close 200, trade 403) — закрытие раньше
  expect([200, 409]).toContain(closeRes.status);
  if (closeRes.status === 200 && tradeRes.status === 200) {
    // сделка закоммитилась ДО закрытия — она валидна и видна
    const detail = await call('GET', `/api/v1/journal/entries/${entry.id}`, u);
    expect(detail.body!.entry.status).toBe('closed');
    expect(detail.body!.trades).toHaveLength(1);
  } else {
    expect(tradeRes.status).toBe(403);
    expect(tradeRes.body!.error).toBe('entry_closed');
  }
  const finalState = await call('GET', `/api/v1/journal/entries/${entry.id}`, u);
  expect(finalState.body!.entry.status).toBe('closed'); // в любом исходе сессия закрыта
});

it('закрытая сессия не отдаёт сделку даже с форой: 403 entry_closed (регресс FOR SHARE)', async () => {
  const u = await newUser();
  const entry = (await call('POST', '/api/v1/journal/entries', u, { date: utcDate(0), plan: 'p' })).body!.entry as { id: number };
  await call('PATCH', `/api/v1/journal/entries/${entry.id}`, u, { review: 'r', status: 'closed' });
  const trade = await call('POST', `/api/v1/journal/entries/${entry.id}/trades`, u, TRADE);
  expect(trade.status).toBe(403);
  expect(trade.body!.error).toBe('entry_closed');
});

// --- фикс 2: guard-отказы через authRateLimiter (анти-спам audit) ---

it('guard-спам с одного IP: 5 отказов с audit, дальше 429 rate_limited БЕЗ новых audit-записей', async () => {
  const ip = '10.88.8.8';
  const tampered = signInitData(tgUserJson(999_777)).slice(0, -4) + 'beef';

  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${base}/api/v1/me`, {
      headers: { 'x-telegram-init-data': tampered, 'x-forwarded-for': ip },
    });
    statuses.push(res.status);
  }
  expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]); // в пределах лимита — честный отказ
  expect(statuses[5]).toBe(429); // дальше — лимитер

  const audit = await db.query(
    'SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND ip = $2 AND detail LIKE $3',
    ['auth_fail', ip, 'guard_%'],
  );
  expect(audit.rows[0].n).toBe(5); // спам не залил audit_log — записей ровно по лимиту
});

// --- фикс 3: clamp будущей даты сессии ---

it('дата сессии: вчера и сегодня — можно, завтра — можно (допуск TZ), послезавтра — 400', async () => {
  const u = await newUser();

  const yesterday = await call('POST', '/api/v1/journal/entries', u, { date: utcDate(-1), plan: 'дебриф задним числом' });
  expect(yesterday.status).toBe(201);

  const today = await call('POST', '/api/v1/journal/entries', u, { date: utcDate(0), plan: 'сегодня' });
  expect(today.status).toBe(201);

  const tomorrow = await call('POST', '/api/v1/journal/entries', u, { date: utcDate(1), plan: 'завтра (допуск TZ)' });
  expect(tomorrow.status).toBe(201);

  const far = await call('POST', '/api/v1/journal/entries', u, { date: utcDate(2), plan: 'послезавтра' });
  expect(far.status).toBe(400);
  expect(far.body!.error).toBe('invalid_request');
});
