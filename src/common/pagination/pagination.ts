import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AppException } from '../errors/app.exception';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export class PageQueryDto {
  @ApiPropertyOptional({ description: 'nextCursor from the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keyset position: a sort value (ISO timestamp) plus the id tiebreaker. */
export interface CursorPosition {
  at: string;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.at, position.id])).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const [at, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as unknown[];
    if (
      typeof at === 'string' &&
      typeof id === 'string' &&
      !Number.isNaN(Date.parse(at))
    ) {
      return { at, id };
    }
  } catch {
    // fall through
  }
  throw AppException.validation({ cursor: ['invalidCursor'] });
}

/**
 * Takes `limit + 1` rows (as fetched) and returns a page, with a cursor built
 * from the last item kept when more rows exist.
 */
export function toPage<R, T>(
  rows: R[],
  limit: number,
  position: (row: R) => CursorPosition,
  map: (row: R) => T,
): Page<T> {
  const kept = rows.slice(0, limit);
  return {
    items: kept.map(map),
    nextCursor:
      rows.length > limit
        ? encodeCursor(position(kept[kept.length - 1]))
        : null,
  };
}
