import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import { FusionAuthService } from './fusionauth.service';
import { LogoutRevocationService } from './logout-revocation.service';
import { JwtUser } from './user.decorator';

/** For server-rendered pages: same checks as AuthGuard, but returns null instead of throwing. */
@Injectable()
export class CurrentUserService {
  constructor(
    private readonly fusionAuth: FusionAuthService,
    private readonly revocation: LogoutRevocationService,
  ) {}

  async get(req: Request): Promise<JwtUser | null> {
    const token = req.cookies?.['access_token'];
    if (!token) return null;
    let payload: JwtUser;
    try {
      payload = (await this.fusionAuth.verifyToken(token)) as JwtUser;
    } catch {
      return null;
    }
    if (!payload.sub) return null;
    if (
      typeof payload.iat === 'number' &&
      (await this.revocation.isRevoked(payload.sub, payload.iat * 1000))
    ) {
      return null;
    }
    if (!(await this.fusionAuth.isRegistered(payload.sub))) return null;
    return payload;
  }
}
