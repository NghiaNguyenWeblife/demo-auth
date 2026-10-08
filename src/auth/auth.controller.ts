import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { decodeJwt } from 'jose';
import { FusionAuthService } from './fusionauth.service';
import { LogoutRevocationService } from './logout-revocation.service';
import { PKCE_TTL_MS, PkceEntry, PkceStore } from './pkce-store';
import {
  generateBinding,
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from './pkce';
import { AuthGuard } from './auth.guard';
import { ExtractUser, JwtUser } from './user.decorator';
import {
  PENDING_COOKIE,
  PENDING_TTL_MS,
  PendingRegistrationStore,
} from './pending-registration-store';
import {
  SIGNUP_INTENT_COOKIE,
  SIGNUP_INTENT_TTL_MS,
  SignupIntentStore,
} from './signup-intent-store';
import {
  signup2EmailView,
  signup2ExistingView,
  signup2NewView,
  signupDoneView,
  SignupValues,
} from '../views';
import { WorkspaceService } from '../workspace/workspace.service';

const RESEND_VERIFICATION_COOLDOWN_MS = 60_000;
/**
 * FA's sign-up page creates the user and the registration in one request, so
 * their timestamps are this close only for someone who signed up for YUILINK.
 */
const SELF_SIGNUP_WINDOW_MS = 10_000;
const OIDC_BINDING_COOKIE = 'oidc_binding';
const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;

const REFRESH_FAILURE_MESSAGE = {
  'missing-cookie': 'Missing refresh token',
  revoked: 'Session has been logged out',
  'not-registered': 'Not registered for this application',
  'no-id-token': 'FusionAuth did not return id_token',
} as const;

type RefreshFailureReason = keyof typeof REFRESH_FAILURE_MESSAGE;

type RefreshResult = {
  csrfToken?: string;
  failure?: RefreshFailureReason;
};

/**
 * Port of apps/backend/src/auth/auth.controller.ts, minus everything that
 * touches the DB (user_info sync, workspace, site access) and the webhook.
 * Cookie names and lifetimes are kept identical to the backend.
 *
 * Added for YUILINK: a session is only issued to users registered for this
 * app. New users sign up on FA's page (`/auth/fusionauth/register`), which
 * needs self-service registration — and with that enabled FA also registers
 * existing users silently on login. So an FA registration only counts once
 * the app has confirmed it: the callback confirms the ones made by signing
 * up and removes the silent ones, leaving those users to register through
 * `/auth/yuilink-register`. Either way the new user gets their own workspace
 * (owner), unless the email has a pending invite — then they join the
 * inviter's workspace instead.
 *
 * "Sign up (option 2)" (`/auth/signup2/*`) asks for the email first: a new
 * email gets the password form, an existing WebLiFE ID logs in on FA instead
 * and is registered for YUILINK right after the callback.
 */
@Controller('auth')
export class AuthController {
  private readonly resendVerificationLastAt = new Map<string, number>();

  constructor(
    private readonly fusionAuth: FusionAuthService,
    private readonly revocation: LogoutRevocationService,
    private readonly pkceStore: PkceStore,
    private readonly pending: PendingRegistrationStore,
    private readonly workspaces: WorkspaceService,
    private readonly signupIntents: SignupIntentStore,
  ) {}

  private async onYuilinkRegistered(userId: string, email: string | undefined) {
    if (await this.workspaces.hasPendingInvite(email)) return;
    await this.workspaces.createOwnedWorkspace(userId, email);
  }

  /** Best-effort: read `sub` from a (possibly expired) id_token and revoke it. */
  private async revokeFromIdToken(idToken: string | undefined) {
    if (!idToken) return;
    try {
      const sub = decodeJwt(idToken).sub;
      if (sub) await this.revocation.revoke(sub);
    } catch {
      // Malformed token — nothing to revoke.
    }
  }

  private cookieSameSite(): 'lax' | 'none' {
    return process.env.NODE_ENV === 'production' ? 'none' : 'lax';
  }

  private cookieSecure(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  private cookieDomain(): string | undefined {
    return process.env.COOKIE_DOMAIN || undefined;
  }

  private setAuthCookies(
    res: Response,
    idToken: string,
    refreshToken: string | undefined,
    accessTokenTtlSeconds: number,
  ): string {
    const csrfToken = crypto.randomUUID();
    const sameSite = this.cookieSameSite();
    const secure = this.cookieSecure();
    const domain = this.cookieDomain();

    res.cookie('access_token', idToken, {
      httpOnly: true,
      secure,
      sameSite,
      maxAge: accessTokenTtlSeconds * 1000,
      path: '/',
      ...(domain && { domain }),
    });
    res.cookie('csrf_token', csrfToken, {
      httpOnly: false,
      secure,
      sameSite: 'strict',
      maxAge: accessTokenTtlSeconds * 1000,
      path: '/',
      ...(domain && { domain }),
    });
    if (refreshToken) {
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure,
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/auth',
        ...(domain && { domain }),
      });
    }

    return csrfToken;
  }

  private clearAuthCookies(res: Response) {
    const domain = this.cookieDomain();
    res.clearCookie('access_token', { path: '/', ...(domain && { domain }) });
    res.clearCookie('csrf_token', { path: '/', ...(domain && { domain }) });
    res.clearCookie('refresh_token', {
      path: '/auth',
      ...(domain && { domain }),
    });
  }

  private setPendingCookie(res: Response, id: string) {
    const domain = this.cookieDomain();
    // lax, not strict: it must survive the redirect chain that starts at FA.
    // Still not sent on cross-site POSTs, which is what protects
    // POST /auth/yuilink-register.
    res.cookie(PENDING_COOKIE, id, {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      maxAge: PENDING_TTL_MS,
      path: '/',
      ...(domain && { domain }),
    });
  }

  private clearPendingCookie(res: Response) {
    const domain = this.cookieDomain();
    res.clearCookie(PENDING_COOKIE, { path: '/', ...(domain && { domain }) });
  }

  /**
   * Per-browser id tying a login to the browser that started it. Reused while
   * present so parallel logins in several tabs don't invalidate each other.
   * Lax: it must come back on the top-level redirect from FA.
   */
  private ensureOidcBinding(req: Request, res: Response): string {
    const current = req.cookies?.[OIDC_BINDING_COOKIE];
    const binding =
      typeof current === 'string' && BINDING_RE.test(current)
        ? current
        : generateBinding();
    res.cookie(OIDC_BINDING_COOKIE, binding, {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      maxAge: PKCE_TTL_MS,
      path: '/',
    });
    return binding;
  }

  private isSameBrowser(req: Request, entry: PkceEntry): boolean {
    const cookie = req.cookies?.[OIDC_BINDING_COOKIE];
    if (typeof cookie !== 'string') return false;
    const a = Buffer.from(cookie);
    const b = Buffer.from(entry.binding);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  @Get('fusionauth/login')
  fusionauthLogin(
    @Query('redirect') redirectParam: string | undefined,
    @Query('login_hint') loginHint: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.redirect(
      this.buildFusionAuthRedirect(req, res, redirectParam, loginHint),
    );
  }

  /** FA's sign-up page for new users; comes back through the same callback. */
  @Get('fusionauth/register')
  fusionauthRegister(
    @Query('redirect') redirectParam: string | undefined,
    @Query('login_hint') loginHint: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.redirect(
      this.buildFusionAuthRedirect(
        req,
        res,
        redirectParam,
        loginHint,
        undefined,
        true,
      ),
    );
  }

  private buildFusionAuthRedirect(
    req: Request,
    res: Response,
    redirectParam: string | undefined,
    loginHint?: string,
    signupEmail?: string,
    signUpPage = false,
  ): string {
    const callback = process.env.FUSIONAUTH_CALLBACK_URL;
    if (!callback) {
      throw new BadRequestException('FUSIONAUTH_CALLBACK_URL not configured');
    }
    const redirect = this.resolveRedirectTarget(redirectParam);

    const state = generateState();
    const verifier = generateCodeVerifier();
    const nonce = generateNonce();
    this.pkceStore.save(state, {
      codeVerifier: verifier,
      redirect,
      nonce,
      binding: this.ensureOidcBinding(req, res),
      signupEmail,
    });

    const challenge = generateCodeChallenge(verifier);
    return signUpPage
      ? this.fusionAuth.getRegisterUrl(
          state,
          challenge,
          callback,
          nonce,
          loginHint,
        )
      : this.fusionAuth.getAuthorizeUrl(
          state,
          challenge,
          callback,
          nonce,
          loginHint,
        );
  }

  /**
   * Whether the user who just logged in is a YUILINK user. Settles a
   * registration FA made by itself: confirmed when the user signed up on FA's
   * page, removed when FA added it to an existing user on login.
   */
  private async resolveRegistration(
    userId: string,
    email: string | undefined,
  ): Promise<boolean> {
    const registration = await this.fusionAuth.getRegistration(userId);
    if (!registration) return false;
    if (registration.confirmed) return true;

    const userCreatedAt = await this.fusionAuth.getUserInsertInstant(userId);
    if (registration.insertInstant - userCreatedAt <= SELF_SIGNUP_WINDOW_MS) {
      await this.fusionAuth.confirmRegistration(userId);
      await this.onYuilinkRegistered(userId, email);
      return true;
    }
    await this.fusionAuth.unregister(userId);
    return false;
  }

  @Get('fusionauth/callback')
  async fusionauthCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      throw new UnauthorizedException(`FusionAuth error: ${error}`);
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code or state');
    }

    const entry = this.pkceStore.consume(state);
    if (!entry) {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (!this.isSameBrowser(req, entry)) {
      throw new UnauthorizedException(
        'Login was not started in this browser',
      );
    }

    const callback = process.env.FUSIONAUTH_CALLBACK_URL!;
    const tokens = await this.fusionAuth.exchangeCode(
      code,
      entry.codeVerifier,
      callback,
    );
    if (!tokens.id_token) {
      throw new UnauthorizedException('FusionAuth did not return id_token');
    }
    const payload = await this.fusionAuth.verifyToken(tokens.id_token);
    if (payload.nonce !== entry.nonce) {
      throw new UnauthorizedException('id_token nonce mismatch');
    }
    if (!payload.sub) {
      throw new UnauthorizedException('id_token has no sub');
    }

    const email = payload.email as string | undefined;
    const registered = await this.resolveRegistration(payload.sub, email);

    // Sign up (option 2) with an existing WebLiFE ID: the user already asked
    // to join YUILINK, so register now. Only for the account they named — FA
    // SSO may have logged them in silently as someone else.
    if (
      !registered &&
      entry.signupEmail &&
      sameEmail(email, entry.signupEmail)
    ) {
      await this.fusionAuth.register(payload.sub);
      await this.onYuilinkRegistered(payload.sub, email);
    } else if (!registered) {
      // Authenticated, but not a YUILINK user yet: no session. Park the
      // tokens and let the user decide on the "Register for YUILINK" page.
      this.clearAuthCookies(res);
      const pendingId = this.pending.save({
        userId: payload.sub,
        email,
        tokens,
        redirect: entry.redirect,
      });
      this.setPendingCookie(res, pendingId);
      return res.redirect('/');
    }

    this.clearPendingCookie(res);
    this.setAuthCookies(
      res,
      tokens.id_token,
      tokens.refresh_token,
      tokens.expires_in,
    );

    res.redirect(entry.redirect);
  }

  /**
   * True when the user logged out after the session behind `idToken` began.
   *
   * `auth_time` is the original login time and FA keeps it across refreshes,
   * so the old session is blocked while one started by a re-login after the
   * logout passes. (Comparing against `Date.now()` never matched a past
   * logout, so this check used to be a no-op.) Without `auth_time` there is
   * no way to tell, so any recorded logout counts.
   */
  private async isSubjectRevoked(idToken: string): Promise<boolean> {
    try {
      const { sub, auth_time } = decodeJwt(idToken);
      if (!sub) return false;
      const sessionStartMs =
        typeof auth_time === 'number' ? auth_time * 1000 : 0;
      return await this.revocation.isRevoked(sub, sessionStartMs);
    } catch {
      return false;
    }
  }

  private async tryRefreshSession(
    req: Request,
    res: Response,
  ): Promise<RefreshResult> {
    const refreshToken = req.cookies?.['refresh_token'];
    if (!refreshToken) {
      return { failure: 'missing-cookie' };
    }

    // Fast path: skip the FusionAuth round-trip when the old access cookie
    // already shows this session was logged out.
    const oldAccess = req.cookies?.['access_token'];
    if (oldAccess) {
      try {
        const { sub, iat } = decodeJwt(oldAccess);
        if (
          sub &&
          typeof iat === 'number' &&
          (await this.revocation.isRevoked(sub, iat * 1000))
        ) {
          this.clearAuthCookies(res);
          return { failure: 'revoked' };
        }
      } catch {
        // Undecodable access cookie — fall through to the normal refresh.
      }
    }

    const tokens = await this.fusionAuth.refreshToken(refreshToken);
    if (!tokens.id_token) {
      return { failure: 'no-id-token' };
    }

    // Authoritative check on the identity FusionAuth just vouched for: did the
    // user log out after this session (auth_time) began? FA's /oauth2/logout
    // does not revoke refresh tokens, so this is what enforces SLO here.
    if (await this.isSubjectRevoked(tokens.id_token)) {
      this.clearAuthCookies(res);
      return { failure: 'revoked' };
    }

    // Registration removed since login → end the session.
    const { sub } = decodeJwt(tokens.id_token);
    if (!sub || !(await this.fusionAuth.isRegistered(sub))) {
      this.clearAuthCookies(res);
      return { failure: 'not-registered' };
    }

    return {
      csrfToken: this.setAuthCookies(
        res,
        tokens.id_token,
        tokens.refresh_token,
        tokens.expires_in,
      ),
    };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response) {
    const { csrfToken, failure } = await this.tryRefreshSession(req, res);
    if (failure) {
      throw new UnauthorizedException(REFRESH_FAILURE_MESSAGE[failure]);
    }
    res.json({ csrfToken });
  }

  /** Try a silent refresh; fall back to the FusionAuth login page. */
  @Get('refresh-redirect')
  async refreshRedirect(
    @Query('redirect') redirectParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const target = this.resolveRedirectTarget(redirectParam);

    try {
      const { failure } = await this.tryRefreshSession(req, res);
      if (!failure) {
        return res.redirect(target);
      }
    } catch {
      // FusionAuth rejected the refresh token — log in again.
    }

    return res.redirect(this.buildFusionAuthRedirect(req, res, target));
  }

  /** Only same-origin (this app) or localhost targets, to avoid open redirects. */
  private resolveRedirectTarget(redirectParam: string | undefined): string {
    const fallback = process.env.FUSIONAUTH_POST_LOGIN_REDIRECT || '/';
    if (!redirectParam) return fallback;

    let origin: string;
    try {
      origin = new URL(redirectParam).origin;
    } catch {
      return fallback;
    }

    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ? redirectParam
      : fallback;
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    const idToken = req.cookies?.['access_token'];
    await this.revokeFromIdToken(idToken);
    this.clearAuthCookies(res);
    const logoutUrl = this.fusionAuth.getLogoutUrl(idToken);
    res.json({ logoutUrl });
  }

  /** One-shot logout: revoke, clear cookies, then send the browser to FA. */
  @Get('fa-logout')
  async faLogout(@Req() req: Request, @Res() res: Response) {
    const idToken = req.cookies?.['access_token'];
    await this.revokeFromIdToken(idToken);
    this.clearAuthCookies(res);
    res.redirect(this.fusionAuth.getLogoutUrl(idToken));
  }

  /** "Register" on the pending page: add the YUILINK registration, then log in. */
  @Post('yuilink-register')
  async yuilinkRegister(@Req() req: Request, @Res() res: Response) {
    const entry = this.pending.consume(req.cookies?.[PENDING_COOKIE]);
    this.clearPendingCookie(res);
    if (!entry) {
      // Expired or already used — start over from the login page.
      return res.redirect('/');
    }

    await this.fusionAuth.register(entry.userId);
    await this.onYuilinkRegistered(entry.userId, entry.email);

    this.setAuthCookies(
      res,
      entry.tokens.id_token!,
      entry.tokens.refresh_token,
      entry.tokens.expires_in,
    );
    res.redirect(entry.redirect);
  }

  /**
   * "Cancel" on the pending page. Also ends the FA SSO session, otherwise the
   * next Login would silently land on the pending page again.
   */
  @Get('pending-cancel')
  pendingCancel(@Req() req: Request, @Res() res: Response) {
    const entry = this.pending.consume(req.cookies?.[PENDING_COOKIE]);
    this.clearPendingCookie(res);
    res.redirect(this.fusionAuth.getLogoutUrl(entry?.tokens.id_token));
  }

  /** FA user + YUILINK registration + workspace. Returns FA's form errors. */
  private async createAccount(
    values: SignupValues,
    password: string,
  ): Promise<string[]> {
    const { userId, errors } = await this.fusionAuth.signup({
      email: values.email,
      firstName: values.firstName,
      lastName: values.lastName,
      password,
    });
    if (errors.length) return errors;
    if (userId) await this.onYuilinkRegistered(userId, values.email);
    return [];
  }

  /** Sign up (option 2), step 1 → step 2 depends on whether the email exists. */
  @Post('signup2/email')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async signup2Email(
    @Body() body: { email?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const email = body.email?.trim() ?? '';
    if (!email) return signup2EmailView('', ['Email is required.']);

    const userId = await this.fusionAuth.findUserIdByEmail(email);
    if (!userId) return signup2NewView({ email });

    res.cookie(SIGNUP_INTENT_COOKIE, this.signupIntents.save(email), {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      maxAge: SIGNUP_INTENT_TTL_MS,
      path: '/auth/signup2',
    });
    return signup2ExistingView(
      email,
      await this.fusionAuth.isRegistered(userId),
      this.fusionAuth.getForgotPasswordUrl(),
    );
  }

  /** Existing WebLiFE ID: FA login for that email, then auto-register. */
  @Post('signup2/continue')
  signup2Continue(@Req() req: Request, @Res() res: Response) {
    const email = this.signupIntents.consume(
      req.cookies?.[SIGNUP_INTENT_COOKIE],
    );
    res.clearCookie(SIGNUP_INTENT_COOKIE, { path: '/auth/signup2' });
    if (!email) return res.redirect('/signup2');

    res.redirect(
      this.buildFusionAuthRedirect(req, res, undefined, email, email),
    );
  }

  /** Sign up (option 2), step 2 for a new email. */
  @Post('signup2')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async signup2(
    @Body()
    body: {
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
    },
  ): Promise<string> {
    const values = {
      email: body.email?.trim() ?? '',
      firstName: body.firstName?.trim() ?? '',
      lastName: body.lastName?.trim() ?? '',
    };
    if (!values.email) return signup2EmailView();
    if (!body.password || !values.firstName || !values.lastName) {
      return signup2NewView(values, ['All fields are required.']);
    }

    const errors = await this.createAccount(values, body.password);
    if (errors.length) return signup2NewView(values, errors);
    return signupDoneView(values.email);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@ExtractUser() user: JwtUser) {
    return {
      user: {
        sub: user.sub,
        userId: user.sub ?? user.userId,
        email: user.email,
        emailVerified: Boolean(user.email_verified),
      },
      claims: user,
    };
  }

  @Post('resend-verification')
  @UseGuards(AuthGuard)
  async resendVerification(@ExtractUser() user: JwtUser) {
    const userId = (user.sub ?? user.userId) as string;
    const email = user.email;

    if (!email) {
      throw new BadRequestException('Email not present in token');
    }
    if (user.email_verified) {
      throw new BadRequestException('Email already verified');
    }

    const now = Date.now();
    const last = this.resendVerificationLastAt.get(userId) ?? 0;
    const elapsed = now - last;
    if (elapsed < RESEND_VERIFICATION_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil(
        (RESEND_VERIFICATION_COOLDOWN_MS - elapsed) / 1000,
      );
      throw new HttpException(
        {
          message: 'Please wait before requesting another verification email',
          retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.fusionAuth.resendVerificationEmail(email);
    this.resendVerificationLastAt.set(userId, now);

    return {
      success: true,
      email,
      nextAvailableAt: now + RESEND_VERIFICATION_COOLDOWN_MS,
    };
  }
}

function sameEmail(a: string | undefined, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}
