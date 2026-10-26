-- Неделя 2 (скелет нед1): журнал-ядро. entries = сессия-вылазка, trades = сделки сессии.
-- Разделение обязательно (АРХИТЕКТУРА §2). violation_code → каталог codex_rules (нед2+), FK пока не ставим.
CREATE TABLE journal_entries (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  plan       TEXT NOT NULL,
  review     TEXT,
  status     TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_user_date_idx ON journal_entries (user_id, date DESC);

CREATE TABLE journal_trades (
  id             BIGSERIAL PRIMARY KEY,
  entry_id       BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  sym            TEXT NOT NULL,
  dir            TEXT NOT NULL CHECK (dir IN ('long', 'short')),
  entry          NUMERIC NOT NULL,
  stop           NUMERIC NOT NULL,
  exit           NUMERIC NOT NULL,
  r              NUMERIC,
  setup          TEXT,
  violation_code TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX journal_trades_entry_idx ON journal_trades (entry_id);
