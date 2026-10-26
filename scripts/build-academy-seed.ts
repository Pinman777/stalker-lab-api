import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Генератор content-сида академии (нед3): migrations/006_academy_seed.sql
 *  из РЕАЛЬНЫХ глав книги. Источник:
 *    ~/Obsidian-Home/20_Projects/Международный Цифровой Бизнес/книга-материалы/главы/глава-01..11.md
 *  H1 «Глава N. …» → lessons (ord, title); текст главы (с полевыми заметками) → body_md;
 *  секция «Проверь себя» → quiz JSONB (3 вопроса: вопрос + 3 варианта + индекс ответа + пояснение).
 *  Запуск: npx ts-node scripts/build-academy-seed.ts (файл сида коммитится, генератор — для регенерации). */

const CHAPTERS_DIR = join(
  process.env.HOME || '/home/zeon',
  'Obsidian-Home/20_Projects/Международный Цифровой Бизнес/книга-материалы/главы',
);
const OUT = join(__dirname, '..', 'migrations', '006_academy_seed.sql');
const COURSE_SLUG = 'kodex';
const COURSE_TITLE = 'Кодекс рыночного сталкера';
const LESSON_COUNT = 11;

interface QuizQuestion {
  question: string;
  options: string[];
  answer_idx: number;
  explanation: string;
}

interface Lesson {
  ord: number;
  slug: string;
  title: string;
  body_md: string;
  quiz: QuizQuestion[];
}

const LETTER_TO_IDX: Record<string, number> = { а: 0, б: 1, в: 2 };

function parseChapter(md: string, file: string): Lesson {
  const noFrontmatter = md.replace(/^---\n[\s\S]*?\n---\n/, '');

  const h1 = noFrontmatter.match(/^# (.+)$/m);
  if (!h1) throw new Error(`${file}: нет H1-заголовка главы`);
  const m = h1[1].trim().match(/^Глава\s+(\d+)\.\s*(.+)$/);
  if (!m) throw new Error(`${file}: H1 не вида «Глава N. Название»: ${h1[1]}`);
  const ord = Number(m[1]);
  const title = m[2].trim();

  const afterH1 = noFrontmatter.slice(noFrontmatter.indexOf(h1[0]) + h1[0].length);
  const parts = afterH1.split(/^## Проверь себя\s*$/m);
  if (parts.length !== 2) throw new Error(`${file}: секция «## Проверь себя» не найдена (или не одна)`);
  // тело урока: от H1 до квиза; колофон книги (после «---» за квизом) в урок не входит
  const body_md = parts[0].replace(/\n{3,}/g, '\n\n').trim();
  const quizSection = parts[1].split(/^---\s*$/m)[0];
  if (body_md.length === 0) throw new Error(`${file}: пустое body_md`);

  // парсинг квиза: «N. вопрос» / «- а) вариант» / «*Ответ: б. пояснение*»
  const quiz: QuizQuestion[] = [];
  let cur: { question: string; options: string[]; answer?: { idx: number; explanation: string } } | null = null;
  for (const line of quizSection.split('\n')) {
    const qm = line.match(/^\s*\d+\.\s+(.+)$/);
    if (qm) {
      if (cur) quiz.push(finish(cur, file));
      cur = { question: qm[1].trim(), options: [] };
      continue;
    }
    const om = line.match(/^\s*-\s*([абв])\)\s*(.+)$/);
    if (om && cur) {
      cur.options.push(om[2].trim());
      continue;
    }
    const am = line.match(/^\s*\*Ответ:\s*([абв])\.\s*(.*?)\s*\*\s*$/);
    if (am && cur) {
      cur.answer = { idx: LETTER_TO_IDX[am[1]], explanation: am[2].trim() };
    }
  }
  if (cur) quiz.push(finish(cur, file));
  if (quiz.length !== 3) throw new Error(`${file}: вопросов ${quiz.length}, ожидалось 3`);
  return { ord, slug: `lesson-${String(ord).padStart(2, '0')}`, title, body_md, quiz };
}

function finish(
  q: { question: string; options: string[]; answer?: { idx: number; explanation: string } },
  file: string,
): QuizQuestion {
  if (q.options.length !== 3) throw new Error(`${file}: у вопроса «${q.question.slice(0, 40)}…» опций ${q.options.length}, ожидалось 3`);
  if (!q.answer) throw new Error(`${file}: у вопроса «${q.question.slice(0, 40)}…» нет строки *Ответ: …*`);
  return { question: q.question, options: q.options, answer_idx: q.answer.idx, explanation: q.answer.explanation };
}

/** Dollar-quoting с защитой от коллизии тега с содержимым. */
function dq(text: string, tag: string): string {
  let t = tag;
  while (text.includes(`$${t}$`)) t += 'x';
  return `$${t}$${text}$${t}$`;
}

function main(): void {
  const lessons: Lesson[] = [];
  for (let i = 1; i <= LESSON_COUNT; i++) {
    const file = `глава-${String(i).padStart(2, '0')}.md`;
    lessons.push(parseChapter(readFileSync(join(CHAPTERS_DIR, file), 'utf8'), file));
  }
  lessons.sort((a, b) => a.ord - b.ord);

  const rows = lessons
    .map((l) => {
      const quizJson = JSON.stringify(l.quiz);
      return `  ((SELECT id FROM courses WHERE slug = '${COURSE_SLUG}'), ${l.ord}, '${l.slug}', ${dq(l.title, 't')},\n   ${dq(l.body_md, 'md')},\n   ${dq(quizJson, 'j')}::jsonb)`;
    })
    .join(',\n');

  const sql = `-- СГЕНЕРИРОВАНО scripts/build-academy-seed.ts из глав книги — руками не редактировать.
-- Источник: книга-материалы/главы/глава-01..11.md (черновики; регенерация перезапишет файл).
-- Курс «${COURSE_SLUG}» = 11 глав книги: H1 → урок, текст с полевыми заметками → body_md,
-- «Проверь себя» → quiz JSONB ({question, options[3], answer_idx, explanation}).

INSERT INTO courses (slug, title) VALUES ('${COURSE_SLUG}', ${dq(COURSE_TITLE, 't')})
ON CONFLICT (slug) DO NOTHING;

INSERT INTO lessons (course_id, ord, slug, title, body_md, quiz) VALUES
${rows}
ON CONFLICT (slug) DO NOTHING;

-- i18n-заглушки (нед3): en-строки с title-плейсхолдером (= ru) и body_md/quiz NULL —
-- API при lang=en фолбэчит body/quiz на ru; переводчики заменят title и заполнят поля.
INSERT INTO lesson_translations (lesson_id, locale, title, body_md, quiz)
SELECT id, 'en', title, NULL, NULL FROM lessons
WHERE course_id = (SELECT id FROM courses WHERE slug = '${COURSE_SLUG}')
ON CONFLICT (lesson_id, locale) DO NOTHING;
`;

  writeFileSync(OUT, sql);
  const totalQ = lessons.reduce((s, l) => s + l.quiz.length, 0);
  console.log(`ok: ${lessons.length} уроков, ${totalQ} вопросов квизов → ${OUT}`);
}

main();
