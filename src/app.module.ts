import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { WorkspaceController } from './workspace/workspace.controller';
import { WorkspaceModule } from './workspace/workspace.module';

@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [AppController, WorkspaceController],
})
export class AppModule {}
