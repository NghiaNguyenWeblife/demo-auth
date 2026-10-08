import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserService } from '../auth/current-user.service';
import { ExtractUser, JwtUser } from '../auth/user.decorator';
import {
  inviteInvalidView,
  inviteLandingView,
  inviteWrongAccountView,
  unverifiedView,
} from '../views';
import { WorkspaceService } from './workspace.service';

/**
 * Invite flow:
 * - owner → `POST /workspaces/:id/invite` → mail with `/invite/accept?token=`
 * - `/invite/accept` accepts right away when logged in with the invited
 *   email; otherwise Login / Sign up come back to this link.
 * - Whatever the path, the dashboard lists pending invites for the user's
 *   verified email, so the link is not needed again (e.g. after switching
 *   account or verifying the email).
 * - Accepting always needs a verified email equal to the invited one.
 */
@Controller()
export class WorkspaceController {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('invite/accept')
  @Header('Cache-Control', 'no-store')
  async acceptInvite(
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.type('html');
    const invite = await this.workspaces.findInvite(token);
    if (!invite) return res.send(inviteInvalidView());

    const user = await this.currentUser.get(req);
    if (!user) return res.send(inviteLandingView(invite));

    const result = await this.workspaces.acceptByToken(token, user);
    if ('workspaceId' in result) {
      return res.redirect(`/dashboard?workspaceId=${result.workspaceId}`);
    }
    switch (result.failure) {
      case 'unverified':
        return res.send(unverifiedView(user));
      case 'email-mismatch':
        return res.send(inviteWrongAccountView(invite, user));
      default:
        return res.send(inviteInvalidView());
    }
  }

  @Post('workspaces/:workspaceId/invite')
  @UseGuards(AuthGuard)
  async invite(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Body() body: { email?: string; role?: string },
    @ExtractUser() user: JwtUser,
  ) {
    if (!user.email_verified) {
      throw new ForbiddenException('Email not verified');
    }
    await this.workspaces.invite(user, workspaceId, body?.email, body?.role);
    return { success: true };
  }

  /** "Accept" in the dashboard's pending list (invite opened on another device). */
  @Post('invites/:workspaceId/accept')
  @UseGuards(AuthGuard)
  async acceptFromDashboard(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @ExtractUser() user: JwtUser,
  ) {
    const result = await this.workspaces.acceptForEmail(workspaceId, user);
    if ('failure' in result) {
      throw new BadRequestException(
        result.failure === 'unverified'
          ? 'Email not verified'
          : 'Invitation not found or expired',
      );
    }
    return result;
  }
}
