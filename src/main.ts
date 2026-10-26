import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';

/** Только бутстрап (анти-паттерн invest-pool: монолит main.ts 1794 строки — вся логика в модулях). */
async function bootstrap(): Promise<void> {
  if (!config.botToken) throw new Error('BOT_TOKEN is required (env)');
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`stalker-lab-api listening on :${config.port}`);
}

void bootstrap();
