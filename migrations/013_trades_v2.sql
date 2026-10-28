-- Вылазки v2 (волна 1): сетап-флоу «план → сетап(armed) → вход(entered) → разбор(closed)».
-- journal_entries.plan_meta: структурированный план дня {mode, riskDayR, maxTrades, watchlist[], noGo}.
-- journal_trades: статусная машина + тейк + поля калькулятора + времена.
-- exit теперь nullable (у armed-сетапа выхода ещё нет); r считается бэком автоматически.
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS plan_meta JSONB;

ALTER TABLE journal_trades
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'closed'
    CHECK (status IN ('draft', 'armed', 'entered', 'closed', 'cancelled')),
  ADD COLUMN IF NOT EXISTS take_profit NUMERIC,
  ADD COLUMN IF NOT EXISTS notional_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS risk_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS risk_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_kind TEXT CHECK (exit_kind IN ('stop', 'take', 'manual'));

ALTER TABLE journal_trades ALTER COLUMN exit DROP NOT NULL;

CREATE INDEX IF NOT EXISTS journal_trades_entry_status_idx ON journal_trades (entry_id, status);
