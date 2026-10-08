import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { CurrentUserService } from './current-user.service';
import { FusionAuthService } from './fusionauth.service';
import { LogoutRevocationService } from './logout-revocation.service';
import { PendingRegistrationStore } from './pending-registration-store';
import { PkceStore } from './pkce-store';
import { SignupIntentStore } from './signup-intent-store';

@Module({
  imports: [WorkspaceModule],
  controllers: [AuthController],
  providers: [
    AuthGuard,
    CurrentUserService,
    FusionAuthService,
    LogoutRevocationService,
    PendingRegistrationStore,
    PkceStore,
    SignupIntentStore,
  ],
  exports: [
    AuthGuard,
    CurrentUserService,
    FusionAuthService,
    LogoutRevocationService,
    PendingRegistrationStore,
  ],
})
export class AuthModule {}
