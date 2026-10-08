import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Keeps upstream details (FA / SMTP error bodies, stack traces) out of
 * responses — same intent as apps/backend UnhandledExceptionFilter:
 * - 5xx: logged in full, client gets a generic message.
 * - 4xx: our own message and extra fields (e.g. `retryAfterSec`) pass
 *   through; `upstream*` fields are logged, never sent.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const body =
      exception instanceof HttpException ? exception.getResponse() : undefined;

    if (status >= 500) {
      this.logger.error(
        `${status} ${JSON.stringify(body ?? String(exception))}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      return res
        .status(status)
        .json({ statusCode: status, message: 'Internal server error' });
    }

    if (body && typeof body === 'object') {
      const safe: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (key.startsWith('upstream')) continue;
        safe[key] = value;
      }
      if (Object.keys(safe).length !== Object.keys(body).length) {
        this.logger.warn(`${status} ${JSON.stringify(body)}`);
      }
      return res.status(status).json({ statusCode: status, ...safe });
    }
    return res.status(status).json({
      statusCode: status,
      message: typeof body === 'string' ? body : 'Error',
    });
  }
}
