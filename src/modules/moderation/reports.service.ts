import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type Report, Prisma } from '../../generated/prisma/client';
import { TripAccessService } from '../trips/trip-access.service';
import type { CreateReportDto, ReportDto } from './reports.dto';

/**
 * Report intake (moderation skill). The reporter must be able to see what
 * they report; reporting hides nothing by itself.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
  ) {}

  /** `created` is false when an open report by this user already existed. */
  async create(
    userId: string,
    input: CreateReportDto,
  ): Promise<{ report: ReportDto; created: boolean }> {
    await this.assertCanSee(userId, input);
    const existing = await this.openReport(userId, input);
    if (existing) return { report: toReportDto(existing), created: false };
    try {
      const report = await this.prisma.report.create({
        data: {
          reporterId: userId,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          details: input.details,
        },
      });
      return { report: toReportDto(report), created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const report = (await this.openReport(userId, input))!;
        return { report: toReportDto(report), created: false };
      }
      throw error;
    }
  }

  private openReport(
    userId: string,
    input: CreateReportDto,
  ): Promise<Report | null> {
    return this.prisma.report.findFirst({
      where: {
        reporterId: userId,
        targetType: input.targetType,
        targetId: input.targetId,
        status: 'open',
      },
    });
  }

  /**
   * NOT_FOUND unless the reporter can view the target. A user can be reported
   * even across a block, so blocking and reporting work in either order.
   */
  private async assertCanSee(
    userId: string,
    input: CreateReportDto,
  ): Promise<void> {
    switch (input.targetType) {
      case 'user': {
        const target = await this.prisma.user.findFirst({
          where: { id: input.targetId, onboardedAt: { not: null } },
          select: { id: true },
        });
        if (!target || target.id === userId) throw AppException.notFound();
        return;
      }
      case 'trip':
        await this.access.assert(userId, input.targetId, 'view');
        return;
      case 'marker':
        await this.access.assertForMarker(userId, input.targetId, 'view');
        return;
      case 'photo': {
        const photo = await this.prisma.photo.findUnique({
          where: { id: input.targetId },
          select: {
            tripId: true,
            uploaderId: true,
            hiddenAt: true,
            status: true,
          },
        });
        if (!photo || photo.status !== 'ready') throw AppException.notFound();
        await this.access.assert(userId, photo.tripId, 'view');
        if (photo.hiddenAt && photo.uploaderId !== userId) {
          throw AppException.notFound();
        }
        return;
      }
      case 'comment': {
        const comment = await this.prisma.comment.findUnique({
          where: { id: input.targetId },
          select: { markerId: true, authorId: true, hiddenAt: true },
        });
        if (!comment) throw AppException.notFound();
        await this.access.assertForMarker(userId, comment.markerId, 'view');
        if (comment.hiddenAt && comment.authorId !== userId) {
          throw AppException.notFound();
        }
        return;
      }
    }
  }
}

export function toReportDto(report: Report): ReportDto {
  return {
    id: report.id,
    targetType: report.targetType,
    targetId: report.targetId,
    reason: report.reason,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
  };
}
