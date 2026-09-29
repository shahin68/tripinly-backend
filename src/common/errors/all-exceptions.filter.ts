import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { I18nContext, I18nService } from 'nestjs-i18n';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';
import type { ErrorResponseDto } from './error-response.dto';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

export const FALLBACK_LANGUAGE = 'en';

/**
 * Every error leaves the API as `{ error: { code, message, details } }`.
 * Stack traces, SQL and internal messages never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const response = host.switchToHttp().getResponse<Response>();
    const { status, code, details, args } = this.normalize(exception);

    if (status >= 500) {
      this.logger.error(
        { err: exception },
        exception instanceof Error ? exception.message : 'Unhandled error',
      );
    }

    const lang = I18nContext.current(host)?.lang ?? FALLBACK_LANGUAGE;
    const body: ErrorResponseDto = {
      error: {
        code,
        message: this.i18n.t(`errors.${code}`, { lang, args }),
        details,
      },
    };
    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: ErrorCode;
    details: Record<string, unknown>;
    args: Record<string, string | number>;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.status,
        code: exception.code,
        details: exception.details,
        args: exception.messageArgs,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        STATUS_TO_CODE[status] ??
        (status >= 500
          ? ErrorCode.INTERNAL_ERROR
          : ErrorCode.VALIDATION_FAILED);
      return { status, code, details: {}, args: {} };
    }
    // body-parser errors (malformed JSON, payload too large) carry a 4xx status.
    const bodyParserStatus = (exception as { status?: unknown } | null)?.status;
    if (
      typeof bodyParserStatus === 'number' &&
      bodyParserStatus >= 400 &&
      bodyParserStatus < 500
    ) {
      return {
        status: bodyParserStatus,
        code: ErrorCode.VALIDATION_FAILED,
        details: {},
        args: {},
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      details: {},
      args: {},
    };
  }
}
