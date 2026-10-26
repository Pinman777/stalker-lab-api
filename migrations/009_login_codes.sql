-- Неделя 5: web-вход по одноразовому коду из TG (юзер в TMA → код в личку → JWT в браузере).
-- users.username уже существует (001_identity) — колонку не дублируем.
-- Один активный код на юзера: неиспользованные гасятся при новом запросе (used_at = now).
CREATE TABLE login_codes (
  id               BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  code             TEXT NOT NULL,               -- 6 цифр
  expires_at       TIMESTAMPTZ NOT NULL,        -- +10 минут от created_at
  used_at          TIMESTAMPTZ,                 -- NULL = активен (погашен / инвалидирован)
  attempts         INTEGER NOT NULL DEFAULT 0,  -- 5 промахов → код гасится
  ip               TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_user_used_idx ON login_codes (telegram_user_id, used_at);
