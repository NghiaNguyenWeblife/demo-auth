import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JWTPayload } from 'jose';

export interface JwtUser extends JWTPayload {
  userId?: string;
  email?: string;
  email_verified?: boolean;
}

export const ExtractUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const res = ctx.switchToHttp().getResponse();
    return res.locals.user as JwtUser;
  },
);
