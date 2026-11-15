import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { I18nLang } from 'nestjs-i18n';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { AppException } from '../../common/errors/app.exception';
import type { LatLng } from './geo';
import {
  DayRouteQueryDto,
  OptimizeQueryDto,
  OptimizeResultDto,
  RouteQueryDto,
  RouteResponseDto,
} from './routing.dto';
import { RoutingService, type TransitTime } from './routing.service';

@ApiTags('routing')
@ApiBearerAuth()
@Controller()
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Get('routes')
  @ApiOperation({
    summary: 'Route from A to B with places along the way',
    description:
      'Tripinly Pro (403 PREMIUM_REQUIRED otherwise). 503 ROUTING_UNAVAILABLE when openrouteservice fails; straight lines with degraded=true when it is not available (quota used up). mode=transit: public transport leaving at departAt (default now) or arriving by arriveBy, with steps per leg; 422 TRANSIT_NO_COVERAGE outside app-config `transitAreas`, 422 TRANSIT_NO_CONNECTION when nothing runs and it is too far to walk, 503 ROUTING_UNAVAILABLE when the transit service fails or its daily quota is used up.',
  })
  @ApiOkResponse({ type: RouteResponseDto })
  route(
    @CurrentUser() user: AuthUser,
    @Query() query: RouteQueryDto,
    @I18nLang() lang: string,
  ): Promise<RouteResponseDto> {
    return this.routing.pointToPoint(
      user.id,
      {
        from: parsePoint(query.from),
        to: parsePoint(query.to),
        mode: query.mode ?? 'walking',
        time: transitTime(query.mode, query.departAt, query.arriveBy),
        categories: query.categories,
        excludeTripId: query.excludeTripId,
        excludePlaceIds: [query.fromPlaceId, query.toPlaceId].filter(
          (id): id is string => id !== undefined,
        ),
      },
      lang,
    );
  }

  @Get('days/:id/route')
  @ApiOperation({
    summary: "Route through a day's markers in order",
    description:
      "Tripinly Pro (403 PREMIUM_REQUIRED otherwise). With places along the way (not the trip's own). route is null for fewer than two markers. mode=transit: the first leg leaves at departAt (default now), each next leg when the one before arrives; a leg with no connection is a straight walk estimate with degraded=true; 422 TRANSIT_NO_COVERAGE when a stop is outside app-config `transitAreas`.",
  })
  @ApiOkResponse({ type: RouteResponseDto })
  dayRoute(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Query() query: DayRouteQueryDto,
    @I18nLang() lang: string,
  ): Promise<RouteResponseDto> {
    return this.routing.day(
      user.id,
      id,
      query.mode ?? 'walking',
      query.categories,
      lang,
      transitTime(query.mode, query.departAt)?.at,
    );
  }

  @Post('days/:id/optimize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Best order for a day',
    description:
      'Free for everyone. The first marker stays first. By real travel times for mode, with savedMinutes; by straight-line distance with degraded=true when travel times are unavailable. Up to 25 markers. apply=true saves the order (owner or editor) and emits markers.reordered.',
  })
  @ApiOkResponse({ type: OptimizeResultDto })
  optimize(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Query() query: OptimizeQueryDto,
  ): Promise<OptimizeResultDto> {
    return this.routing.optimize(
      user.id,
      id,
      query.mode ?? 'walking',
      query.apply ?? false,
    );
  }
}

function parsePoint(value: string): LatLng {
  const [lat, lng] = value.split(',').map(Number);
  return { lat, lng };
}

/** departAt / arriveBy belong to mode=transit, one of them at most. */
function transitTime(
  mode: string | undefined,
  departAt?: string,
  arriveBy?: string,
): TransitTime | undefined {
  if (mode !== 'transit') {
    const fields: Record<string, string[]> = {};
    if (departAt) fields.departAt = ['transitOnly'];
    if (arriveBy) fields.arriveBy = ['transitOnly'];
    if (Object.keys(fields).length) throw AppException.validation(fields);
    return undefined;
  }
  if (departAt && arriveBy) {
    throw AppException.validation({ arriveBy: ['notWithDepartAt'] });
  }
  if (arriveBy) return { at: new Date(arriveBy), arriveBy: true };
  return departAt ? { at: new Date(departAt), arriveBy: false } : undefined;
}
