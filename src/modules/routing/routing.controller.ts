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
import type { LatLng } from './geo';
import {
  DayRouteQueryDto,
  OptimizeQueryDto,
  OptimizeResultDto,
  RouteQueryDto,
  RouteResponseDto,
} from './routing.dto';
import { RoutingService } from './routing.service';

@ApiTags('routing')
@ApiBearerAuth()
@Controller()
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Get('routes')
  @ApiOperation({
    summary: 'Route from A to B with places along the way',
    description:
      'Free for everyone. 503 ROUTING_UNAVAILABLE when openrouteservice fails; straight lines with degraded=true when it is not available (quota used up).',
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
        categories: query.categories,
        excludeTripId: query.excludeTripId,
      },
      lang,
    );
  }

  @Get('days/:id/route')
  @ApiOperation({
    summary: "Route through a day's markers in order",
    description:
      "With places along the way (not the trip's own). route is null for fewer than two markers.",
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
    );
  }

  @Post('days/:id/optimize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Best order for a day',
    description:
      'The first marker stays first. Tripinly Pro: by real travel times, with savedMinutes. Otherwise by straight-line distance. Up to 25 markers. apply=true saves the order (owner or editor) and emits markers.reordered.',
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
