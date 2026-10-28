#!/usr/bin/env node
/** Мок-сервер BingX Perpetual Swap API v2 для локального флоу (scripts/flow-week4.sh).
 *
 *  Проверяет КАНОНИЧЕСКУЮ подпись (ASCII-сортировка параметров → HmacSHA256 → signature
 *  + заголовок X-BX-APIKEY), после чего отдаёт правдоподобные данные:
 *    /openApi/swap/v2/user/balance           → code 0 (ключ валиден)
 *    /openApi/swap/v2/user/income            → потоки BTC-USDT/ETH-USDT (обнаружение символов)
 *    /openApi/swap/v2/trade/positionHistory  → 2 закрытые + 1 открытая позиция BTC-USDT
 *  Порт: BINGX_MOCK_PORT (default 8931). Ключи: BINGX_MOCK_API_KEY / BINGX_MOCK_API_SECRET. */
const { createHmac } = require('crypto');
const http = require('http');

const PORT = Number(process.env.BINGX_MOCK_PORT || 8931);
const API_KEY = process.env.BINGX_MOCK_API_KEY || 'flow-bingx-api-key-abcdefghijklmnop';
const API_SECRET = process.env.BINGX_MOCK_API_SECRET || 'flow-bingx-secret-0123456789abcdefghij';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function position(positionId, side, openOffsetDays, closeOffsetDays, realizedProfit, closed = true) {
  return {
    positionId,
    symbol: 'BTC-USDT',
    positionSide: side,
    isolated: false,
    closeAllPositions: closed,
    positionAmt: '0.0100',
    closePositionAmt: closed ? '0.0100' : '0.0040',
    realizedProfit,
    netProfit: realizedProfit,
    avgClosePrice: 64250.5,
    avgPrice: '64100.25',
    leverage: 10,
    positionCommission: '-0.05',
    totalFunding: '0.0001',
    openTime: NOW - openOffsetDays * DAY,
    updateTime: NOW - closeOffsetDays * DAY,
  };
}

const POSITIONS_BTC = [
  position('1930451234567890123', 'LONG', 5, 4, '125.40'),
  position('1930459876543210987', 'SHORT', 3, 2, '-40.10'),
  position('1930450000000000001', 'LONG', 1, 0, '5.00', false), // открытая — не импортируется
];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://mock');
  const q = u.searchParams;
  const fail = (code, msg) => res.end(JSON.stringify({ code, msg, timestamp: Date.now() }));
  const ok = (data) => res.end(JSON.stringify({ code: 0, msg: '', data }));

  res.writeHead(200, { 'content-type': 'application/json' });

  if (req.headers['x-bx-apikey'] !== API_KEY) return fail(100413, 'Null apiKey / wrong key');
  const signature = q.get('signature');
  if (!signature || !q.get('timestamp')) return fail(100413, 'no signature/timestamp');
  const params = {};
  q.forEach((v, k) => { if (k !== 'signature') params[k] = v; });
  const canonical = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const expected = createHmac('sha256', API_SECRET).update(canonical).digest('hex');
  if (signature !== expected) return fail(100414, 'signature error');
  console.log(`[bingx-mock] GET ${u.pathname} ${canonical.slice(0, 80)}…`);

  if (u.pathname === '/openApi/swap/v2/user/balance') {
    return ok({ asset: 'USDT', balance: '1000.00', equity: '1005.40' });
  }
  if (u.pathname === '/openApi/swap/v2/user/income') {
    if (q.get('currency') === 'USDC') return ok([]);
    return ok([
      { symbol: 'BTC-USDT', incomeType: 'REALIZED_PROGRESS', income: '125.40', asset: 'USDT', time: NOW - 4 * DAY },
      { symbol: 'ETH-USDT', incomeType: 'FUNDING_FEE', income: '-0.02', asset: 'USDT', time: NOW - 2 * DAY },
    ]);
  }
  if (u.pathname === '/openApi/swap/v2/trade/positionHistory') {
    if (q.get('pageIndex') !== '0') return ok([]);
    if (q.get('symbol') === 'BTC-USDT') return ok(POSITIONS_BTC);
    return ok([]);
  }
  return fail(100400, 'this api is not exist');
});

server.listen(PORT, '127.0.0.1', () => console.log(`[bingx-mock] listening on :${PORT}, подпись проверяется`));
