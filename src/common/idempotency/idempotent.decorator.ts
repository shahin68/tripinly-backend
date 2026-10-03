import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';

export const IDEMPOTENT = 'idempotency:enabled';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * A content-creating POST that honours an optional `Idempotency-Key` header:
 * a retry with the same key and body returns the first response instead of
 * creating a duplicate.
 */
export const Idempotent = () =>
  applyDecorators(
    SetMetadata(IDEMPOTENT, true),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description:
        'A client-generated UUID, new per action and reused on its retries. ' +
        'For 24 hours a retry with the same key and body returns the first response ' +
        '(header `Idempotent-Replayed: true`); the same key with a different request ' +
        'answers 422 IDEMPOTENCY_KEY_REUSED, and while the first is still running 409 IDEMPOTENCY_KEY_IN_PROGRESS.',
      schema: { type: 'string', minLength: 1, maxLength: 255 },
    }),
  );
