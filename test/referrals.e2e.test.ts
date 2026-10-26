import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';

/** E2E рефералка (нед3): генерация r_-инвайтов с лимитом 3 активных, привязка при
 *  регистрации по коду юзера (та же tx), список приглашённых — только счётчики
 *  (username/имя, дата, активность в журнале), анти-MLM: никаких оборотов/комиссий. */

let app: INestApplication;
let base: string;

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

let tgSeq = 204_000;

async function authNew(initData: string, inviteCode: string | undefined, ip = freshIp()) {
  const res = await fetch(`${base}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ initData, inviteCode }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, body };
}

/** Новый юзер (по коду, если передан; иначе по CLI-инвайту). */
async function newUser(inviteCode?: string): Promise<{ initData: string; id: number }> {
  const initData = signInitData(tgUserJson(++tgSeq, `U${tgSeq}`));
  const code = inviteCode ?? (await createInviteCode(db, null, 1));
  const r = await authNew(initData, code);
  if (r.status !== 200 || !r.body) throw new Error(`newUser failed: ${r.status}`);
  return { initData, id: (r.body as { user: { id: number } }).user.id };
}

function h(u: { initData: string }): Record<string, string> {
  return { 'content-type': 'application/json', 'x-telegram-init-data': u.initData };
}

async function call(
  method: string,
  path: string,
  user: { initData: string },
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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

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

// --- генерация инвайтов ---

it('POST /referrals/invite: код r_+8 из безопасного алфавита, лежит в invite_codes с created_by', async () => {
  const u = await newUser();
  const r = await call('POST', '/api/v1/referrals/invite', u);
  expect(r.status).toBe(200);
  expect(r.body!.code).toMatch(/^r_[a-z2-9]{8}$/);
  const row = await db.query('SELECT created_by, used_by, quota FROM invite_codes WHERE code = $1', [r.body!.code]);
  expect(String(row.rows[0].created_by)).toBe(String(u.id));
  expect(row.rows[0].used_by).toBeNull();
  expect(row.rows[0].quota).toBe(1);
});

it('лимит: 3 активных инвайта, 4-й → 409 invite_limit_reached', async () => {
  const u = await newUser();
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/v1/referrals/invite', u);
    expect(r.status).toBe(200);
  }
  const fourth = await call('POST', '/api/v1/referrals/invite', u);
  expect(fourth.status).toBe(409);
  expect(fourth.body!.error).toBe('invite_limit_reached');
});

it('погашенный инвайт освобождает слот: после регистрации по коду можно генерить дальше', async () => {
  const u = await newUser();
  const codes: string[] = [];
  for (let i = 0; i < 3; i++) codes.push((await call('POST', '/api/v1/referrals/invite', u)).body!.code);
  await newUser(codes[0]); // погасили первый код

  const again = await call('POST', '/api/v1/referrals/invite', u); // активных снова 2 → можно
  expect(again.status).toBe(200);
  expect(again.body!.code).toMatch(/^r_[a-z2-9]{8}$/);
});

// --- привязка при регистрации ---

it('регистрация по r_-коду юзера X → referrals привязка; GET /referrals показывает приглашённого', async () => {
  const referrer = await newUser();
  const code = (await call('POST', '/api/v1/referrals/invite', referrer)).body!.code;

  const invited = await newUser(code);

  const binding = await db.query('SELECT referrer_uid, invite_code FROM referrals WHERE invited_uid = $1', [invited.id]);
  expect(binding.rowCount).toBe(1);
  expect(String(binding.rows[0].referrer_uid)).toBe(String(referrer.id));
  expect(binding.rows[0].invite_code).toBe(code);

  const list = await call('GET', '/api/v1/referrals', referrer);
  expect(list.status).toBe(200);
  expect(list.body!.count).toBe(1);
  expect(list.body!.invited[0].username).toBeNull(); // в тестах username не задан
  expect(list.body!.invited[0].first_name).toBe(`U${tgSeq}`); // последний созданный
  expect(typeof list.body!.invited[0].joined_at).toBe('string');
  expect(list.body!.invited[0].is_active_journal).toBe(false);
  // анти-MLM-канон: в ответе нет оборотов, комиссий, процентов
  expect(Object.keys(list.body!.invited[0]).sort()).toEqual(['first_name', 'is_active_journal', 'joined_at', 'username']);
});

it('is_active_journal: false до записи в журнале, true после первой сессии', async () => {
  const referrer = await newUser();
  const code = (await call('POST', '/api/v1/referrals/invite', referrer)).body!.code;
  const invited = await newUser(code);

  const before = await call('GET', '/api/v1/referrals', referrer);
  expect(before.body!.invited[0].is_active_journal).toBe(false);

  await call('POST', '/api/v1/journal/entries', invited, { date: todayUtc(), plan: 'первая вылазка' });

  const after = await call('GET', '/api/v1/referrals', referrer);
  expect(after.body!.invited[0].is_active_journal).toBe(true);
});

it('CLI-инвайт (created_by NULL) привязки не создаёт; пустой список — нули', async () => {
  const u = await newUser(); // вошёл по CLI-коду
  const empty = await call('GET', '/api/v1/referrals', u);
  expect(empty.body!).toEqual({ invited: [], count: 0 });

  const newcomer = await newUser(); // тоже CLI-код
  const binding = await db.query('SELECT 1 FROM referrals WHERE invited_uid = $1', [newcomer.id]);
  expect(binding.rowCount).toBe(0);
});

it('список приглашённых виден только их рефереру', async () => {
  const referrer = await newUser();
  const code = (await call('POST', '/api/v1/referrals/invite', referrer)).body!.code;
  await newUser(code);

  const stranger = await newUser();
  const list = await call('GET', '/api/v1/referrals', stranger);
  expect(list.body!.count).toBe(0); // чужие приглашённые не видны

  const own = await call('GET', '/api/v1/referrals', referrer);
  expect(own.body!.count).toBe(1);
});

it('без аутентификации рефералка закрыта → 401', async () => {
  const post = await fetch(`${base}/api/v1/referrals/invite`, { method: 'POST' });
  expect(post.status).toBe(401);
  const get = await fetch(`${base}/api/v1/referrals`);
  expect(get.status).toBe(401);
});
