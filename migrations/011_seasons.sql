-- Сезоны-рейды: календарь сезонных турниров клуба. Участие автоматическое —
-- каждая вылазка в журнале внутри окна сезона идёт в зачёт. Итоги/лиги
-- считаются на лету из journal_* (нет дублирования данных).
CREATE TABLE IF NOT EXISTS seasons (
  id        bigserial PRIMARY KEY,
  code      text NOT NULL UNIQUE,          -- 'S1'
  title     text NOT NULL,                 -- «Бумажная лига»
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  fund_usd  int,                           -- призовой фонд (NULL = объявляется)
  status    text NOT NULL DEFAULT 'active' -- active | finished
);

-- Сезон 01: старт с запуска клубной механики, финиш в конце ноября.
INSERT INTO seasons (code, title, starts_at, ends_at, fund_usd, status) VALUES
  ('S1', 'Бумажная лига', '2026-10-28 00:00:00+03', '2026-11-30 23:59:59+03', NULL, 'active')
ON CONFLICT (code) DO NOTHING;
