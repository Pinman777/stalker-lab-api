-- Реферальное вознаграждение (внутренняя валюта): +REFERRAL_BONUS за каждого
-- зарегистрировавшегося приглашённого. Начисление — в tx insertReferral.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_points int NOT NULL DEFAULT 0;
