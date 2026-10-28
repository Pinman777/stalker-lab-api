-- Отзыв веб-токенов: logout гасит ВСЕ сессии юзера (не по токену, а по пользователю).
-- Гвард: JWT с iat ≤ token_revoked_at → 401. Токены без iat (выданные до фикса)
-- при активном revocation тоже мертвы — консервативно безопасно.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_revoked_at timestamptz;
