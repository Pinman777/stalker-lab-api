-- Неделя 3: Академия (АРХИТЕКТУРА §2). Главы книги = уроки, «Проверь себя» = квизы.
-- Курс «kodex» сидируется в 006_academy_seed.sql из реальных глав книги.

CREATE TABLE courses (
  id    BIGSERIAL PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL -- канонический (ru) заголовок курса
);

-- Урок: канонический контент (ru) в базе; переводы — в lesson_translations.
-- quiz JSONB: [{"question": str, "options": [str x3], "answer_idx": 0|1|2, "explanation": str}]
-- answer_idx/explanation наружу НЕ отдаются (поле-ответ вырезается в API).
CREATE TABLE lessons (
  id        BIGSERIAL PRIMARY KEY,
  course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,            -- «лестница книги»: урок N+1 закрыт до прохождения N
  slug      TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL,
  body_md   TEXT NOT NULL,               -- текст главы с полевыми заметками
  quiz      JSONB NOT NULL,
  UNIQUE (course_id, ord)
);

-- i18n с первого дня: пер-полевой фолбэк на канон (ru), если поле NULL.
CREATE TABLE lesson_translations (
  lesson_id BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  locale    TEXT NOT NULL CHECK (locale IN ('ru', 'en')),
  title     TEXT,        -- заглушка (seed: = ru title), переводчики заменят
  body_md   TEXT,        -- NULL → API отдаёт ru
  quiz      JSONB,       -- NULL → API отдаёт ru
  UNIQUE (lesson_id, locale)
);

-- Прогресс юзера по уроку. quiz_state: {"0": true, "1": true} — индексы верно отвеченных
-- вопросов квиза. passed = верных ≥ 2 из 3 (ACADEMY pass threshold, нед3).
CREATE TABLE lesson_progress (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id  BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  quiz_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  passed     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);
