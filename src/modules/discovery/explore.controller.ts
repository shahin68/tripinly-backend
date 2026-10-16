import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { TripSummaryPageDto } from '../trips/trips.dto';
import { ExploreTripsQueryDto } from './explore.dto';
import { ExploreService } from './explore.service';

@ApiTags('discovery')
@ApiBearerAuth()
@Controller('explore')
export class ExploreController {
  constructor(private readonly explore: ExploreService) {}

  @Get('trips')
  @ApiOperation({
    summary: 'Public trips, mine included, ranked',
    description:
      'Ranked by likes and saves with recency decay. Includes trips the caller owns or edits (role owner or editor) unless includeMine=false: offer no Save on those. Only trips with at least one marker. Pass nextCursor to continue the same ranking.',
  })
  @ApiOkResponse({ type: TripSummaryPageDto })
  trips(
    @CurrentUser() user: AuthUser,
    @Query() query: ExploreTripsQueryDto,
  ): Promise<TripSummaryPageDto> {
    return this.explore.trips(
      user.id,
      query.cursor,
      query.limit,
      query.includeMine ?? true,
    );
  }
}
