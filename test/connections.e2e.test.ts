import { createHmac } from 'crypto';
import { createServer, type Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { decryptSecret, encryptSecret } from '../src/modules/connections/secret-crypto';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { connectionsRateLimiter } from '../src/modules/connections/connections.controller';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';

/** E2E нед4 — автожурнал: bind/unbind/list/sync/guide BingX + journal/auto + stats.
 *
 *  Мок-сервер BingX не просто отдаёт заглушки — он ПРОВЕРЯЕТ каноническую подпись
 *  (ASCII-сортировка параметров, HmacSHA256 → signature, заголовок X-BX-APIKEY),
 *  т.е. тест фиксирует схему подписи по официальным докам, а не наш собственный код. */

let app: INestApplication;
let base: string;
let mock: Server;
let mockBase: string;

const API_KEY = 'test-bingx-api-key-abcdefghijklmnop';
const API_SECRET = 'test-bingx-secret-0123456789abcdefghijklmnop';

// --- состояние мока (тест конфигурирует сценарий) ---
const scenario = {
  balanceCode: 0, // code в ответе /user/balance (0 = ключ валиден)
  rejectAll: false, // эмуляция отозванного ключа: ВСЕ подписанные запросы → 100414
  syncFailCode: 0, // w4-fix1: код для income/positionHistory (100419 = rate-limit биржи)
  incomesUsdt: [{ symbol: 'BTC-USDT' }, { symbol: 'ETH-USDT' }],
  positionsBtc: [] as Array<Record<string, unknown>>, // /trade/positionHistory?symbol=BTC-USDT
};

function closedPosition(
  positionId: string,
  side: 'LONG' | 'SHORT',
  openTime: number,
  closeTime: number,
  realizedProfit: string,
): Record<string, unknown> {
  return {
    positionId, // 19-значный BIGINT-string (> MAX_SAFE_INTEGER — НЕ Number()!)
    symbol: 'BTC-USDT',
    positionSide: side,
    isolated: false,
    closeAllPositions: true,
    positionAmt: '0.0100',
    closePositionAmt: '0.0100',
    realizedProfit,
    netProfit: realizedProfit,
    avgClosePrice: 64250.5,
    avgPrice: '64100.25',
    leverage: 10,
    positionCommission: '-0.05',
    totalFunding: '0.0001',
    openTime,
    updateTime: closeTime,
  };
}

// фиксированные, но «свежие» относительно запуска: позиции в окне 7 дней.
// Анкер 12:00 UTC: NOW-Nd не прыгает через полночь ни в UTC, ни в Europe/Moscow
// (сетка from/to фильтра — даты в TZ сессии; без анкера тест краснел 00:00–03:00 MSK).
const NOW = new Date().setUTCHours(12, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const P1_ID = '1930451234567890123';
const P1_OPEN = NOW - 5 * DAY;
const P1_CLOSE = NOW - 4 * DAY;
const P2_ID = '1930459876543210987';
const P2_OPEN = NOW - 3 * DAY;
const P2_CLOSE = NOW - 2 * DAY;

function resetScenario(): void {
  scenario.balanceCode = 0;
  scenario.rejectAll = false;
  scenario.syncFailCode = 0;
  scenario.incomesUsdt = [{ symbol: 'BTC-USDT' }, { symbol: 'ETH-USDT' }];
  scenario.positionsBtc = [
    closedPosition(P1_ID, 'LONG', P1_OPEN, P1_CLOSE, '125.40'),
    closedPosition(P2_ID, 'SHORT', P2_OPEN, P2_CLOSE, '-40.10'),
    // открытая (частично закрытая) позиция — в журнал НЕ попадает
    { ...closedPosition('1930450000000000001', 'LONG', NOW - DAY, NOW, '5.00'), closeAllPositions: false },
  ];
}

// --- мок-сервер BingX ---
const seen: Array<{ path: string; query: URLSearchParams }> = [];

async function startMock(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://mock');
    const query = u.searchParams;
    seen.push({ path: u.pathname, query });

    const fail = (code: number, msg: string) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code, msg, timestamp: Date.now() }));
    };
    const ok = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: '', data }));
    };

    // ── проверка канонической подписи (схема BingX v2 по официальным докам) ──
    if (req.headers['x-bx-apikey'] !== API_KEY) return fail(100413, 'Null apiKey / wrong key');
    const signature = query.get('signature');
    if (!signature || !query.get('timestamp')) return fail(100413, 'no signature/timestamp');
    const params: Record<string, string> = {};
    query.forEach((v, k) => {
      if (k !== 'signature') params[k] = v;
    });
    const canonical = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    const expected = createHmac('sha256', API_SECRET).update(canonical).digest('hex');
    if (signature !== expected) return fail(100414, 'signature error');

    // ── маршруты ──
    if (scenario.rejectAll) return fail(100414, 'signature error'); // ключ отозван после bind'а
    if (u.pathname === '/openApi/swap/v2/user/balance') {
      if (scenario.balanceCode !== 0) return fail(scenario.balanceCode, 'api key invalid');
      return ok({ asset: 'USDT', balance: '1000.00', equity: '1005.40' });
    }
    if (u.pathname === '/openApi/swap/v2/user/income') {
      if (scenario.syncFailCode !== 0) return fail(scenario.syncFailCode, 'Too many requests');
      if (query.get('currency') === 'USDC') return ok([]);
      return ok(scenario.incomesUsdt.map((i) => ({ ...i, incomeType: 'REALIZED_PROGRESS', income: '1.0', asset: 'USDT', time: NOW })));
    }
    if (u.pathname === '/openApi/swap/v2/trade/positionHistory') {
      if (scenario.syncFailCode !== 0) return fail(scenario.syncFailCode, 'Too many requests');
      if (query.get('pageIndex') !== '0') return ok([]); // одна страница для тестовых данных
      if (query.get('symbol') === 'BTC-USDT') return ok(scenario.positionsBtc);
      return ok([]);
    }
    return fail(100400, 'this api is not exist');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

// --- каноничные хелперы e2e (как в journal.e2e.test.ts) ---
interface User {
  initData: string;
  id: number;
}

let tgSeq = 204_000;

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
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

async function call(
  method: string,
  path: string,
  user: User,
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': user.initData },
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

const bind = (u: User, replace = false) =>
  call('POST', '/api/v1/connections/bingx/bind', u, { apiKey: API_KEY, apiSecret: API_SECRET, replace });

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
  ({ server: mock, base: mockBase } = await startMock());
  process.env.BINGX_API_BASE = mockBase; // инжект базового URL → все запросы идут в мок
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

beforeEach(async () => {
  await truncateAll(db);
  connectionsRateLimiter.reset(); // truncateAll → повторяющиеся user id → ключи лимитера без сброса копят историю
  resetScenario();
  seen.length = 0;
});

// ─── гайд ───

it('guide: 7 шагов, права Read, предупреждение про Withdraw', async () => {
  const u = await newUser();
  const r = await call('GET', '/api/v1/connections/bingx/guide', u);
  expect(r.status).toBe(200);
  expect(r.body?.venue).toBe('bingx');
  expect(r.body?.steps).toHaveLength(7);
  const joined = JSON.stringify(r.body);
  expect(joined).toContain('Read');
  expect(joined).toContain('Withdraw');
});

it('guide (w4-fix3): предупреждение о потере авто-истории при отвязке', async () => {
  const u = await newUser();
  const r = await call('GET', '/api/v1/connections/bingx/guide', u);
  const warnings = (r.body!.warnings as string[]).join(' ');
  expect(warnings).toContain('Отвязка удаляет авто-историю');
  expect(warnings).toContain('последние 7 дней');
});

// ─── bind ───

it('bind happy: ключ проверен живым запросом (мок проверил подпись!), 201, секрет зашифрован', async () => {
  const u = await newUser();
  const r = await bind(u);
  expect(r.status).toBe(201);
  expect(r.body?.venue).toBe('bingx');
  expect(r.body?.masked).toBe('TE…OP'); // первые/последние 2 символа apiKey
  expect(typeof r.body?.bound_at).toBe('string');

  // валидация действительно ходила в биржy каноническим подписанным запросом
  expect(seen.some((s) => s.path === '/openApi/swap/v2/user/balance')).toBe(true);

  // в БД: apiKey как есть, apiSecret НЕ в открытом виде, roundtrip расшифровки
  const row = await db.query<{ api_key: string; api_secret_enc: string; masked: string }>(
    'SELECT api_key, api_secret_enc, masked FROM connections WHERE user_id = $1',
    [u.id],
  );
  expect(row.rows[0].api_key).toBe(API_KEY);
  expect(row.rows[0].api_secret_enc).not.toContain(API_SECRET);
  expect(row.rows[0].api_secret_enc.startsWith('v1:')).toBe(true);
  expect(decryptSecret(API_KEY, row.rows[0].api_secret_enc)).toBe(API_SECRET);

  const audit = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'bingx_bind'`,
    [u.id],
  );
  expect(audit.rows[0].n).toBe(1);
});

it('шифрование roundtrip (unit): одинаковый секрет → разный шифротекст (случайный salt/iv)', () => {
  const a = encryptSecret(API_KEY, API_SECRET);
  const b = encryptSecret(API_KEY, API_SECRET);
  expect(a).not.toBe(b); // salt/iv случайные — одинаковые секреты неотличимы в БД
  expect(decryptSecret(API_KEY, a)).toBe(API_SECRET);
  expect(decryptSecret(API_KEY, b)).toBe(API_SECRET);
  // AAD = apiKey: перестановка шифротекста на другой ключ ломается
  expect(() => decryptSecret('other-api-key-value', a)).toThrow();
});

it('bind с невалидным ключом → 403 invalid_api_key, строки нет', async () => {
  const u = await newUser();
  scenario.balanceCode = 100414; // биржа отвергла
  const r = await call('POST', '/api/v1/connections/bingx/bind', u, {
    apiKey: 'bad-bingx-key-000000000000',
    apiSecret: 'bad-secret-0000000000000000000000',
  });
  // мок отвергает по X-BX-APIKEY (ключ не тот) → 100413 → наш 403
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('invalid_api_key');
  const cnt = await db.query('SELECT count(*)::int AS n FROM connections WHERE user_id = $1', [u.id]);
  expect(cnt.rows[0].n).toBe(0);
  const audit = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'bingx_bind_fail'`,
    [u.id],
  );
  expect(audit.rows[0].n).toBe(1);
});

it('bind при недоступной бирже → 502 bingx_unreachable (не «невалидный ключ»)', async () => {
  const u = await newUser();
  const real = process.env.BINGX_API_BASE;
  process.env.BINGX_API_BASE = 'http://127.0.0.1:9'; // порт без слушателя
  const r = await bind(u);
  process.env.BINGX_API_BASE = real;
  expect(r.status).toBe(502);
  expect(r.body?.error).toBe('bingx_unreachable');
});

it('повторный bind → 409 connection_exists; replace=true перезаписывает (одна строка)', async () => {
  const u = await newUser();
  await bind(u);
  const dup = await bind(u);
  expect(dup.status).toBe(409);
  expect(dup.body?.error).toBe('connection_exists');

  const re = await bind(u, true);
  expect(re.status).toBe(201);
  const cnt = await db.query('SELECT count(*)::int AS n FROM connections WHERE user_id = $1', [u.id]);
  expect(cnt.rows[0].n).toBe(1);
});

it('bind с мусорным телом → 400 invalid_request', async () => {
  const u = await newUser();
  expect((await call('POST', '/api/v1/connections/bingx/bind', u, { apiKey: 'short', apiSecret: 'x' })).status).toBe(400);
  expect((await call('POST', '/api/v1/connections/bingx/bind', u, {})).status).toBe(400);
});

// ─── list ───

it('list: подключение с masked и last_sync_at=null до синка', async () => {
  const u = await newUser();
  await bind(u);
  const r = await call('GET', '/api/v1/connections', u);
  expect(r.status).toBe(200);
  expect(r.body?.connections).toHaveLength(1);
  const c = r.body!.connections[0];
  expect(c.venue).toBe('bingx');
  expect(c.masked).toBe('TE…OP');
  expect(c.lastSyncAt).toBeNull();
  expect(c.boundAt).toBeTruthy();
});

// ─── sync + дедуп + журнал + stats ───

it('sync ×2 идемпотентен: импорт 2 закрытых (открытая не берётся), ре-синк = 0 новых', async () => {
  const u = await newUser();
  await bind(u);

  const s1 = await call('POST', '/api/v1/connections/bingx/sync', u);
  expect(s1.status).toBe(200);
  expect(s1.body?.imported).toBe(2);
  expect(s1.body?.updated).toBe(0);
  expect(s1.body?.symbols_scanned).toBe(2); // BTC-USDT + ETH-USDT из income
  expect(s1.body?.positions_seen).toBe(3); // 2 закрытых + 1 открытая (открытая НЕ импортируется)

  const s2 = await call('POST', '/api/v1/connections/bingx/sync', u);
  expect(s2.status).toBe(200);
  expect(s2.body?.imported).toBe(0);
  expect(s2.body?.updated).toBe(2); // те же строки перезаписаны, дублей нет

  const rows = await db.query('SELECT count(*)::int AS n FROM auto_trades');
  expect(rows.rows[0].n).toBe(2);

  // last_sync_at заполнен
  const conn = await db.query<{ last_sync_at: Date | null }>(
    'SELECT last_sync_at FROM connections WHERE user_id = $1',
    [u.id],
  );
  expect(conn.rows[0].last_sync_at).not.toBeNull();

  // синк ходил канонически: income по ОБЕИМ валютам + positionHistory с обязательным symbol
  const paths = seen.map((s) => s.path);
  expect(paths.filter((p) => p === '/openApi/swap/v2/user/income')).toHaveLength(4); // 2 синка × (USDT+USDC)
  const ph = seen.filter((s) => s.path === '/openApi/swap/v2/trade/positionHistory');
  expect(ph.length).toBeGreaterThanOrEqual(4); // BTC+ETH × 2 синка
  expect(ph.every((s) => s.query.get('symbol') !== null)).toBe(true); // symbol обязателен по докам
  // окно ≈ 7 дней
  const startTime = Number(ph[0].query.get('startTime'));
  const endTime = Number(ph[0].query.get('endTime'));
  expect(endTime - startTime).toBeGreaterThan(6.9 * DAY);
  expect(endTime - startTime).toBeLessThan(7.1 * DAY);
});

it('journal/auto: маппинг полей позиции (BIGINT id, long/short, цены, pnl)', async () => {
  const u = await newUser();
  await bind(u);
  await call('POST', '/api/v1/connections/bingx/sync', u);

  const r = await call('GET', '/api/v1/journal/auto', u);
  expect(r.status).toBe(200);
  const trades = r.body!.trades as Array<Record<string, any>>;
  expect(trades).toHaveLength(2);
  expect(trades.map((t) => t.symbol)).toEqual(['BTC-USDT', 'BTC-USDT']);

  const long = trades.find((t) => t.side === 'long');
  const short = trades.find((t) => t.side === 'short');
  expect(long).toBeDefined();
  expect(short).toBeDefined();
  expect(long!.entryPrice).toBe(64100.25);
  expect(long!.exitPrice).toBe(64250.5);
  expect(long!.pnlUsd).toBe(125.4);
  expect(long!.leverage).toBe(10);
  expect(long!.venue).toBe('bingx');
  expect(long!.openTime).toBe(new Date(P1_OPEN).toISOString());
  expect(long!.closeTime).toBe(new Date(P1_CLOSE).toISOString());
  expect(short!.pnlUsd).toBe(-40.1);
});

it('journal/auto?from&to: фильтр по дате закрытия', async () => {
  const u = await newUser();
  await bind(u);
  await call('POST', '/api/v1/connections/bingx/sync', u);

  const day4 = new Date(P1_CLOSE).toISOString().slice(0, 10); // день закрытия P1
  const day2 = new Date(P2_CLOSE).toISOString().slice(0, 10);
  const all = await call('GET', `/api/v1/journal/auto`, u);
  expect((all.body!.trades as unknown[]).length).toBe(2);
  const only = await call('GET', `/api/v1/journal/auto?from=${day4}&to=${day4}`, u);
  const onlyTrades = only.body!.trades as Array<Record<string, any>>;
  expect(onlyTrades).toHaveLength(1);
  expect(onlyTrades[0].closeTime).toBe(new Date(P1_CLOSE).toISOString());
  expect(day2).not.toBe(day4); // дни действительно разные — фильтр не вырожден
});

it('stats: auto_trades_count/auto_pnl_sum есть, баллов дисциплины за авто НЕТ (идеология)', async () => {
  const u = await newUser();
  await bind(u);
  await call('POST', '/api/v1/connections/bingx/sync', u);

  const r = await call('GET', '/api/v1/me/stats', u);
  expect(r.status).toBe(200);
  expect(r.body!.autoTradesCount).toBe(2);
  expect(Number(r.body!.autoPnlSum)).toBeCloseTo(125.4 - 40.1, 6);
  // идеология нед4: авто-сделки не дают баллов
  expect(r.body!.points).toBe(0);
  expect(r.body!.events).toBe(0);
  expect(r.body!.byType['auto_trade']).toBeUndefined();
  const ev = await db.query(
    `SELECT count(*)::int AS n FROM discipline_events WHERE user_id = $1 AND ref_type = 'auto'`,
    [u.id],
  );
  expect(ev.rows[0].n).toBe(0);
});

it('sync обновляет pnl той же сделки (частичное закрытие доросло до полного)', async () => {
  const u = await newUser();
  await bind(u);
  await call('POST', '/api/v1/connections/bingx/sync', u);

  // биржа переоценила реализованный pnl первой позиции
  scenario.positionsBtc = scenario.positionsBtc.map((p) =>
    p.positionId === P1_ID ? { ...p, realizedProfit: '200.00' } : p,
  );
  const s = await call('POST', '/api/v1/connections/bingx/sync', u);
  expect(s.body?.imported).toBe(0);
  expect(s.body?.updated).toBe(2);
  const rows = await db.query<{ pnl_usd: string }>(
    `SELECT a.pnl_usd FROM auto_trades a JOIN connections c ON c.id = a.connection_id
     WHERE a.exchange_ref = $1 AND c.user_id = $2`,
    [P1_ID, u.id],
  );
  expect(rows.rows[0].pnl_usd).toBe('200.00');
});

it('sync без подключения → 404', async () => {
  const u = await newUser();
  const r = await call('POST', '/api/v1/connections/bingx/sync', u);
  expect(r.status).toBe(404);
});

it('sync с умершим ключом → 403 invalid_api_key (ключ отозван после bind)', async () => {
  const u = await newUser();
  await bind(u);
  scenario.rejectAll = true; // биржа отвергает подпись — ключ отозвали
  const r = await call('POST', '/api/v1/connections/bingx/sync', u);
  expect(r.status).toBe(403);
  expect(r.body?.error).toBe('invalid_api_key');
  const audit = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'bingx_sync_fail'`,
    [u.id],
  );
  expect(audit.rows[0].n).toBe(1);
});

// ─── w4: review fixes 1-4 (analyst PASS-with-notes) ───

it('fix1: rate-limit биржи (100419) на sync → 502 bingx_rate_limited, НЕ invalid_api_key', async () => {
  const u = await newUser();
  await bind(u);
  scenario.syncFailCode = 100419; // биржа душит по лимиту — ключ при этом живой
  const r = await call('POST', '/api/v1/connections/bingx/sync', u);
  expect(r.status).toBe(502);
  expect(r.body?.error).toBe('bingx_rate_limited');
  // юзер не должен ротировать рабочий ключ: подключение живо, повторный синк лечит
  expect((await call('GET', '/api/v1/connections', u)).body!.connections).toHaveLength(1);
  const audit = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'bingx_sync_fail'`,
    [u.id],
  );
  expect(audit.rows[0].n).toBe(1);
});

it('fix1: 100419 на bind-валидации → тоже 502 bingx_rate_limited (не «ключ невалиден»)', async () => {
  const u = await newUser();
  scenario.balanceCode = 100419;
  const r = await bind(u);
  expect(r.status).toBe(502);
  expect(r.body?.error).toBe('bingx_rate_limited');
});

it('fix2: два параллельных sync → один 200, второй 409 sync_in_progress (advisory lock)', async () => {
  const u = await newUser();
  await bind(u);
  const [a, b] = await Promise.all([
    call('POST', '/api/v1/connections/bingx/sync', u),
    call('POST', '/api/v1/connections/bingx/sync', u),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 409]); // лок гарантирует ровно одного победителя
  const conflict = a.status === 409 ? a : b;
  expect(conflict.body?.error).toBe('sync_in_progress');
  // победивший синк отработал целиком, дублей нет
  expect((await db.query('SELECT count(*)::int AS n FROM auto_trades')).rows[0].n).toBe(2);
});

it('fix4: ротация CONN_ENC_KEY → 503 conn_decrypt_failed, не голый 500 (+аудит, подключение живо)', async () => {
  const u = await newUser();
  await bind(u);
  const realKey = process.env.CONN_ENC_KEY as string;
  process.env.CONN_ENC_KEY = 'rotated-other-passphrase-w4-test'; // старый ct больше не расшифровывается
  let r: { status: number; body: Record<string, any> | null };
  try {
    r = await call('POST', '/api/v1/connections/bingx/sync', u);
  } finally {
    process.env.CONN_ENC_KEY = realKey;
  }
  expect(r.status).not.toBe(500); // не internal
  expect(r.status).toBe(503);
  expect(r.body?.error).toBe('conn_decrypt_failed');
  // graceful skip: строка подключения не снесена — лечится re-bind с replace
  const cnt = await db.query('SELECT count(*)::int AS n FROM connections WHERE user_id = $1', [u.id]);
  expect(cnt.rows[0].n).toBe(1);
  const audit = await db.query<{ detail: string }>(
    `SELECT detail FROM audit_log WHERE user_id = $1 AND action = 'bingx_sync_fail'`,
    [u.id],
  );
  expect(audit.rows[0].detail).toContain('conn_decrypt_failed');
});

// ─── unbind ───

it('unbind: подключение и авто-сделки снесены, re-bind работает; deleted_trades честно посчитан', async () => {
  const u = await newUser();
  await bind(u);
  await call('POST', '/api/v1/connections/bingx/sync', u);
  expect((await db.query('SELECT count(*)::int AS n FROM auto_trades')).rows[0].n).toBe(2);

  const r = await call('POST', '/api/v1/connections/bingx/unbind', u);
  expect(r.status).toBe(200);
  expect(r.body?.unbound).toBe(true);
  expect(r.body?.deleted_trades).toBe(2); // w4-fix3: ответ не молчит про потери

  expect((await call('GET', '/api/v1/connections', u)).body!.connections).toHaveLength(0);
  expect((await call('GET', '/api/v1/journal/auto', u)).body!.trades).toHaveLength(0);
  expect((await db.query('SELECT count(*)::int AS n FROM auto_trades')).rows[0].n).toBe(0); // каскад

  const audit = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'bingx_unbind'`,
    [u.id],
  );
  expect(audit.rows[0].n).toBe(1);

  const again = await bind(u);
  expect(again.status).toBe(201);
});

it('unbind без синка → deleted_trades: 0', async () => {
  const u = await newUser();
  await bind(u);
  const r = await call('POST', '/api/v1/connections/bingx/unbind', u);
  expect(r.status).toBe(200);
  expect(r.body?.deleted_trades).toBe(0);
});

it('unbind без подключения → 404', async () => {
  const u = await newUser();
  expect((await call('POST', '/api/v1/connections/bingx/unbind', u)).status).toBe(404);
});

// ─── rate-limit ───

it('rate-limit: 11-е действие юзера в минуту → 429', async () => {
  const u = await newUser();
  let last = 0;
  for (let i = 0; i < 11; i++) {
    last = (await call('GET', '/api/v1/connections/bingx/guide', u)).status;
  }
  expect(last).toBe(429);
});
