import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { signJwt } from '../src/common/jwt';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, startApp, truncateAll } from './helpers';

/** E2E нед5-фикс — POST /api/v1/auth/invite/redeem: юзер под TmaAuthGuard (Bearer)
 *  гасит инвайт ОТДЕЛЬНО от входа. Bearer+активный код → 200 {user} и /me после — ok;
 *  неверный код → 403 bad_invite_code; повтор → 403 already_invited БЕЗ погашения
 *  второго кода (чужой путь не гасим); аудит invite_redeemed с маскированным кодом. */

let app: INestApplication;
let base: string;

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

/** Бутстрап-юзер без инвайта: строка users есть, used_by-кода нет (web-сценарий фикса). */
async function insertUser(tgId: number): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (telegram_id, username, first_name, language) VALUES ($1, NULL, 'Webby', 'en') RETURNING id`,
    [tgId],
  );
  return r.rows[0].id;
}

function bearer(tgId: number): string {
  return `Bearer ${signJwt({ tg: tgId, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)}`;
}

interface Resp {
  status: number;
  body: Record<string, any> | null;
}

async function redeem(code: string, auth: string, ip: string): Promise<Resp> {
  const res = await fetch(`${base}/api/v1/auth/invite/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth, 'x-forwarded-for': ip },
    body: JSON.stringify({ code }),
  });
  let parsed: Record<string, any> | null = null;
  try {
    parsed = (await res.json()) as Record<string, any>;
  } catch {
    /* пустое тело */
  }
  return { status: res.status, body: parsed };
}

async function me(auth: string): Promise<Resp> {
  const res = await fetch(`${base}/api/v1/me`, { headers: { authorization: auth, 'x-forwarded-for': freshIp() } });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
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

it('Bearer + активный код → 200 {user}; /me после — ok, код погашен, аудит замаскирован', async () => {
  const uid = await insertUser(910_000_001);
  const code = await createInviteCode(db, null);
  const auth = bearer(910_000_001);

  const r = await redeem(code, auth, freshIp());
  expect(r.status).toBe(200);
  expect(r.body?.user).toMatchObject({ id: Number(uid), telegramId: 910_000_001 });

  const m = await me(auth);
  expect(m.status).toBe(200);
  expect(m.body?.user?.id).toBe(Number(uid));

  const used = await db.query<{ used_by: string | null }>('SELECT used_by FROM invite_codes WHERE code = $1', [code]);
  expect(used.rows[0].used_by).toBe(uid);

  const audit = await db.query<{ detail: string | null }>(
    `SELECT detail FROM audit_log WHERE user_id = $1 AND action = 'invite_redeemed'`,
    [uid],
  );
  expect(audit.rows[0].detail).not.toBe(code); // код целиком в аудите не хранится
  expect(audit.rows[0].detail).toContain('…');
});

it('неверный код → 403 bad_invite_code (+аудит), ничего не погашено', async () => {
  const uid = await insertUser(910_000_002);
  const r = await redeem('no-such-code-xyz', bearer(910_000_002), freshIp());
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('bad_invite_code');

  const audit = await db.query<{ detail: string | null }>(
    `SELECT detail FROM audit_log WHERE user_id = $1 AND action = 'invite_redeem_fail'`,
    [uid],
  );
  expect(audit.rows[0].detail).toBe('bad_invite_code');
});

it('повторный redeem → 403 already_invited, второй (чужой) код НЕ погашен', async () => {
  const uid = await insertUser(910_000_003);
  const auth = bearer(910_000_003);
  const first = await createInviteCode(db, null);
  const second = await createInviteCode(db, null);

  const ok = await redeem(first, auth, freshIp());
  expect(ok.status).toBe(200);

  const again = await redeem(second, auth, freshIp());
  expect(again.status).toBe(403);
  expect(again.body?.error).toBe('already_invited');

  const secondRow = await db.query<{ used_by: string | null }>('SELECT used_by FROM invite_codes WHERE code = $1', [
    second,
  ]);
  expect(secondRow.rows[0].used_by).toBeNull(); // чужой путь цел

  const m = await me(auth); // и юзер по-прежнему жив
  expect(m.status).toBe(200);
});

it('без кредов → 401 (гвард), мусорное тело → 400 invalid_request', async () => {
  await insertUser(910_000_004);
  const noAuth = await fetch(`${base}/api/v1/auth/invite/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ code: 'x' }),
  });
  expect(noAuth.status).toBe(401);

  const badBody = await fetch(`${base}/api/v1/auth/invite/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer(910_000_004), 'x-forwarded-for': freshIp() },
    body: JSON.stringify({}), // код не передан
  });
  expect(badBody.status).toBe(400);
  expect(((await badBody.json()) as Record<string, any>).error).toBe('invalid_request');

  const notString = await fetch(`${base}/api/v1/auth/invite/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer(910_000_004), 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ code: 123 }),
  });
  expect(notString.status).toBe(400);
});
