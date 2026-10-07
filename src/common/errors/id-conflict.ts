import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

/**
 * Runs a create that may use a client-chosen ID and turns a unique violation into
 * 409 ID_CONFLICT. Without client IDs, errors pass through unchanged.
 */
export async function withClientIds<T>(
  hasClientIds: boolean,
  create: () => Promise<T>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (
      hasClientIds &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new AppException(ErrorCode.ID_CONFLICT, HttpStatus.CONFLICT);
    }
    throw error;
  }
}
