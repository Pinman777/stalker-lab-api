-- Дисциплина: ledger-only, все баллы — события. Идемпотентность:
-- UNIQUE(user_id, event_type, ref_type, ref_id) + ON CONFLICT DO NOTHING в функции начисления.
CREATE TABLE discipline_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  ref_type   TEXT NOT NULL,
  ref_id     BIGINT NOT NULL,
  points     INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_type, ref_type, ref_id)
);
CREATE INDEX discipline_events_user_idx ON discipline_events (user_id, created_at DESC);
