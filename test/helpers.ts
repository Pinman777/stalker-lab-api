import { createHmac } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import type { INestApplication } from '@nestjs/common';
import type { Executor } from '../src/db/db';

export const BOT_TOKEN = '7000000001:test-stalker-token'; // = test/env.ts
export const TEST_DB = 'stalker_lab_test';

export function tgUserJson(id: number, first = 'Tester'): string {
  return JSON.stringify({ id: String(id), first_name: first, last_name: null, username: null, language_code: 'en' });
}

/** Подпись initData под тестовый токен (канон invest-pool __tests__/invite-only.test.ts). */
export function signInitData(userJson: string, authDateSec: number = Math.floor(Date.now() / 1000)): string {
  const params = new URLSearchParams({ user: userJson, auth_date: String(authDateSec) });
  const dcs = [...params.keys()].sort().map((k) => `${k}=${params.get(k) as string}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

/** Создать тестовую базу, если нет (однократно; 42P04 = уже существует). */
export async function ensureTestDb(): Promise<void> {
  const admin = new Client({ user: 'zeon', host: '/var/run/postgresql', database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } catch (e) {
    if ((e as { code?: string }).code !== '42P04') throw e;
  } finally {
    await admin.end();
  }
}

/** Канон: снос схемы + накат migrations/*.sql по порядку. */
export async function resetSchema(db: Executor): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(dir, f), 'utf8'));
  }
}

export async function truncateAll(db: Executor): Promise<void> {
  // codex_rules НЕ трогаем — это сид-каталог (миграция 004), не юзер-данные.
  await db.query(
    'TRUNCATE users, invite_codes, audit_log, journal_entries, journal_trades, discipline_events RESTART IDENTITY CASCADE',
  );
}

export async function startApp(): Promise<{ app: INestApplication; base: string }> {
  const { AppModule } = await import('../src/app.module');
  const { NestFactory } = await import('@nestjs/core');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { app, base: `http://127.0.0.1:${address.port}` };
}
