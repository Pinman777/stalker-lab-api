import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { signJwt } from '../src/common/jwt';
import { TelegramBotApiSender } from '../src/modules/identity/tg-sender';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';

/** E2E нед5 — web-вход по одноразовому коду из TG: request→verify→me по Bearer,
 *  инвалидация старых кодов, 5 промахов, expiry, rate-limit (юзер/IP), 404 без
 *  раскрытия причины, левый JWT-секрет → 401, регресс initData. TgSender замокан. */

let app: INestApplication;
let base: string;

const SENT: Array<{ chatId: string; text: string }> = [];
let failSend = false;

/** Тот же fallback, что в test/env.ts — подпись «валидного для приложения» JWT. */
const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

async function insertUser(tgId: number, username: string | null): Promise<void> {
  await db.query(`INSERT INTO users (telegram_id, username, first_name, language) VALUES ($1, $2, 'Tester', 'en')`, [
    tgId,
    username,
  ]);
}

interface Resp {
  status: number;
  body: Record<string, any> | null;
}

async function postJson(path: string, body: unknown, ip: string): Promise<Resp> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, any> | null = null;
  try {
    parsed = (await res.json()) as Record<string, any>;
  } catch {
    /* пустое тело */
  }
  return { status: res.status, body: parsed };
}

const requestCode = (username: string, ip: string) => postJson('/api/v1/auth/code/request', { username }, ip);
const verifyCode = (username: string, code: string, ip: string) =>
  postJson('/api/v1/auth/code/verify', { username, code }, ip);

/** Код из последнего перехваченного сообщения бота. */
function lastCode(): string {
  const m = SENT[SENT.length - 1]?.text.match(/\b(\d{6})\b/);
  if (!m) throw new Error('код не перехвачен');
  return m[1];
}

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
  // мок TgSender: перехватываем отправку на singleton-инстансе из DI, сеть не трогаем
  const sender = app.get(TelegramBotApiSender);
  sender.sendMessageTo = async (chatId: string, text: string) => {
    if (failSend) throw new Error('mock send failure');
    SENT.push({ chatId, text });
  };
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll(db);
  SENT.length = 0;
  failSend = false;
});

// --- happy path ---

it('request → код в TG → verify → JWT → /me по Bearer; аудит с маскированным username', async () => {
  await insertUser(201_001, 'stalker_main');
  const ip = freshIp();

  const req = await requestCode('stalker_main', ip);
  expect(req.status).toBe(200);
  expect(req.body).toEqual({ sent: true });
  expect(SENT).toHaveLength(1);
  expect(SENT[0].chatId).toBe('201001');
  expect(SENT[0].text).toMatch(/^Код для входа в Stalker Lab: \d{6}\. Действителен 10 минут\./);

  const ver = await verifyCode('stalker_main', lastCode(), freshIp());
  expect(ver.status).toBe(200);
  expect(typeof ver.body?.token).toBe('string');
  expect(ver.body?.user?.telegramId).toBe(201_001);
  expect(ver.body?.user?.username).toBe('stalker_main');

  const me = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${ver.body?.token}` } });
  expect(me.status).toBe(200);
  const meBody = (await me.json()) as { user: { telegramId: number } };
  expect(meBody.user.telegramId).toBe(201_001);

  const audit = await db.query<{ action: string; detail: string }>(
    `SELECT action, detail FROM audit_log WHERE action LIKE 'login_code%' ORDER BY id`,
  );
  const rows = audit.rows.map((r) => `${r.action}:${r.detail}`);
  expect(rows).toContain('login_code_requested:st…in');
  expect(rows.some((r) => r.startsWith('login_code_success:'))).toBe(true);
});

it('вход по числовому telegram id (username=null в users)', async () => {
  await insertUser(201_002, null);
  const req = await requestCode('201002', freshIp());
  expect(req.status).toBe(200);
  const ver = await verifyCode('201002', lastCode(), freshIp());
  expect(ver.status).toBe(200);
  expect(ver.body?.user?.telegramId).toBe(201_002);
});

it('новый request гасит прежний код: старый → 403, новый → 200', async () => {
  await insertUser(201_003, 'code_rotator');
  const ip = freshIp();
  await requestCode('code_rotator', ip);
  const first = lastCode();
  await requestCode('code_rotator', ip);
  const second = lastCode();
  expect(first).not.toBe(second);

  const old = await verifyCode('code_rotator', first, freshIp());
  expect(old.status).toBe(403);
  expect(old.body?.error).toBe('invalid_code');
  const ok = await verifyCode('code_rotator', second, freshIp());
  expect(ok.status).toBe(200);
});

// --- verify: промахи / expiry / чужой юзер ---

it('неверный код: 5 промахов → 403 на каждый, код погашен, верный после — 403', async () => {
  await insertUser(201_004, 'brute_force');
  await requestCode('brute_force', freshIp());
  const correct = lastCode();

  for (let i = 0; i < 5; i++) {
    const wrong = await verifyCode('brute_force', '000000' === correct ? '111111' : '000000', freshIp());
    expect(wrong.status).toBe(403);
    expect(wrong.body?.error).toBe('invalid_code');
  }
  const row = await db.query<{ attempts: number; used_at: Date | null }>(
    `SELECT attempts, used_at FROM login_codes WHERE telegram_user_id = $1`,
    [201_004],
  );
  expect(row.rows[0].attempts).toBe(5);
  expect(row.rows[0].used_at).not.toBeNull();

  const late = await verifyCode('brute_force', correct, freshIp());
  expect(late.status).toBe(403);
  const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'login_code_fail'`);
  expect(audit.rowCount).toBeGreaterThanOrEqual(5);
});

it('просроченный код → 403 invalid_code', async () => {
  await insertUser(201_005, 'slowpoke');
  await requestCode('slowpoke', freshIp());
  const code = lastCode();
  await db.query(`UPDATE login_codes SET expires_at = now() - interval '1 minute' WHERE telegram_user_id = $1`, [
    201_005,
  ]);
  const r = await verifyCode('slowpoke', code, freshIp());
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('invalid_code');
});

it('verify неизвестного юзера → 403 invalid_code (не раскрываем существование)', async () => {
  const r = await verifyCode('ghost_user', '123456', freshIp());
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('invalid_code');
});

// --- 404 без раскрытия причины ---

it('request: юзера нет (username и числовой) → 404 user_not_found, ничего не отправлено', async () => {
  const byName = await requestCode('no_such_user', freshIp());
  expect(byName.status).toBe(404);
  expect(byName.body?.error).toBe('user_not_found');
  const byId = await requestCode('999999999', freshIp());
  expect(byId.status).toBe(404);
  expect(byId.body?.error).toBe('user_not_found');
  expect(SENT).toHaveLength(0);
});

it('отправка не удалась → 404 user_not_found, аудит login_code_send_fail, код погашен', async () => {
  await insertUser(201_006, 'bot_blocked');
  failSend = true;
  const r = await requestCode('bot_blocked', freshIp());
  expect(r.status).toBe(404);
  expect(r.body?.error).toBe('user_not_found');
  const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'login_code_send_fail'`);
  expect(audit.rowCount).toBe(1);
  const row = await db.query(`SELECT used_at FROM login_codes WHERE telegram_user_id = $1`, [201_006]);
  expect(row.rows[0].used_at).not.toBeNull();
});

// --- rate limit (по login_codes.created_at за час) ---

it('6-й код одному юзеру за час → 429 too_many_requests', async () => {
  await insertUser(201_007, 'spam_me');
  const ip = freshIp();
  for (let i = 0; i < 5; i++) {
    const r = await requestCode('spam_me', ip);
    expect(r.status).toBe(200);
  }
  const sixth = await requestCode('spam_me', ip);
  expect(sixth.status).toBe(429);
  expect(sixth.body?.error).toBe('too_many_requests');
  expect(SENT).toHaveLength(5);
});

it('11-й код с одного IP за час (10 разных юзеров) → 429 too_many_requests', async () => {
  const ip = '10.88.8.8';
  for (let i = 0; i < 10; i++) {
    const tgId = 301_000 + i;
    await insertUser(tgId, `ip_user_${i}`);
    const r = await requestCode(`ip_user_${i}`, ip);
    expect(r.status).toBe(200);
  }
  await insertUser(301_100, 'ip_user_over');
  const over = await requestCode('ip_user_over', ip);
  expect(over.status).toBe(429);
  expect(over.body?.error).toBe('too_many_requests');
});

// --- guard: Bearer-JWT ---

it('JWT с левым секретом / битый Bearer / юзер удалён → 401', async () => {
  await insertUser(201_010, 'token_owner');

  const forged = signJwt({ tg: 201_010, exp: Math.floor(Date.now() / 1000) + 3600 }, 'evil-secret');
  const r1 = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${forged}`, 'x-forwarded-for': freshIp() } });
  expect(r1.status).toBe(401);
  expect(((await r1.json()) as { error: string }).error).toBe('unauthenticated');

  const r2 = await fetch(`${base}/api/v1/me`, { headers: { authorization: 'Bearer garbage', 'x-forwarded-for': freshIp() } });
  expect(r2.status).toBe(401);

  const orphan = signJwt({ tg: 201_777, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
  const r3 = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${orphan}`, 'x-forwarded-for': freshIp() } });
  expect(r3.status).toBe(401);
  expect(((await r3.json()) as { error: string }).error).toBe('user_not_found');
});

it('регресс: /me по initData по-прежнему работает', async () => {
  await insertUser(201_011, 'old_school');
  const initData = signInitData(tgUserJson(201_011));
  const res = await fetch(`${base}/api/v1/me`, { headers: { 'x-telegram-init-data': initData } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { telegramId: number } };
  expect(body.user.telegramId).toBe(201_011);
});
