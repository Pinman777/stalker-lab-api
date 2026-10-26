import { Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { db } from './db/db';
import { ApiExceptionFilter } from './common/exception-filter';
import { HealthModule } from './modules/health/health.module';
import { InvitesModule } from './modules/invites/invites.module';
import { IdentityModule } from './modules/identity/identity.module';
import { JournalModule } from './modules/journal/journal.module';
import { DisciplineModule } from './modules/discipline/discipline.module';
import { AcademyModule } from './modules/academy/academy.module';
import { ReferralsModule } from './modules/referrals/referrals.module';

/** Module-per-domain (АРХИТЕКТУРА §1): identity, invites, journal, discipline, academy,
 *  referrals, health. Глобальный фильтр ошибок {error: code} (review #10) — здесь,
 *  не в main: применяется и в тестах (app без бутстрапа main.ts). */
@Module({
  imports: [
    HealthModule,
    InvitesModule,
    IdentityModule,
    JournalModule,
    DisciplineModule,
    AcademyModule,
    ReferralsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await db.end(); // пул pg не держит процесс
  }
}
