import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { PageQueryDto } from '../../common/pagination/pagination';
import { TripSummaryPageDto } from '../trips/trips.dto';
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
      'Ranked by likes and saves with recency decay. Includes trips the caller owns or edits (role owner or editor): offer no Save on those. Only trips with at least one marker. Pass nextCursor to continue the same ranking.',
  })
  @ApiOkResponse({ type: TripSummaryPageDto })
  trips(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<TripSummaryPageDto> {
    return this.explore.trips(user.id, query.cursor, query.limit);
  }
}
