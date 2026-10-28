import type { INestApplication } from '@nestjs/common';
import { db } from '../src/db/db';
import { createInviteCode } from '../src/modules/invites/invites.service';
import { ensureTestDb, resetSchema, signInitData, startApp, tgUserJson, truncateAll } from './helpers';

/** E2E академия (нед3): курс kodex из 11 глав книги, квиз без поля-ответа, лестница
 *  прогресс-гейтов (урок N+1 закрыт до N), ≥2/3 верных → passed + 20 дисциплины
 *  идемпотентно, i18n-фолбэк en→ru, валидация входа. */

let app: INestApplication;
let base: string;

interface User {
  initData: string;
  id: number;
}

function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

let tgSeq = 203_000;

/** Юзер через полный путь: initData + инвайт (rate-limiter — свежий IP). */
async function newUser(): Promise<User> {
  const code = await createInviteCode(db, null, 1);
  const initData = signInitData(tgUserJson(++tgSeq));
  const res = await fetch(`${base}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ initData, inviteCode: code }),
  });
  if (res.status !== 200) throw new Error(`newUser auth failed: ${res.status}`);
  const body = (await res.json()) as { user: { id: number } };
  return { initData, id: body.user.id };
}

function h(u: User): Record<string, string> {
  return { 'content-type': 'application/json', 'x-telegram-init-data': u.initData };
}

async function call(
  method: string,
  path: string,
  user: User,
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: Record<string, any> | null = null;
  try {
    parsed = (await res.json()) as Record<string, any>;
  } catch {
    /* пустое тело */
  }
  return { status: res.status, body: parsed };
}

/** Правильные/неправильные индексы ответов — из сида (не хардкод из книги). */
async function seedAnswers(slug: string): Promise<number[]> {
  const r = await db.query<{ quiz: { answer_idx: number }[] }>('SELECT quiz FROM lessons WHERE slug = $1', [slug]);
  return r.rows[0].quiz.map((q) => q.answer_idx);
}

function wrongIdx(answerIdx: number): number {
  return (answerIdx + 1) % 3;
}

beforeAll(async () => {
  await ensureTestDb();
  await resetSchema(db);
  ({ app, base } = await startApp());
});

afterAll(async () => {
  await app.close(); // AppModule.onApplicationShutdown → db.end()
});

beforeEach(async () => {
  await truncateAll(db);
});

// --- каталог ---

it('GET /academy/courses: курс kodex, 11 уроков-глав по порядку, никто не пройден', async () => {
  const u = await newUser();
  const r = await call('GET', '/api/v1/academy/courses', u);
  expect(r.status).toBe(200);
  expect(Array.isArray(r.body)).toBe(true);
  const courses = r.body as { slug: string; title: string; lessons: { ord: number; slug: string; title: string; passed: boolean }[] }[];
  expect(courses).toHaveLength(1);
  expect(courses[0].slug).toBe('kodex');
  expect(courses[0].title).toBe('Кодекс рыночного сталкера');
  expect(courses[0].lessons.map((l) => l.slug)).toEqual(
    Array.from({ length: 11 }, (_, i) => `lesson-${String(i + 1).padStart(2, '0')}`),
  );
  expect(courses[0].lessons.every((l) => l.title.length > 0)).toBe(true);
  expect(courses[0].lessons.every((l) => l.passed === false)).toBe(true);
});

it('GET /academy/lessons/lesson-01: тело главы + квиз из 3 вопросов БЕЗ поля-ответа', async () => {
  const u = await newUser();
  const r = await call('GET', '/api/v1/academy/lessons/lesson-01', u);
  expect(r.status).toBe(200);
  expect(r.body!.slug).toBe('lesson-01');
  expect(r.body!.ord).toBe(1);
  expect(r.body!.title).toBe('Зона не обещает — Зона наказывает');
  expect((r.body!.body_md as string).length).toBeGreaterThan(500); // текст главы с полевыми заметками
  expect((r.body!.body_md as string)).toContain('Полевая заметка'); // заметки на месте
  const quiz = r.body!.quiz as Record<string, unknown>[];
  expect(quiz).toHaveLength(3);
  for (const q of quiz) {
    expect((q.options as string[])).toHaveLength(3);
    expect(q.answer_idx).toBeUndefined(); // поле-ответ не утекло
    expect(q.explanation).toBeUndefined();
    expect((q.question as string).length).toBeGreaterThan(0);
  }
});

it('лестница: lesson-02 до прохождения lesson-01 → 403 lesson_locked (и контент, и квиз)', async () => {
  const u = await newUser();
  const locked = await call('GET', '/api/v1/academy/lessons/lesson-02', u);
  expect(locked.status).toBe(403);
  expect(locked.body!.error).toBe('lesson_locked');

  const answers = await seedAnswers('lesson-01');
  const quiz = await call('POST', '/api/v1/academy/lessons/lesson-02/quiz', u, { question: 0, answer: answers[0] });
  expect(quiz.status).toBe(403);
  expect(quiz.body!.error).toBe('lesson_locked');

  // глубокая лестница: урок 5 закрыт, пока не пройден 4
  const deep = await call('GET', '/api/v1/academy/lessons/lesson-05', u);
  expect(deep.body!.error).toBe('lesson_locked');
});

it('квиз: неверный ответ — correct=false, без пояснения, без баллов и passed', async () => {
  const u = await newUser();
  const [a0] = await seedAnswers('lesson-01');
  const r = await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 0, answer: wrongIdx(a0) });
  expect(r.status).toBe(200);
  expect(r.body!.correct).toBe(false);
  expect(r.body!.explanation).toBeUndefined();
  expect(r.body!.passed).toBe(false);

  const progress = await call('GET', '/api/v1/academy/progress', u);
  expect(progress.body!.passed_lessons).toEqual([]);
  expect(progress.body!.points).toBe(0);
});

it('квиз: 1 верный из 3 — ещё не пройден; 2-й верный → passed + 20 дисциплины', async () => {
  const u = await newUser();
  const a = await seedAnswers('lesson-01');

  const first = await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 0, answer: a[0] });
  expect(first.body!.correct).toBe(true);
  expect(first.body!.passed).toBe(false); // 1/3 — мало
  expect(typeof first.body!.explanation).toBe('string');

  const second = await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 1, answer: a[1] });
  expect(second.body!.correct).toBe(true);
  expect(second.body!.passed).toBe(true); // 2/3 — порог пройден

  const stats = await call('GET', '/api/v1/me/stats', u);
  expect(stats.body!.points).toBe(20);
  expect(stats.body!.byType.academy_lesson).toEqual({ events: 1, points: 20 });

  const progress = await call('GET', '/api/v1/academy/progress', u);
  expect(progress.body!.passed_lessons).toEqual(['lesson-01']);
  expect(progress.body!.points).toBe(20);
});

it('дисциплина за урок идемпотентна: повторные ответы не дублируют баллы', async () => {
  const u = await newUser();
  const a = await seedAnswers('lesson-01');
  await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 0, answer: a[0] });
  await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 1, answer: a[1] }); // passed
  // переспрашиваем уже отвеченное и добиваем третий — событий ledger не прибавляется
  await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 0, answer: a[0] });
  await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 2, answer: a[2] });

  const stats = await call('GET', '/api/v1/me/stats', u);
  expect(stats.body!.points).toBe(20);
  expect(stats.body!.byType.academy_lesson.events).toBe(1);

  const ledger = await db.query(
    `SELECT count(*)::int AS n FROM discipline_events WHERE user_id = $1 AND event_type = 'academy_lesson'`,
    [u.id],
  );
  expect(ledger.rows[0].n).toBe(1);
});

it('после прохождения урока 1 урок 2 открывается; прогресс-гейт снимается', async () => {
  const u = await newUser();
  const a1 = await seedAnswers('lesson-01');
  await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 0, answer: a1[0] });
  await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 1, answer: a1[1] });

  const next = await call('GET', '/api/v1/academy/lessons/lesson-02', u);
  expect(next.status).toBe(200);
  expect(next.body!.ord).toBe(2);
  expect(next.body!.quiz).toHaveLength(3);

  const courses = (await call('GET', '/api/v1/academy/courses', u)).body as { lessons: { slug: string; passed: boolean }[] }[];
  const bySlug = Object.fromEntries(courses[0].lessons.map((l) => [l.slug, l.passed]));
  expect(bySlug['lesson-01']).toBe(true);
  expect(bySlug['lesson-02']).toBe(false);
});

// --- валидация и i18n ---

it('квиз: невалидные индексы / битое тело → 400; неизвестный урок → 404', async () => {
  const u = await newUser();
  expect((await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 3, answer: 0 })).status).toBe(400);
  expect((await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { question: 0, answer: 7 })).status).toBe(400);
  expect((await call('POST', '/api/v1/academy/lessons/lesson-01/quiz', u, { answer: 0 })).status).toBe(400);
  expect((await call('GET', '/api/v1/academy/lessons/ghost-lesson', u)).status).toBe(404);
  expect((await call('GET', '/api/v1/academy/courses?lang=de', u)).status).toBe(400);
});

it('i18n: lang=en отдаёт ru-фолбэком (en-заглушка: body_md/quiz NULL в translations)', async () => {
  const u = await newUser();
  const en = await call('GET', '/api/v1/academy/lessons/lesson-01?lang=en', u);
  expect(en.status).toBe(200);
  expect((en.body!.body_md as string).length).toBeGreaterThan(500); // ru-контент, не пустышка
  expect(en.body!.quiz).toHaveLength(3);

  const ru = await call('GET', '/api/v1/academy/lessons/lesson-01', u);
  expect(en.body!.body_md).toBe(ru.body!.body_md); // фолбэк идентичен канону

  // en-строки сидированы как заглушки (title = ru, body NULL) — форма i18n с первого дня
  const tr = await db.query<{ locale: string; title: string; body_md: string | null }>(
    `SELECT t.locale, t.title, t.body_md FROM lesson_translations t
     JOIN lessons l ON l.id = t.lesson_id WHERE l.slug = 'lesson-01'`,
  );
  expect(tr.rows.map((r) => r.locale).sort()).toEqual(['en']);
  expect(tr.rows[0].body_md).toBeNull();
});

it('без аутентификации академия закрыта → 401', async () => {
  const res = await fetch(`${base}/api/v1/academy/courses`);
  expect(res.status).toBe(401);
});
