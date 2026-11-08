import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'http';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';
import { runAutoSync } from '../src/modules/connections/auto-sync.provider';
import { ConnectionsService } from '../src/modules/connections/connections.service';

/** Авто-поллер BingX: один проход по всем подключениям импортирует закрытые
 *  позиции, идемпотентен (нет дублей), свежесинканные пропускает. */

let app: INestApplication;
let base: string;
let mock: Server;
let mockBase: string;
let tgSeq = 402_000;

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

async function newUser(): Promise<string> {
  const code = await createInviteCode(db, null, 1);
  const initData = signInitData(tgUserJson(++tgSeq));
  const res = await fetch(`${base}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ initData, inviteCode: code }),
  });
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

const POSITIONS = [
  { positionId: '9001', symbol: 'BTC-USDT', positionSide: 'LONG', openTime: 1, updateTime: Date.now() - 3600_000,
    avgPrice: '60000', avgClosePrice: '61000', realizedProfit: '42.5', leverage: 5, closeAllPositions: true },
];

/** Мини-мок BingX: balance (валидация ключа) + income (обнаружение символов) + positionHistory.
 *  Формат — как в connections.e2e.test.ts: {code:0, data:[...]} (массив, не обёртки). */
function startMock(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ok = (data: unknown) => send(200, { code: 0, msg: '', data });
    if (url.pathname.endsWith('/user/balance')) return ok({ asset: 'USDT', balance: '1000.00' });
    if (url.pathname.endsWith('/user/income')) {
      return ok(url.searchParams.get('currency') === 'USDC' ? [] : [{ symbol: 'BTC-USDT' }]);
    }
    if (url.pathname.endsWith('/trade/positionHistory')) {
      return ok(url.searchParams.get('pageIndex') === '0' ? POSITIONS : []);
    }
    send(404, { code: 404 });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${a.port}` });
    });
  });
}

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ server: mock, base: mockBase } = await startMock());
  process.env.BINGX_API_BASE = mockBase;
  ({ app, base } = await startApp());
});

beforeEach(async () => {
  await truncateAll(db);
  POSITIONS[0].updateTime = Date.now() - 3600_000;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

async function bind(userId: string): Promise<void> {
  // строку подключения создаём сервисом напрямую (HTTP-путь с initData тут не нужен)
  const svc = app.get(ConnectionsService);
  await svc.bindBingx(userId, 'test-api-key', 'test-api-secret', false, 'test');
}

describe('auto-sync поллер', () => {
  it('прогон импортирует закрытые позиции и двигает last_sync_at', async () => {
    const uid = await newUser();
    await bind(uid);
    const svc = app.get(ConnectionsService);
    const out = await runAutoSync(svc);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    expect(out[0].imported).toBe(1);
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM auto_trades');
    expect(rows.rows[0].n).toBe(1);
    const conn = await db.query<{ last_sync_at: Date | null }>(
      'SELECT last_sync_at FROM connections WHERE user_id = $1', [uid],
    );
    expect(conn.rows[0].last_sync_at).not.toBeNull();
  });

  it('повторный прогон не дублирует сделки (идемпотентность)', async () => {
    const uid = await newUser();
    await bind(uid);
    const svc = app.get(ConnectionsService);
    await runAutoSync(svc);
    // имитируем прошедшие >15 минут: сдвигаем last_sync_at назад
    await db.query(`UPDATE connections SET last_sync_at = now() - interval '20 minutes' WHERE user_id = $1`, [uid]);
    const out2 = await runAutoSync(svc);
    expect(out2[0].ok).toBe(true);
    expect(out2[0].imported).toBe(0); // уже было — только update
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM auto_trades');
    expect(rows.rows[0].n).toBe(1);
  });

  it('свежесинканное подключение пропускается без похода на биржу', async () => {
    const uid = await newUser();
    await bind(uid);
    const svc = app.get(ConnectionsService);
    await runAutoSync(svc);
    // мок теперь «отдаёт» только НОВУЮ позицию — если поллер пойдёт на биржу, импортнёт её
    POSITIONS.push({ positionId: '9002', symbol: 'BTC-USDT', positionSide: 'SHORT', openTime: 2, updateTime: Date.now(),
      avgPrice: '3000', avgClosePrice: '2990', realizedProfit: '10', leverage: 3, closeAllPositions: true });
    try {
      const out = await runAutoSync(svc); // last_sync_at свежий → пропуск
      expect(out[0].ok).toBe(true);
      expect(out[0].imported).toBeUndefined();
      const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM auto_trades');
      expect(rows.rows[0].n).toBe(1); // вторая позиция НЕ импортирована
    } finally {
      POSITIONS.splice(1, 1);
    }
  });

  it('без подключений — тихий пустой прогон', async () => {
    await newUser();
    const svc = app.get(ConnectionsService);
    const out = await runAutoSync(svc);
    expect(out).toHaveLength(0);
  });
});
