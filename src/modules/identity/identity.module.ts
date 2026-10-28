import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { IdentityService } from './identity.service';
import { LoginCodesService } from './login-codes.service';
import { TelegramBotApiSender } from './tg-sender';
import { InvitesModule } from '../invites/invites.module';

@Module({
  imports: [InvitesModule],
  controllers: [AuthController],
  providers: [IdentityService, LoginCodesService, TelegramBotApiSender],
  exports: [IdentityService],
})
export class IdentityModule {}
