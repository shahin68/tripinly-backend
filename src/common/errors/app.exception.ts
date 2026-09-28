import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

export type ErrorDetails = Record<string, unknown>;

/**
 * The only exception services should throw for expected failures. The global
 * filter turns it into `{ error: { code, message, details } }` with a message
 * translated from `errors.<code>` in the caller's language.
 */
export class AppException extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: HttpStatus,
    readonly details: ErrorDetails = {},
    /** Values interpolated into the translated message. Never put personal data here. */
    readonly messageArgs: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = 'AppException';
  }

  static notFound(details?: ErrorDetails): AppException {
    return new AppException(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND, details);
  }

  static forbidden(details?: ErrorDetails): AppException {
    return new AppException(ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, details);
  }

  static validation(fields: Record<string, string[]>): AppException {
    return new AppException(
      ErrorCode.VALIDATION_FAILED,
      HttpStatus.BAD_REQUEST,
      {
        fields,
      },
    );
  }
}
