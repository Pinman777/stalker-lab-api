import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { TelegramBotApiSender } from '../src/modules/identity/tg-sender';
import { ensureTestDb, resetSchema, startApp, truncateAll } from './helpers';

/** Отзыв веб-токенов (012): logout гасит ВСЕ Bearer-сессии юзера (включая
 *  выданные ДО logout), новый логин после logout живой, TMA не задет. */

let app: INestApplication;
let base: string;

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

async function getJson(path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function webLogin(tgId: bigint, username: string): Promise<string> {
  await db.query(
    'INSERT INTO users (telegram_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tgId, username, username],
  );
  await fetch(`${base}/api/v1/auth/code/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ username }),
  });
  const row = await db.query<{ code: string }>(
    'SELECT code FROM login_codes WHERE telegram_user_id = $1 ORDER BY id DESC LIMIT 1',
    [tgId],
  );
  const res = await fetch(`${base}/api/v1/auth/code/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ username, code: row.rows[0].code }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
  // мок TgSender (канон login-code.e2e): реальная сеть не трогается
  app.get(TelegramBotApiSender).sendMessageTo = async () => {};
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await app.close();
});

describe('web logout → отзыв всех сессий', () => {
  it('токен жив → logout → тот же токен 401 (guard_token_revoked в аудите)', async () => {
    const t1 = await webLogin(501_001n, 'revoker');
    expect((await getJson('/api/v1/me', t1)).status).toBe(200);

    const out = await fetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(out.status).toBe(200);

    const after = await getJson('/api/v1/me', t1);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('unauthenticated');

    const audit = await db.query<{ action: string; detail: string }>(
      `SELECT action, detail FROM audit_log WHERE action = 'web_logout_all'`,
    );
    expect(audit.rows).toHaveLength(1);
    const guard = await db.query<{ detail: string }>(
      `SELECT detail FROM audit_log WHERE action = 'auth_fail' AND detail LIKE 'guard_token_revoked%'`,
    );
    expect(guard.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('второй токен того же юзера (другое устройство) тоже погашен', async () => {
    const t1 = await webLogin(501_002n, 'twodevices');
    // второй код = вторая сессия (как второе устройство)
    await fetch(`${base}/api/v1/auth/code/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ username: 'twodevices' }),
    });
    const row = await db.query<{ code: string }>(
      'SELECT code FROM login_codes WHERE telegram_user_id = $1 ORDER BY id DESC LIMIT 1',
      [501_002n],
    );
    const res2 = await fetch(`${base}/api/v1/auth/code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ username: 'twodevices', code: row.rows[0].code }),
    });
    const t2 = ((await res2.json()) as { token: string }).token;

    expect((await getJson('/api/v1/me', t1)).status).toBe(200);
    expect((await getJson('/api/v1/me', t2)).status).toBe(200);

    await fetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t2}` },
    });
    expect((await getJson('/api/v1/me', t1)).status).toBe(401);
    expect((await getJson('/api/v1/me', t2)).status).toBe(401);
  });

  it('после logout новый логин выдаёт живой токен (iat > revoked)', async () => {
    const t1 = await webLogin(501_003n, 'phoenix');
    await fetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1}` },
    });
    // iat — секундная гранулярность: токен, выданный В ТУ ЖЕ секунду, что logout,
    // консервативно мёртв; ждём секунду — новый логин обязан жить
    await new Promise((r) => setTimeout(r, 1100));
    const t2 = await webLogin(501_003n, 'phoenix');
    expect((await getJson('/api/v1/me', t2)).status).toBe(200);
  });

  it('logout без авторизации → 401', async () => {
    const res = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
