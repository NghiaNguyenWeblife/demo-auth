import { Controller, Get, Header, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUserService } from './auth/current-user.service';
import {
  PENDING_COOKIE,
  PendingRegistrationStore,
} from './auth/pending-registration-store';
import { WorkspaceService } from './workspace/workspace.service';
import { inviteAcceptUrl } from './workspace/invite-url';
import {
  homeView,
  loggedOutView,
  pendingRegistrationView,
  signup2EmailView,
  unverifiedView,
} from './views';

/**
 * Server-rendered UI.
 *
 * `/` — for visitors without a session:
 * - not logged in             → Login / Sign up
 * - logged in to FA, but not
 *   registered for YUILINK    → Register / Cancel (no session yet)
 * - has a session             → redirect to /dashboard
 *
 * `/dashboard` — needs a session (otherwise → `/`):
 * - email not verified        → locked out: resend email / logout only
 *                               (same rule as the dashboard app)
 * - registered and verified   → workspaces, members, pending invitations
 */
@Controller()
export class AppController {
  constructor(
    private readonly currentUser: CurrentUserService,
    private readonly pending: PendingRegistrationStore,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async index(@Req() req: Request, @Res() res: Response) {
    if (await this.currentUser.get(req)) {
      return res.redirect('/dashboard');
    }
    const pending = this.pending.get(req.cookies?.[PENDING_COOKIE]);
    res.type('html');
    res.send(
      pending ? pendingRegistrationView(pending.email) : loggedOutView(),
    );
  }

  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  async dashboard(
    @Query('workspaceId') workspaceIdParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = await this.currentUser.get(req);
    if (!user) {
      return res.redirect('/');
    }
    res.type('html');
    if (!user.email_verified) {
      return res.send(unverifiedView(user));
    }

    const workspaces = await this.workspaces.listForUser(user.sub);
    const current =
      workspaces.find(w => String(w.workspaceId) === workspaceIdParam) ??
      workspaces[0];
    res.send(
      homeView(user, {
        workspaces,
        current,
        members: current
          ? await this.workspaces.listMembers(current.workspaceId)
          : [],
        invites: await this.workspaces.listInvitesForEmail(user.email),
      }),
    );
  }

  /** Sign up (option 2), step 1. Step 2 is rendered by POST /auth/signup2/email. */
  @Get('signup2')
  @Header('Content-Type', 'text/html; charset=utf-8')
  signup2(): string {
    return signup2EmailView();
  }

  /**
   * New user → FA's sign-up page. `?invite=<token>` (from the invite page):
   * hints the invited address and returns to the invite link afterwards.
   */
  @Get('signup')
  async signup(
    @Query('invite') token: string | undefined,
    @Res() res: Response,
  ) {
    const invite = await this.workspaces.findInvite(token);
    const params = new URLSearchParams(
      invite
        ? {
            login_hint: invite.email,
            redirect: inviteAcceptUrl(invite.inviteToken),
          }
        : {},
    );
    res.redirect(`/auth/fusionauth/register?${params.toString()}`);
  }
}
