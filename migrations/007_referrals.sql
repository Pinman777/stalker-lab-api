-- Неделя 3: Рефералка (анти-MLM канон: только счётчики приглашённых, никаких оборотов/комиссий).
-- Привязка возникает в tx регистрации: юзер вошёл по инвайту r_XXX юзера X → строка здесь.
CREATE TABLE referrals (
  invited_uid  BIGINT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, -- PK = UNIQUE(invited_uid): у приглашённого ровно один реферер
  referrer_uid BIGINT NOT NULL REFERENCES users(id),
  invite_code  TEXT NOT NULL, -- какой код связал (r_-формат юзерских инвайтов)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_uid, created_at);
