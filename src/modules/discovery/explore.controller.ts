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
    summary: 'Public trips, mine included, ranked by likes',
    description:
      'Ranked by likes only (saves never count), newest on ties; period week/month/year keeps the trips created in the last 7/30/365 days, season the trips travelled in the current season, lat+lng keeps trips with a stop nearby. Includes trips the caller owns or edits (role owner or editor) unless includeMine=false: offer no Save on those. Only trips with at least one marker. Pass nextCursor (with the same filters) to continue the same ranking.',
  })
  @ApiOkResponse({ type: TripSummaryPageDto })
  trips(
    @CurrentUser() user: AuthUser,
    @Query() query: ExploreTripsQueryDto,
  ): Promise<TripSummaryPageDto> {
    return this.explore.trips(
      user.id,
      {
        includeMine: query.includeMine ?? true,
        period: query.period ?? 'all',
        near:
          query.lat !== undefined && query.lng !== undefined
            ? { lat: query.lat, lng: query.lng }
            : undefined,
      },
      query.cursor,
      query.limit,
    );
  }
}
