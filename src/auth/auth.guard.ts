import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JWTPayload } from 'jose';
import { FusionAuthService } from './fusionauth.service';
import { LogoutRevocationService } from './logout-revocation.service';

const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Same checks as apps/backend AuthGuard (cookie JWT, CSRF, SLO denylist),
 * plus a YUILINK registration check.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly fusionAuth: FusionAuthService,
    private readonly revocation: LogoutRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const cookieToken = req.cookies?.['access_token'];
    if (!cookieToken) {
      throw new UnauthorizedException('Missing token');
    }

    if (CSRF_METHODS.has(req.method)) {
      const csrfCookie = req.cookies?.['csrf_token'];
      const csrfHeader = req.header('X-CSRF-Token');
      if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
        throw new UnauthorizedException('Invalid CSRF token');
      }
    }

    let payload: JWTPayload;
    try {
      payload = await this.fusionAuth.verifyToken(cookieToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.sub && typeof payload.iat === 'number') {
      const revoked = await this.revocation.isRevoked(
        payload.sub,
        payload.iat * 1000,
      );
      if (revoked) {
        throw new UnauthorizedException('Session has been logged out');
      }
    }

    // FA itself does not require a YUILINK registration to log in (see
    // README), so the app enforces it — also catches registrations removed
    // after login.
    const userId = (payload.sub ?? payload.userId) as string | undefined;
    if (!userId || !(await this.fusionAuth.isRegistered(userId))) {
      throw new UnauthorizedException('Not registered for this application');
    }

    res.locals.user = { ...payload, userId, sub: payload.sub };
    return true;
  }
}
