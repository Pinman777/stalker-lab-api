import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TmaAuthGuard } from '../../common/guards/tma-auth.guard';
import { errors } from '../../common/errors';
import type { AuthedRequest } from '../../common/authed-request';
import {
  AcademyService,
  type AcademyProgressDto,
  type CourseDto,
  type LessonDto,
  type QuizAnswerResult,
} from './academy.service';

/** Академия (нед3): курсы из книги, уроки-главы, квизы «Проверь себя», лестница прогресса.
 *  Локаль: ?lang=ru|en (default ru); en без перевода → пер-полевой фолбэк на ru. */
@Controller('api/v1/academy')
@UseGuards(TmaAuthGuard)
export class AcademyController {
  constructor(private readonly academy: AcademyService) {}

  /** Каталог: курсы с уроками и passed-флагами текущего юзера. */
  @Get('courses')
  async courses(@Query('lang') lang: string | undefined, @Req() req: AuthedRequest): Promise<CourseDto[]> {
    return this.academy.listCourses(req.user!.id, parseLocale(lang));
  }

  /** Урок: текст главы + квиз БЕЗ поля-ответа. Следующий урок без прохождения → 403 lesson_locked. */
  @Get('lessons/:slug')
  async lesson(
    @Param('slug') slug: string,
    @Query('lang') lang: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<LessonDto> {
    return this.academy.getLesson(req.user!.id, parseSlug(slug), parseLocale(lang));
  }

  /** Ответ на вопрос квиза: {question: 0..2, answer: 0..2} → {correct, explanation?, passed}.
   *  Верный ответ ≥2 из 3 вопросов урока → он пройден, +20 дисциплины (идемпотентно). */
  @Post('lessons/:slug/quiz')
  @HttpCode(200)
  async quiz(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<QuizAnswerResult> {
    const b = parseQuizBody(body);
    return this.academy.answerQuiz(req.user!.id, parseSlug(slug), b.question, b.answer);
  }

  /** Прогресс юзера: пройденные уроки + суммарные баллы дисциплины. */
  @Get('progress')
  progress(@Req() req: AuthedRequest): Promise<AcademyProgressDto> {
    return this.academy.getProgress(req.user!.id);
  }
}

// --- валидация входа (канон: parse-функции, 400 invalid_request) ---

function parseLocale(lang: string | undefined): string {
  if (lang === undefined || lang === '') return 'ru';
  if (lang !== 'ru' && lang !== 'en') throw errors.invalidRequest();
  return lang;
}

function parseSlug(slug: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw errors.invalidRequest();
  return slug;
}

function parseQuizBody(body: unknown): { question: number; answer: number } {
  if (typeof body !== 'object' || body === null) throw errors.invalidRequest();
  const b = body as Record<string, unknown>;
  return { question: parseIndex(b.question), answer: parseIndex(b.answer) };
}

function parseIndex(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 9) throw errors.invalidRequest();
  return n;
}
