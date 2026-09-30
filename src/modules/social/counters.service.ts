import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { recomputeAllPopularity } from '../places/popularity';

/** Tables with a likeCount and the like target type they count. Constants only. */
const LIKE_COUNTED = [
  ['trips', 'trip'],
  ['markers', 'marker'],
  ['photos', 'photo'],
  ['comments', 'comment'],
] as const;

type Tx = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * Recounts likeCount for specific targets from the likes table (after a
 * bulk like removal such as account deletion).
 */
export async function recountLikes(
  tx: Tx,
  type: (typeof LIKE_COUNTED)[number][1],
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const table = LIKE_COUNTED.find(([, t]) => t === type)![0];
  await tx.$executeRaw`
    UPDATE ${Prisma.raw(table)} x SET "likeCount" = (
      SELECT count(*)::int FROM likes l
      WHERE l."targetType" = ${type}::"LikeTargetType" AND l."targetId" = x.id
    )
    WHERE x.id = ANY(${ids}::uuid[])`;
}

/**
 * Rebuilds the denormalized counters (likeCount, commentCount, place
 * popularity) from their source rows. Requests keep them current; this
 * nightly job repairs drift and is what account deletion relies on.
 */
@Injectable()
export class CountersService {
  private readonly logger = new Logger(CountersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recountAll(): Promise<Record<string, number>> {
    const fixed: Record<string, number> = {};
    for (const [table, type] of LIKE_COUNTED) {
      fixed[`${table}.likeCount`] = await this.prisma.$executeRaw`
        UPDATE ${Prisma.raw(table)} x SET "likeCount" = c.count
        FROM (
          SELECT x2.id, count(l.id)::int AS count
          FROM ${Prisma.raw(table)} x2
          LEFT JOIN likes l ON l."targetType" = ${type}::"LikeTargetType" AND l."targetId" = x2.id
          GROUP BY x2.id
        ) c
        WHERE x.id = c.id AND x."likeCount" <> c.count`;
    }
    fixed['markers.commentCount'] = await this.prisma.$executeRaw`
      UPDATE markers m SET "commentCount" = c.count
      FROM (
        SELECT m2.id, count(cm.id)::int AS count
        FROM markers m2 LEFT JOIN comments cm ON cm."markerId" = m2.id
        GROUP BY m2.id
      ) c
      WHERE m.id = c.id AND m."commentCount" <> c.count`;
    // After marker likes, which it sums.
    fixed['places.popularity'] = await recomputeAllPopularity(this.prisma);

    const drift = Object.entries(fixed).filter(([, rows]) => rows > 0);
    if (drift.length > 0) {
      this.logger.warn(
        `Counters repaired: ${drift.map(([name, rows]) => `${name}=${rows}`).join(', ')}`,
      );
    }
    return fixed;
  }
}
