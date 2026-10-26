-- Неделя 1: identity + INVITE-ONLY + аудит.
-- users: stateless — юзер создаётся при первом валидном initData + валидном инвайте.
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL UNIQUE,
  username      TEXT,
  first_name    TEXT,
  language      TEXT NOT NULL DEFAULT 'en',
  timezone      TEXT,
  is_blocked    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- INVITE-ONLY: коды одноразовые (валиден = used_by IS NULL; погашение атомарно в tx создания юзера).
-- quota — квота на ранг для генерации (АРХИТЕКТУРА §2); нед1: храним, рангов ещё нет.
CREATE TABLE invite_codes (
  code       TEXT PRIMARY KEY,
  created_by BIGINT REFERENCES users(id), -- NULL = системный/бутстрап-инвайт (пока нет юзеров)
  used_by    BIGINT REFERENCES users(id),
  used_at    TIMESTAMPTZ,
  quota      INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Аудит юзер-безопасности: auth-попытки, invite-use, rate-limit (АРХИТЕКТУРА §5).
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ip         TEXT NOT NULL,
  action     TEXT NOT NULL,   -- auth_ok | auth_fail | auth_rate_limited | invite_used
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at);
