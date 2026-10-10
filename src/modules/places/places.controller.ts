import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { I18nLang } from 'nestjs-i18n';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { SEARCH_RATE_LIMIT } from '../../common/throttling/throttling.module';
import {
  InViewQueryDto,
  InViewResponseDto,
  NearbyPageDto,
  NearbyQueryDto,
  PlaceDetailDto,
  PopularQueryDto,
  PopularResponseDto,
  SearchQueryDto,
  SearchResponseDto,
  TilesQueryDto,
  TilesResponseDto,
} from './places.dto';
import { PlacesService } from './places.service';

@ApiTags('places')
@ApiBearerAuth()
@Controller('places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get('in-view')
  @ApiOperation({
    summary: 'Places for the visible map area',
    description:
      'Tripinly places first; from zoom 14 also OSM places spread over the view; below zoom 14 Tripinly places only, clustered when there are more than `limit`. A bbox too large for the zoom returns BBOX_TOO_LARGE.',
  })
  @ApiOkResponse({ type: InViewResponseDto })
  inView(
    @CurrentUser() user: AuthUser,
    @Query() query: InViewQueryDto,
    @I18nLang() lang: string,
  ): Promise<InViewResponseDto> {
    return this.places.inView(user.id, query, lang);
  }

  @Get('tiles')
  @ApiOperation({
    summary: 'Places for several map squares at once',
    description:
      'What in-view returns, for each map square asked for (at most 16), in one request. Lets the app load the map by square, keep squares and fetch the ones around the view ahead.',
  })
  @ApiOkResponse({ type: TilesResponseDto })
  tiles(
    @CurrentUser() user: AuthUser,
    @Query() query: TilesQueryDto,
    @I18nLang() lang: string,
  ): Promise<TilesResponseDto> {
    return this.places.tiles(user.id, query, lang);
  }

  @Get('search')
  @Throttle({ default: SEARCH_RATE_LIMIT })
  @ApiOperation({
    summary: 'Search places, addresses and cities',
    description:
      'Our places (by name, in every language OSM has) merged with Photon results. Debounce on the client (at least 300 ms and 2 characters). lat/lng only rank results and are not stored.',
  })
  @ApiOkResponse({ type: SearchResponseDto })
  search(
    @Query() query: SearchQueryDto,
    @I18nLang() lang: string,
  ): Promise<SearchResponseDto> {
    return this.places.search(query, lang);
  }

  @Get('nearby')
  @ApiOperation({
    summary: 'Popular places around a point',
    description:
      'Ranked by popularity and distance; topped up with OSM sights when fewer than 10 are in range. The location is used for this query only.',
  })
  @ApiOkResponse({ type: NearbyPageDto })
  nearby(
    @CurrentUser() user: AuthUser,
    @Query() query: NearbyQueryDto,
    @I18nLang() lang: string,
  ): Promise<NearbyPageDto> {
    return this.places.nearby(user.id, query, lang);
  }

  @Get('popular')
  @ApiOperation({
    summary: 'Popular spots in the visible area',
    description:
      'Tripinly places only, by popularity. excludeTripId leaves out places already in that trip.',
  })
  @ApiOkResponse({ type: PopularResponseDto })
  popular(
    @CurrentUser() user: AuthUser,
    @Query() query: PopularQueryDto,
    @I18nLang() lang: string,
  ): Promise<PopularResponseDto> {
    return this.places.popular(user.id, query, lang);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A place' })
  @ApiOkResponse({ type: PlaceDetailDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @I18nLang() lang: string,
  ): Promise<PlaceDetailDto> {
    return this.places.get(user.id, id, lang);
  }
}
