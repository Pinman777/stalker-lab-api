-- Неделя 4: автожурнал (killer-фича, TMM/IZ-паттерн «сделки добавляются сами»).
-- Часть 1: биржевые подключения. Часть 2: авто-сделки из BingX.

-- ════════════════════════════════════════════════════════════════════════
-- ИДЕОЛОГИЯ (зафиксировано намеренно, см. также connections.service.ts):
--
--   АВТО-СДЕЛКИ НЕ ДАЮТ БАЛЛОВ ДИСЦИПЛИНЫ.
--
-- Баллы дисциплины — за осознанную работу: план (journal_entry +5),
-- ручную запись сделки (journal_trade +5), разбор (journal_review +3).
-- Авто-импорт — это только ФАКТЫ и СТАТИСТИКА (что реально произошло на
-- бирже), без субъективной дисциплины. Ни при каком событии auto_trades
-- не пишет в discipline_events.
-- ════════════════════════════════════════════════════════════════════════

-- Подключения к биржам. Один юзер = одно подключение на venue (UNIQUE ниже).
CREATE TABLE connections (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue          TEXT NOT NULL,                        -- 'bingx' (V1: другие биржи)
  api_key        TEXT NOT NULL,                        -- НЕ секрет (публичный идентификатор), храним как есть
  api_secret_enc TEXT NOT NULL,                        -- AES-256-GCM, формат v1:<salt>:<iv>:<tag>:<ct> (base64), см. secret-crypto.ts
  masked         TEXT NOT NULL,                        -- 'AB…YZ' для UI
  bound_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at   TIMESTAMPTZ                           -- NULL = синка не было
);
-- Повторный bind того же venue → 23505 → 409 connection_exists (или replace-флаг).
CREATE UNIQUE INDEX connections_user_venue_uniq ON connections (user_id, venue);

-- Авто-сделки: закрытые позиции, импортированные REST-синком из BingX
-- (GET /openApi/swap/v2/trade/positionHistory, канонический эндпоинт по докам
-- BingX API v2; live-проверка 2026-10: домен open-api.bingx.com).
-- unbind каскадит: авто-сделки без подключения теряют связь с юзером,
-- честнее снести их вместе с подключением, чем оставить сиротами (MVP-решение).
CREATE TABLE auto_trades (
  id            BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  exchange_ref  TEXT NOT NULL,          -- BingX positionId (BIGINT-string: > MAX_SAFE_INTEGER, не Number()!)
  symbol        TEXT NOT NULL,          -- 'BTC-USDT'
  side          TEXT NOT NULL CHECK (side IN ('long', 'short')),
  open_time     TIMESTAMPTZ NOT NULL,
  close_time    TIMESTAMPTZ NOT NULL,   -- BingX updateTime закрытой позиции
  entry_price   NUMERIC NOT NULL,       -- avgPrice
  exit_price    NUMERIC NOT NULL,       -- avgClosePrice
  pnl_usd       NUMERIC NOT NULL,       -- realizedProfit (USDT-расчёт ≈ USD)
  leverage      INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Идемпотентный ре-синк: повторный POST /sync не дублирует сделки,
  -- а обновляет существующие (частичное закрытие → полное меняет pnl).
  UNIQUE (connection_id, exchange_ref)
);
CREATE INDEX auto_trades_connection_close_idx ON auto_trades (connection_id, close_time DESC);
