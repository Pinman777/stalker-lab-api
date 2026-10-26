import { Module, OnApplicationShutdown } from '@nestjs/common';
import { db } from './db/db';
import { HealthModule } from './modules/health/health.module';
import { InvitesModule } from './modules/invites/invites.module';
import { IdentityModule } from './modules/identity/identity.module';
import { JournalModule } from './modules/journal/journal.module';
import { DisciplineModule } from './modules/discipline/discipline.module';

/** Module-per-domain (АРХИТЕКТУРА §1): identity, invites, journal, discipline, health. */
@Module({
  imports: [HealthModule, InvitesModule, IdentityModule, JournalModule, DisciplineModule],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await db.end(); // пул pg не держит процесс
  }
}
