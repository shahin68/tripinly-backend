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
    summary: 'Public trips from other people, ranked',
    description:
      'Ranked by likes and copies with recency decay. Only trips with at least one marker. Pass nextCursor to continue the same ranking.',
  })
  @ApiOkResponse({ type: TripSummaryPageDto })
  trips(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<TripSummaryPageDto> {
    return this.explore.trips(user.id, query.cursor, query.limit);
  }
}
