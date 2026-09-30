import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { REPORT_RATE_LIMIT } from '../../common/throttling/throttling.module';
import { AdminOnly } from './admin.guard';
import { ModerationService } from './moderation.service';
import {
  AdminReportDto,
  AdminReportsDto,
  AdminReportsQueryDto,
  CreateReportDto,
  ReportDto,
  ReviewReportDto,
} from './reports.dto';
import { ReportsService } from './reports.service';

@ApiTags('moderation')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly moderation: ModerationService,
  ) {}

  @Post('reports')
  @Throttle({ default: REPORT_RATE_LIMIT })
  @ApiOperation({
    summary: 'Report a user, trip, marker, photo or comment',
    description:
      'You must be able to see the target (404 otherwise). One open report per target: repeating it answers 200 with the existing report. Up to 20 reports a day.',
  })
  @ApiCreatedResponse({ type: ReportDto })
  @ApiOkResponse({ type: ReportDto, description: 'Already reported' })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateReportDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReportDto> {
    const { report, created } = await this.reports.create(user.id, body);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return report;
  }

  @Get('admin/reports')
  @AdminOnly()
  @ApiOperation({
    summary: 'Reports to review (admins)',
    description:
      'Oldest first, with a snapshot of the target and how many open reports it has.',
  })
  @ApiOkResponse({ type: AdminReportsDto })
  list(@Query() query: AdminReportsQueryDto): Promise<AdminReportsDto> {
    return this.moderation.list(query);
  }

  @Patch('admin/reports/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Act on a report (admins)',
    description:
      'Resolves every open report on the same target and writes the audit log.',
  })
  @ApiOkResponse({ type: AdminReportDto })
  review(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: ReviewReportDto,
  ): Promise<AdminReportDto> {
    return this.moderation.review(user.id, id, body);
  }
}
