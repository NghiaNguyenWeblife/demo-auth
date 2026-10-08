import { Module } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { JsonStore } from './json-store';
import { WorkspaceService } from './workspace.service';

/**
 * No controllers here: AuthModule imports this module (workspace on
 * registration), and WorkspaceController needs AuthGuard — so the controller
 * is registered in AppModule to avoid a module cycle.
 */
@Module({
  providers: [JsonStore, MailService, WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
