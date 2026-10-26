import { createHmac } from 'crypto';

/** HTTP-клиент BingX Perpetual Swap API v2 (домен open-api.bingx.com — live-проверен).
 *
 *  СХЕМА ПОДПИСИ — каноническая по официальным докам BingX API v2
 *  (bingx-api.github.io, «Signature Authentication»; сверена 2026-10 с текущими
 *  доками и официальным BingX api-ai-skills):
 *    1. все параметры запроса + timestamp (ms) сортируются по ключу в ASCII-порядке
 *       и склеиваются в `k=v&k=v` БЕЗ url-кодирования в подписываемой строке;
 *    2. signature = HmacSHA256(apiSecret, строка) → hex;
 *    3. signature добавляется в query: `…&signature=<hex>`;
 *    4. заголовок X-BX-APIKEY: apiKey.
 *  (Схема `${timestamp}GET${path}${queryString}` из ранних набросков ТЗ официальными
 *  доками НЕ подтверждена и не реализована — «реализуй канонично».)
 *
 *  Base URL инжектится через BINGX_API_BASE — тесты поднимают локальный мок-сервер.
 *  HTTP 200 ≠ успех: результат в теле {code, msg, data}, code !== 0 — ошибка. */

export const BINGX_DEFAULT_BASE = 'https://open-api.bingx.com';

/** BingX code 100419: превышен rate-limit запросов (5 req/s на юзера для trade-эндпоинтов).
 *  КРИТИЧНО отличать от ошибки ключа: ответ «ключ невалиден» на rate-limit заставляет
 *  юзера ротировать РАБОЧИЙ ключ. Все прочие code !== 0 в MVP не разделяются. */
export const BINGX_RATE_LIMIT_CODE = 100419;

export function bingxBaseUrl(): string {
  return process.env.BINGX_API_BASE || BINGX_DEFAULT_BASE;
}

/** Ошибка протокола BingX: HTTP дошёл, code !== 0 (невалидный ключ, rate-limit, …). */
export class BingXApiError extends Error {
  constructor(
    public readonly code: number,
    public readonly msg: string,
  ) {
    super(`bingx api error ${code}: ${msg}`);
    this.name = 'BingXApiError';
  }

  /** 100419 — биржа просит притормозить, ключ при этом живой. */
  get rateLimited(): boolean {
    return this.code === BINGX_RATE_LIMIT_CODE;
  }
}

/** Сеть не дошла (timeout/DNS/обрыв) — не путать с невалидным ключом. */
export class BingXUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`bingx unreachable: ${(cause as Error)?.message ?? cause}`);
    this.name = 'BingXUnreachableError';
  }
}

interface BingXResponse<T = unknown> {
  code: number;
  msg?: string;
  data?: T;
}

/** Подписанная строка параметров: ASCII-сортировка ключей, `k=v&…` без кодирования. */
export function buildCanonical(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/** Каноническая подпись BingX v2 (hex). */
export function signCanonical(apiSecret: string, params: Record<string, string | number>): string {
  return createHmac('sha256', apiSecret).update(buildCanonical(params)).digest('hex');
}

/** Подписанный GET. Наши параметры не содержат символов, требующих url-кодирования
 *  (значения — числа и SYMBOL-USDT), поэтому canonical строка = query string. */
export async function bingxSignedGet<T>(
  path: string,
  params: Record<string, string | number>,
  apiKey: string,
  apiSecret: string,
): Promise<T> {
  const all = { ...params, timestamp: Date.now() };
  const canonical = buildCanonical(all);
  const signature = createHmac('sha256', apiSecret).update(canonical).digest('hex');
  const url = `${bingxBaseUrl()}${path}?${canonical}&signature=${signature}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'X-BX-APIKEY': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new BingXUnreachableError(e);
  }
  let body: BingXResponse<T>;
  try {
    body = (await res.json()) as BingXResponse<T>;
  } catch (e) {
    throw new BingXUnreachableError(e);
  }
  if (body.code !== 0) throw new BingXApiError(body.code, body.msg ?? '');
  return body.data as T;
}

// ─── Типы эндпоинтов (поля по официальным докам v2) ──────────────────────────

/** GET /openApi/swap/v2/user/balance — валидация ключа при bind. */
export interface BingxBalance {
  asset: string;
  balance: string;
  equity: string;
}

export function fetchBalance(apiKey: string, apiSecret: string): Promise<BingxBalance> {
  return bingxSignedGet<BingxBalance>('/openApi/swap/v2/user/balance', {}, apiKey, apiSecret);
}

/** GET /openApi/swap/v2/user/income — поток PnL/фандинга; symbol опционален →
 *  используем для ОБНАРУЖЕНИЯ торгуемых символов (у positionHistory symbol обязателен). */
export interface BingxIncome {
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
}

export function fetchIncome(
  apiKey: string,
  apiSecret: string,
  startTime: number,
  endTime: number,
  currency: 'USDT' | 'USDC',
): Promise<BingxIncome[]> {
  return bingxSignedGet<BingxIncome[]>(
    '/openApi/swap/v2/user/income',
    { currency, startTime, endTime, limit: 1000 },
    apiKey,
    apiSecret,
  );
}

/** GET /openApi/swap/v2/trade/positionHistory — закрытые позиции (КЛЮЧЕВАЯ сводка полей
 *  по докам: positionId — string-BIGINT; positionSide LONG/SHORT; openTime — мс;
 *  updateTime — мс и есть ВРЕМЯ ЗАКРЫТИЯ; avgPrice — строка; avgClosePrice — число;
 *  realizedProfit — строка; leverage — int; closeAllPositions — позиция закрыта полностью).
 *  Пагинация: pageIndex от 0, pageSize ≤ 1000; окно startTime/endTime ≤ 90 дней. */
export interface BingxPositionHistoryItem {
  positionId: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  isolated: boolean;
  closeAllPositions: boolean;
  positionAmt: string;
  closePositionAmt: string;
  realizedProfit: string;
  netProfit: string;
  avgClosePrice: number | string;
  avgPrice: string;
  leverage: number;
  positionCommission: string;
  totalFunding: string;
  openTime: number;
  updateTime: number;
}

export function fetchPositionHistory(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  startTime: number,
  endTime: number,
  pageIndex: number,
  pageSize = 100,
): Promise<BingxPositionHistoryItem[]> {
  return bingxSignedGet<BingxPositionHistoryItem[]>(
    '/openApi/swap/v2/trade/positionHistory',
    { symbol, startTime, endTime, pageIndex, pageSize },
    apiKey,
    apiSecret,
  );
}
