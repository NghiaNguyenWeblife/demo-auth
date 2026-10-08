import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as jose from 'jose';

export interface FusionAuthTokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  userId?: string;
}

/** `registration.data` flag: the app accepted this user as a YUILINK user. */
const CONFIRMED_KEY = 'yuilinkConfirmed';

@Injectable()
export class FusionAuthService {
  private readonly logger = new Logger(FusionAuthService.name);
  private readonly jwks: ReturnType<typeof jose.createRemoteJWKSet>;

  constructor() {
    const url = new URL(`${this.baseUrl}/.well-known/jwks.json`);
    this.jwks = jose.createRemoteJWKSet(url);
  }

  private get baseUrl(): string {
    const url = process.env.FUSIONAUTH_URL;
    if (!url) throw new InternalServerErrorException('FUSIONAUTH_URL not set');
    return url.replace(/\/$/, '');
  }

  private get clientId(): string {
    const v = process.env.FUSIONAUTH_APPLICATION_ID;
    if (!v)
      throw new InternalServerErrorException(
        'FUSIONAUTH_APPLICATION_ID not set',
      );
    return v;
  }

  private get clientSecret(): string {
    const v = process.env.FUSIONAUTH_CLIENT_SECRET;
    if (!v)
      throw new InternalServerErrorException(
        'FUSIONAUTH_CLIENT_SECRET not set',
      );
    return v;
  }

  /** API calls that create users must say which tenant (the key is not tenant-scoped). */
  private get tenantId(): string {
    const v = process.env.FUSIONAUTH_TENANT_ID;
    if (!v)
      throw new InternalServerErrorException('FUSIONAUTH_TENANT_ID not set');
    return v;
  }

  private get issuer(): string {
    const v = process.env.FUSIONAUTH_ISSUER;
    if (!v) throw new InternalServerErrorException('FUSIONAUTH_ISSUER not set');
    return v;
  }

  /** `loginHint` prefills the email on the FA login page. */
  getAuthorizeUrl(
    state: string,
    codeChallenge: string,
    redirectUri: string,
    nonce: string,
    loginHint?: string,
  ): string {
    return this.buildOidcUrl(
      '/oauth2/authorize',
      state,
      codeChallenge,
      redirectUri,
      nonce,
      loginHint,
    );
  }

  /**
   * FA's hosted sign-up page. Same parameters as the authorize URL: once the
   * user has signed up, FA goes on to the callback with a code.
   */
  getRegisterUrl(
    state: string,
    codeChallenge: string,
    redirectUri: string,
    nonce: string,
    loginHint?: string,
  ): string {
    return this.buildOidcUrl(
      '/oauth2/register',
      state,
      codeChallenge,
      redirectUri,
      nonce,
      loginHint,
    );
  }

  private buildOidcUrl(
    path: string,
    state: string,
    codeChallenge: string,
    redirectUri: string,
    nonce: string,
    loginHint?: string,
  ): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce,
    });
    if (loginHint) {
      params.set('login_hint', loginHint);
    }
    return `${this.baseUrl}${path}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<FusionAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      // FA's error body stays in the log; the client only gets the generic message.
      this.logger.error(
        `FusionAuth token exchange failed: ${res.status} ${await res.text()}`,
      );
      throw new UnauthorizedException('FusionAuth token exchange failed');
    }
    return (await res.json()) as FusionAuthTokenResponse;
  }

  async refreshToken(refreshToken: string): Promise<FusionAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new UnauthorizedException(
        `FusionAuth refresh failed: ${res.status}`,
      );
    }
    return (await res.json()) as FusionAuthTokenResponse;
  }

  async verifyToken(token: string): Promise<jose.JWTPayload> {
    const { payload } = await jose.jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.clientId,
      clockTolerance: '30s',
    });
    return payload;
  }

  private get apiKey(): string {
    const v = process.env.FUSIONAUTH_API_KEY;
    if (!v)
      throw new InternalServerErrorException('FUSIONAUTH_API_KEY not set');
    return v;
  }

  /**
   * Trigger FusionAuth to (re)send the email-verification message for an
   * existing user. FA returns 200 with empty body on success. Common error
   * statuses surfaced as-is so the caller can show a precise message:
   *
   * - 400: user not found / email already verified / mail config invalid
   * - 404: user not found (FA returns this when the email is unknown)
   * - 429: FA-side throttling (if Tenant `unverified.behavior` enforces it)
   */
  async resendVerificationEmail(email: string): Promise<void> {
    // FA expects `email` as a query string parameter, NOT a JSON body field.
    // Sending it in the body returns 400 "[blank]email" — confusing but FA is
    // strict on this for the resend endpoint.
    // `applicationId` puts YUILINK in the mail's template context, so the
    // verify link carries our client_id and the theme's "verification
    // complete" page can link back to this app.
    const params = new URLSearchParams({ email, applicationId: this.clientId });
    const url = `${this.baseUrl}/api/user/verify-email?${params.toString()}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: this.apiKey },
    });
    if (res.ok) return;

    const bodyText = await res.text().catch(() => '');
    throw new HttpException(
      {
        message: 'FusionAuth resend verification failed',
        upstreamStatus: res.status,
        upstreamBody: bodyText.slice(0, 500),
      },
      res.status >= 400 && res.status < 600 ? res.status : 502,
    );
  }

  /**
   * Build the FusionAuth RP-initiated logout URL. The browser must be
   * redirected to this URL so FusionAuth can clear its SSO session cookie —
   * server-side calls won't kill the session because the cookie lives in the
   * user's browser.
   *
   * Note: we deliberately don't pass `post_logout_redirect_uri` because
   * FusionAuth validates it against `oauthConfiguration.authorizedRedirectURLs`
   * (the OAuth callback list, not a separate logout list) and returns 404 if
   * it doesn't match. Instead we rely on the application's
   * `oauthConfiguration.logoutURL` field which FA reads server-side.
   */
  getLogoutUrl(idTokenHint?: string): string {
    const params = new URLSearchParams({ client_id: this.clientId });
    if (idTokenHint) {
      params.set('id_token_hint', idTokenHint);
    }
    return `${this.baseUrl}/oauth2/logout?${params.toString()}`;
  }

  /** Id of the tenant user with this email, or null when there is none. */
  async findUserIdByEmail(email: string): Promise<string | null> {
    const url = `${this.baseUrl}/api/user?email=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: this.apiKey,
        'X-FusionAuth-TenantId': this.tenantId,
      },
    });
    if (res.status === 404) return null;
    if (res.ok) {
      const body = (await res.json()) as { user?: { id?: string } };
      return body.user?.id ?? null;
    }
    throw new HttpException(
      {
        message: 'FusionAuth get user failed',
        upstreamStatus: res.status,
        upstreamBody: (await res.text().catch(() => '')).slice(0, 500),
      },
      502,
    );
  }

  /** FA's hosted "forgot password" page (works with self-service disabled). */
  getForgotPasswordUrl(): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      tenantId: this.tenantId,
    });
    return `${this.baseUrl}/password/forgot?${params.toString()}`;
  }

  /**
   * The user's registration for this app (YUILINK), or null when there is
   * none. `confirmed` is false for a registration FA created by itself.
   */
  async getRegistration(
    userId: string,
  ): Promise<{ confirmed: boolean; insertInstant: number } | null> {
    const url = `${this.baseUrl}/api/user/registration/${userId}/${this.clientId}`;
    const res = await fetch(url, { headers: { Authorization: this.apiKey } });
    if (res.status === 404) return null;
    if (res.ok) {
      const { registration } = (await res.json()) as {
        registration: {
          insertInstant: number;
          data?: Record<string, unknown>;
        };
      };
      return {
        confirmed: registration.data?.[CONFIRMED_KEY] === true,
        insertInstant: registration.insertInstant,
      };
    }
    throw new HttpException(
      {
        message: 'FusionAuth get registration failed',
        upstreamStatus: res.status,
        upstreamBody: (await res.text().catch(() => '')).slice(0, 500),
      },
      502,
    );
  }

  /**
   * Whether the user is a YUILINK user. A bare FA registration is not enough:
   * with self-service registration enabled, FA registers any tenant user who
   * logs in. Only registrations the app has confirmed count.
   */
  async isRegistered(userId: string): Promise<boolean> {
    return (await this.getRegistration(userId))?.confirmed ?? false;
  }

  /** When the user was created in the tenant (epoch ms). */
  async getUserInsertInstant(userId: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/user/${userId}`, {
      headers: { Authorization: this.apiKey },
    });
    if (res.ok) {
      const body = (await res.json()) as { user: { insertInstant: number } };
      return body.user.insertInstant;
    }
    throw new HttpException(
      {
        message: 'FusionAuth get user failed',
        upstreamStatus: res.status,
        upstreamBody: (await res.text().catch(() => '')).slice(0, 500),
      },
      502,
    );
  }

  /** Add a confirmed registration for this app to an existing user. */
  async register(userId: string): Promise<void> {
    const url = `${this.baseUrl}/api/user/registration/${userId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ registration: this.confirmedRegistration }),
    });
    if (res.ok) return;
    throw new HttpException(
      {
        message: 'FusionAuth create registration failed',
        upstreamStatus: res.status,
        upstreamBody: (await res.text().catch(() => '')).slice(0, 500),
      },
      502,
    );
  }

  /** Mark the registration FA created on its sign-up page as confirmed. */
  async confirmRegistration(userId: string): Promise<void> {
    const url = `${this.baseUrl}/api/user/registration/${userId}/${this.clientId}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ registration: this.confirmedRegistration }),
    });
    if (res.ok) return;
    throw new HttpException(
      {
        message: 'FusionAuth update registration failed',
        upstreamStatus: res.status,
        upstreamBody: (await res.text().catch(() => '')).slice(0, 500),
      },
      502,
    );
  }

  /** Remove the user's registration for this app. */
  async unregister(userId: string): Promise<void> {
    const url = `${this.baseUrl}/api/user/registration/${userId}/${this.clientId}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: this.apiKey },
    });
    if (res.ok || res.status === 404) return;
    throw new HttpException(
      {
        message: 'FusionAuth delete registration failed',
        upstreamStatus: res.status,
        upstreamBody: (await res.text().catch(() => '')).slice(0, 500),
      },
      502,
    );
  }

  private get confirmedRegistration() {
    return { applicationId: this.clientId, data: { [CONFIRMED_KEY]: true } };
  }

  /**
   * Create a new user in the tenant together with a registration for this app.
   * FA sends the email-verification mail per the tenant settings.
   *
   * Returns the new user's id on success, or the FA error messages (e.g.
   * duplicate email, password policy) on a 400 so the form can show them.
   * Any other failure throws.
   */
  async signup(input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }): Promise<{ userId?: string; errors: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/user/registration`, {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
        'X-FusionAuth-TenantId': this.tenantId,
      },
      body: JSON.stringify({
        user: input,
        registration: this.confirmedRegistration,
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { user?: { id?: string } };
      return { userId: body.user?.id, errors: [] };
    }

    const bodyText = await res.text().catch(() => '');
    if (res.status === 400) {
      const body = JSON.parse(bodyText || '{}') as {
        fieldErrors?: Record<string, { message: string }[]>;
        generalErrors?: { message: string }[];
      };
      const errors = [
        ...Object.values(body.fieldErrors ?? {}).flat(),
        ...(body.generalErrors ?? []),
      ].map(e => e.message);
      return { errors: errors.length ? errors : [bodyText] };
    }
    throw new HttpException(
      {
        message: 'FusionAuth signup failed',
        upstreamStatus: res.status,
        upstreamBody: bodyText.slice(0, 500),
      },
      502,
    );
  }
}
