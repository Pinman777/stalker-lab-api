import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';

/** E2E identity/invites (нед1, задачи 2-3): auth happy-path, битый initData → 401,
 *  инвайт валидный/невалидный/повтор → 403, rate-limit 5/мин/IP, guard/me, заглушки. */

let app: INestApplication;
let base: string;

/** Уникальный IP на тест — rate-limiter in-process и общий на процесс. */
function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

interface AuthResponse {
  status: number;
  body: Record<string, any> | null;
}

async function postAuth(initData: string, inviteCode: string | undefined, ip: string): Promise<AuthResponse> {
  const res = await fetch(`${base}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ initData, ...(inviteCode ? { inviteCode } : {}) }),
  });
  let body: Record<string, any> | null = null;
  try {
    body = (await res.json()) as Record<string, any>;
  } catch {
    /* пустое тело */
  }
  return { status: res.status, body };
}

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

// --- initData ---

it('невалидная подпись initData → 401 invalid_init_data, юзер не создаётся', async () => {
  const good = signInitData(tgUserJson(101_001));
  const tampered = good.slice(0, -4) + 'dead';
  const r = await postAuth(tampered, undefined, freshIp());
  expect(r.status).toBe(401);
  expect(r.body?.error).toBe('invalid_init_data');
  const u = await db.query('SELECT 1 FROM users WHERE telegram_id = $1', [101_001]);
  expect(u.rowCount).toBe(0);
});

it('просроченный auth_date (25ч назад) → 401 (freshness ±24ч)', async () => {
  const stale = signInitData(tgUserJson(101_002), Math.floor(Date.now() / 1000) - 25 * 3600);
  const r = await postAuth(stale, undefined, freshIp());
  expect(r.status).toBe(401);
  expect(r.body?.error).toBe('invalid_init_data');
});

// --- INVITE-ONLY ---

it('новый юзер без инвайта → 403 invite_required, аккаунт не создаётся', async () => {
  const r = await postAuth(signInitData(tgUserJson(101_003)), undefined, freshIp());
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('invite_required');
  const u = await db.query('SELECT 1 FROM users WHERE telegram_id = $1', [101_003]);
  expect(u.rowCount).toBe(0);
});

it('новый юзер с несуществующим кодом → 403 invite_required, аккаунт не создаётся', async () => {
  const r = await postAuth(signInitData(tgUserJson(101_004)), 'no-such-code', freshIp());
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('invite_required');
  const u = await db.query('SELECT 1 FROM users WHERE telegram_id = $1', [101_004]);
  expect(u.rowCount).toBe(0);
});

it('happy path: валидный initData + валидный инвайт → 200, юзер создан, код погашен', async () => {
  const code = await createInviteCode(db, null, 1);
  const r = await postAuth(signInitData(tgUserJson(101_005)), code, freshIp());
  expect(r.status).toBe(200);
  expect(r.body?.isNew).toBe(true);
  expect(r.body?.user?.telegramId).toBe(101_005);
  expect(r.body?.user?.firstName).toBe('Tester');
  const u = await db.query('SELECT id FROM users WHERE telegram_id = $1', [101_005]);
  expect(u.rowCount).toBe(1);
  const inv = await db.query('SELECT used_by, used_at FROM invite_codes WHERE code = $1', [code]);
  expect(inv.rowCount).toBe(1);
  expect(String(inv.rows[0].used_by)).toBe(String(u.rows[0].id));
  expect(inv.rows[0].used_at).not.toBeNull();
  const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'invite_used' AND detail = $1`, [code]);
  expect(audit.rowCount).toBe(1);
});

it('повторное использование инвайта другим юзером → 403, второй аккаунт не создаётся', async () => {
  const code = await createInviteCode(db, null, 1);
  const first = await postAuth(signInitData(tgUserJson(101_006)), code, freshIp());
  expect(first.status).toBe(200);
  const second = await postAuth(signInitData(tgUserJson(101_007)), code, freshIp());
  expect(second.status).toBe(403);
  expect(second.body?.error).toBe('invite_required');
  const u = await db.query('SELECT 1 FROM users WHERE telegram_id = $1', [101_007]);
  expect(u.rowCount).toBe(0);
});

it('существующий юзер без инвайта → 200 isNew=false (stateless re-auth)', async () => {
  const code = await createInviteCode(db, null, 1);
  await postAuth(signInitData(tgUserJson(101_008)), code, freshIp());
  const again = await postAuth(signInitData(tgUserJson(101_008)), undefined, freshIp());
  expect(again.status).toBe(200);
  expect(again.body?.isNew).toBe(false);
  expect(again.body?.user?.telegramId).toBe(101_008);
});

// --- rate limit (brute-force) ---

it('6-я попытка с одного IP за минуту → 429 rate_limited + audit-запись', async () => {
  const ip = '10.77.7.7';
  const good = signInitData(tgUserJson(999_009));
  const tampered = good.slice(0, -4) + 'beef';
  for (let i = 0; i < 5; i++) {
    const r = await postAuth(tampered, undefined, ip);
    expect(r.status).toBe(401);
  }
  const sixth = await postAuth(tampered, undefined, ip);
  expect(sixth.status).toBe(429);
  expect(sixth.body?.error).toBe('rate_limited');
  const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'auth_rate_limited' AND ip = $1`, [ip]);
  expect(audit.rowCount).toBe(1);
});

// --- guard / me / заглушки / health ---

it('GET /api/v1/me: с initData в заголовке → 200 юзер; без заголовка → 401', async () => {
  const code = await createInviteCode(db, null, 1);
  const initData = signInitData(tgUserJson(101_010));
  await postAuth(initData, code, freshIp());

  const ok = await fetch(`${base}/api/v1/me`, { headers: { 'x-telegram-init-data': initData } });
  expect(ok.status).toBe(200);
  const okBody = (await ok.json()) as { user: { telegramId: number } };
  expect(okBody.user.telegramId).toBe(101_010);

  const anon = await fetch(`${base}/api/v1/me`);
  expect(anon.status).toBe(401);
});

it('GET /api/v1/journal/entries (нед2 реализован): без тела → 200 пустой список своих', async () => {
  const code = await createInviteCode(db, null, 1);
  const initData = signInitData(tgUserJson(101_011));
  await postAuth(initData, code, freshIp());
  const res = await fetch(`${base}/api/v1/journal/entries`, { headers: { 'x-telegram-init-data': initData } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
});

// --- guard-отказы в audit_log (review #4) ---

it('guard-отказы пишутся в audit: нет заголовка / битая подпись / неизвестный юзер', async () => {
  // нет заголовка → 401 + audit
  const no = await fetch(`${base}/api/v1/me`);
  expect(no.status).toBe(401);
  // битая подпись → 401 + audit
  const good = signInitData(tgUserJson(101_012));
  const tampered = good.slice(0, -4) + 'cafe';
  const bad = await fetch(`${base}/api/v1/me`, { headers: { 'x-telegram-init-data': tampered } });
  expect(bad.status).toBe(401);
  // валидная подпись, но юзер не регистрировался → 401 user_not_found + audit с tg-id
  const ghost = signInitData(tgUserJson(101_013));
  const nf = await fetch(`${base}/api/v1/me`, { headers: { 'x-telegram-init-data': ghost } });
  expect(nf.status).toBe(401);
  expect(((await nf.json()) as { error: string }).error).toBe('user_not_found');

  // Спека v2 (анти-спам audit): гость без заголовка — штатный визит, 401 БЕЗ audit-записи
  // и без расхода rate-limiter; перебор (битая подпись / неизвестный юзер) — с audit.
  const audit = await db.query<{ detail: string }>(
    `SELECT detail FROM audit_log WHERE action = 'auth_fail' AND detail LIKE 'guard_%' ORDER BY id`,
  );
  const details = audit.rows.map((r) => r.detail);
  expect(details).not.toContain('guard_no_init_data');
  expect(details).toContain('guard_bad_init_data');
  expect(details.some((d) => d.startsWith('guard_user_not_found tg='))).toBe(true);
});

it('заблокированный юзер: guard → 403 blocked + audit с user_id', async () => {
  const code = await createInviteCode(db, null, 1);
  const initData = signInitData(tgUserJson(101_014));
  await postAuth(initData, code, freshIp());
  const u = await db.query('SELECT id FROM users WHERE telegram_id = $1', [101_014]);
  await db.query('UPDATE users SET is_blocked = TRUE WHERE id = $1', [u.rows[0].id]);

  const res = await fetch(`${base}/api/v1/me`, { headers: { 'x-telegram-init-data': initData } });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe('blocked');
  const audit = await db.query(
    `SELECT 1 FROM audit_log WHERE action = 'auth_fail' AND user_id = $1 AND detail = 'guard_blocked'`,
    [u.rows[0].id],
  );
  expect(audit.rowCount).toBe(1);
});

// --- exception-filter: единый контракт {error: code} (review #10) ---

it('битый JSON-body → 400 {error:"invalid_request"} (не nest-дефолт)', async () => {
  const res = await fetch(`${base}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"initData": "oops',
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as Record<string, unknown>).error).toBe('invalid_request');
});

it('неизвестный маршрут → 404 {error:"not_found"}; чужой метод → 405 {error:"method_not_allowed"}', async () => {
  const miss = await fetch(`${base}/api/v1/nope`);
  expect(miss.status).toBe(404);
  expect(((await miss.json()) as Record<string, unknown>).error).toBe('not_found');

  const wrong = await fetch(`${base}/api/v1/health`, { method: 'POST' });
  expect([404, 405]).toContain(wrong.status); // nest-роутер: нет POST-маршрута
  if (wrong.status === 405) {
    expect(((await wrong.json()) as Record<string, unknown>).error).toBe('method_not_allowed');
  }
});

it('GET /api/v1/health → 200 {status:"ok", db:"ok"} (SELECT 1 прошёл)', async () => {
  const res = await fetch(`${base}/api/v1/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
});
