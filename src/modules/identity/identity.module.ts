import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { IdentityService } from './identity.service';
import { InvitesModule } from '../invites/invites.module';

@Module({
  imports: [InvitesModule],
  controllers: [AuthController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
