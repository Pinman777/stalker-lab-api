-- Неделя 2: журнал-ядро. Одна сессия-вылазка на день + кодекс нарушений.

-- РЕШЕНО (АРХИТЕКТУРА нед2): UNIQUE(user_id, date) — одна сессия на день.
-- Повторный POST с той же датой → 23505 → 409 entry_exists (идемпотентность на стороне клиента).
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_user_date_uniq UNIQUE (user_id, date);

-- Кодекс Сталкера: каталог нарушений (5 принципов идеологии → коды).
-- violation_code сделки ссылается сюда; сделка с нарушением не даёт баллов и пишется в audit.
CREATE TABLE codex_rules (
  code      TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  principle TEXT NOT NULL
);
INSERT INTO codex_rules (code, title, principle) VALUES
  ('risk_moved',      'Перенос стопа',       'Снаряжение дороже артефакта'),
  ('no_journal_entry','Вылазка без дебрифа', 'Каждая вылазка — урок'),
  ('no_setup',        'Вход без сетапа',     'Зона не обещает'),
  ('no_disclosure',   'Разглашение позиций', 'Тишина — признак опасности'),
  ('overtrade',       'Овертрейд',           'Сталкер не бросает своих');

-- Нед1 оставляла FK «пока не ставим» — каталог готов, ставим.
ALTER TABLE journal_trades
  ADD CONSTRAINT journal_trades_violation_code_fkey
  FOREIGN KEY (violation_code) REFERENCES codex_rules(code);
