import { Injectable } from '@nestjs/common';
import { db } from '../../db/db';
import type { Executor } from '../../db/db';
import { errors } from '../../common/errors';
import { awardDisciplinePoints } from '../discipline/discipline.service';

/** Академия (нед3, АРХИТЕКТУРА §2): главы книги = уроки. Прогресс — «лестница книги»:
 *  урок N+1 закрыт, пока не пройден N. Квиз урока: 3 вопроса, верных ≥ 2 → урок пройден,
 *  +20 дисциплины (academy_lesson, идемпотентно через ledger). */
export const ACADEMY_POINTS = { lesson: 20 } as const;
export const QUIZ_PASS_THRESHOLD = 2; // верных из 3

/** Внутренний формат вопроса квиза (в БД). Наружу — без answer_idx/explanation. */
interface QuizQuestion {
  question: string;
  options: string[];
  answer_idx: number;
  explanation: string;
}

export interface QuizQuestionPublic {
  question: string;
  options: string[];
}

export interface LessonBriefDto {
  ord: number;
  slug: string;
  title: string;
  passed: boolean;
}

export interface CourseDto {
  slug: string;
  title: string;
  lessons: LessonBriefDto[];
}

export interface LessonDto {
  slug: string;
  ord: number;
  title: string;
  body_md: string;
  quiz: QuizQuestionPublic[];
  passed: boolean;
}

export interface QuizAnswerResult {
  correct: boolean;
  explanation?: string;
  passed: boolean;
}

export interface AcademyProgressDto {
  passed_lessons: string[];
  points: number;
}

interface LessonFullRow {
  id: string;
  course_id: string;
  ord: number;
  slug: string;
  title: string;
  body_md: string;
  quiz: QuizQuestion[];
  loc_title: string;
  loc_body_md: string;
  loc_quiz: QuizQuestion[];
}

function publicQuiz(quiz: QuizQuestion[]): QuizQuestionPublic[] {
  return quiz.map((q) => ({ question: q.question, options: q.options }));
}

/** Лестница: урок доступен, если предыдущий (ord-1, тот же курс) пройден. Первый — всегда. */
async function assertLessonUnlocked(
  exec: Executor,
  userId: string,
  courseId: string,
  ord: number,
): Promise<void> {
  const prev = await exec.query<{ passed: boolean | null }>(
    `SELECT p.passed
     FROM lessons l
     LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.user_id = $1
     WHERE l.course_id = $2 AND l.ord = $3`,
    [userId, courseId, ord - 1],
  );
  if (prev.rows[0] && prev.rows[0].passed !== true) throw errors.lessonLocked();
}

@Injectable()
export class AcademyService {
  /** GET /academy/courses: все курсы с уроками и passed-флагами юзера. Локаль — только заголовки. */
  async listCourses(userId: string, locale: string): Promise<CourseDto[]> {
    const r = await db.query<{
      course_slug: string;
      course_title: string;
      ord: number;
      slug: string;
      loc_title: string;
      passed: boolean;
    }>(
      `SELECT c.slug AS course_slug, c.title AS course_title,
              l.ord, l.slug, coalesce(t.title, l.title) AS loc_title,
              EXISTS (SELECT 1 FROM lesson_progress p
                      WHERE p.user_id = $1 AND p.lesson_id = l.id AND p.passed) AS passed
       FROM courses c
       JOIN lessons l ON l.course_id = c.id
       LEFT JOIN lesson_translations t ON t.lesson_id = l.id AND t.locale = $2
       ORDER BY c.id, l.ord`,
      [userId, locale],
    );
    const courses: CourseDto[] = [];
    for (const row of r.rows) {
      let course = courses.find((c) => c.slug === row.course_slug);
      if (!course) {
        course = { slug: row.course_slug, title: row.course_title, lessons: [] };
        courses.push(course);
      }
      course.lessons.push({ ord: row.ord, slug: row.slug, title: row.loc_title, passed: row.passed });
    }
    return courses;
  }

  /** GET /academy/lessons/:slug: контент урока; квиз без поля-ответа. Локаль — пер-полевой фолбэк. */
  async getLesson(userId: string, slug: string, locale: string): Promise<LessonDto> {
    const r = await db.query<LessonFullRow & { passed: boolean }>(
      `SELECT l.id, l.course_id, l.ord, l.slug, l.body_md, l.quiz,
              coalesce(t.title, l.title) AS loc_title,
              coalesce(t.body_md, l.body_md) AS loc_body_md,
              coalesce(t.quiz, l.quiz) AS loc_quiz,
              EXISTS (SELECT 1 FROM lesson_progress p
                      WHERE p.user_id = $1 AND p.lesson_id = l.id AND p.passed) AS passed
       FROM lessons l
       LEFT JOIN lesson_translations t ON t.lesson_id = l.id AND t.locale = $2
       WHERE l.slug = $3`,
      [userId, locale, slug],
    );
    const row = r.rows[0];
    if (!row) throw errors.notFound();
    await assertLessonUnlocked(db, userId, row.course_id, row.ord);
    return {
      slug: row.slug,
      ord: row.ord,
      title: row.loc_title,
      body_md: row.loc_body_md,
      quiz: publicQuiz(row.loc_quiz),
      passed: row.passed,
    };
  }

  /** POST /academy/lessons/:slug/quiz {question, answer}:
   *  ответ на ОДИН вопрос; верные копятся в quiz_state; ≥2 из 3 → passed + 20 баллов (идемпотентно). */
  async answerQuiz(userId: string, slug: string, questionIdx: number, answerIdx: number): Promise<QuizAnswerResult> {
    return db.tx(async (c) => {
      const r = await c.query<Pick<LessonFullRow, 'id' | 'course_id' | 'ord' | 'quiz'>>(
        'SELECT id, course_id, ord, quiz FROM lessons WHERE slug = $1',
        [slug],
      );
      const lesson = r.rows[0];
      if (!lesson) throw errors.notFound();
      await assertLessonUnlocked(c, userId, lesson.course_id, lesson.ord);

      const quiz = lesson.quiz;
      if (!Number.isInteger(questionIdx) || questionIdx < 0 || questionIdx >= quiz.length) {
        throw errors.invalidRequest();
      }
      const options = quiz[questionIdx].options;
      if (!Number.isInteger(answerIdx) || answerIdx < 0 || answerIdx >= options.length) {
        throw errors.invalidRequest();
      }
      const correct = quiz[questionIdx].answer_idx === answerIdx;

      // прогресс-строка под лок: параллельные ответы на один урок сериализуются
      await c.query(
        'INSERT INTO lesson_progress (user_id, lesson_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, lesson.id],
      );
      const p = await c.query<{ quiz_state: Record<string, boolean>; passed: boolean }>(
        'SELECT quiz_state, passed FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2 FOR UPDATE',
        [userId, lesson.id],
      );
      const state = p.rows[0];
      const quizState = { ...state.quiz_state };
      if (correct) quizState[String(questionIdx)] = true; // верный ответ фиксируется, неверный можно переспросить
      const correctCount = Object.values(quizState).filter(Boolean).length;
      const alreadyPassed = state.passed;
      const nowPassed = alreadyPassed || correctCount >= QUIZ_PASS_THRESHOLD;

      if (quizState[String(questionIdx)] !== state.quiz_state?.[String(questionIdx)] || nowPassed !== alreadyPassed) {
        await c.query(
          'UPDATE lesson_progress SET quiz_state = $3, passed = $4, updated_at = now() WHERE user_id = $1 AND lesson_id = $2',
          [userId, lesson.id, JSON.stringify(quizState), nowPassed],
        );
      }

      if (nowPassed && !alreadyPassed) {
        await awardDisciplinePoints(c, {
          userId,
          eventType: 'academy_lesson',
          refType: 'academy',
          refId: Number(lesson.id),
          points: ACADEMY_POINTS.lesson,
        });
      }

      return {
        correct,
        ...(correct ? { explanation: quiz[questionIdx].explanation } : {}), // пояснение — только к верному ответу
        passed: nowPassed,
      };
    });
  }

  /** GET /academy/progress: пройденные уроки (slug) + суммарные баллы дисциплины. */
  async getProgress(userId: string): Promise<AcademyProgressDto> {
    const passed = await db.query<{ slug: string }>(
      `SELECT l.slug FROM lesson_progress p
       JOIN lessons l ON l.id = p.lesson_id
       WHERE p.user_id = $1 AND p.passed
       ORDER BY l.course_id, l.ord`,
      [userId],
    );
    const pts = await db.query<{ points: number }>(
      'SELECT coalesce(sum(points), 0)::int AS points FROM discipline_events WHERE user_id = $1',
      [userId],
    );
    return { passed_lessons: passed.rows.map((r) => r.slug), points: pts.rows[0]?.points ?? 0 };
  }
}
