import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { I18nLang, I18nService } from 'nestjs-i18n';
import { Public } from '../../common/auth/auth.decorators';
import type { Env } from '../../common/config/env';
import { TRANSIT_REGIONS } from '../routing/transit/transit-regions';
import { REPORT_REASONS } from '../moderation/reports.dto';
import { AppConfigDto } from './app-config.dto';
import { EXPLORE_PERIOD_ITEMS, PLACE_KINDS } from './app-lists';

@ApiTags('app-config')
@Controller('app-config')
export class AppConfigController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly i18n: I18nService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Settings for the apps',
    description:
      'Values that steer app behaviour (cache times, limits) and the lists the apps show (place kinds, Explore periods, report reasons, labelled in the Accept-Language language), so they change without an app update. Public: the app reads it at start, before sign-in.',
  })
  @ApiOkResponse({ type: AppConfigDto })
  get(@I18nLang() lang: string): AppConfigDto {
    const label = (key: string) => this.i18n.t(`lists.${key}`, { lang });
    return {
      placesRefreshSeconds: this.config.get('APP_PLACES_REFRESH_SECONDS', {
        infer: true,
      }),
      photoMaxEdgePx: this.config.get('APP_PHOTO_MAX_EDGE_PX', { infer: true }),
      photoJpegQuality: this.config.get('APP_PHOTO_JPEG_QUALITY', {
        infer: true,
      }),
      photoParallelUploads: this.config.get('APP_PHOTO_PARALLEL_UPLOADS', {
        infer: true,
      }),
      pinLargeMinProminence: this.config.get('APP_PIN_LARGE_MIN_PROMINENCE', {
        infer: true,
      }),
      pinMediumMinProminence: this.config.get('APP_PIN_MEDIUM_MIN_PROMINENCE', {
        infer: true,
      }),
      mapMaxPins: this.config.get('APP_MAP_MAX_PINS', { infer: true }),
      photoPinMinProminence: this.config.get('APP_PHOTO_PIN_MIN_PROMINENCE', {
        infer: true,
      }),
      photoPinMinHotCount: this.config.get('APP_PHOTO_PIN_MIN_HOT_COUNT', {
        infer: true,
      }),
      mapMaxPhotoPins: this.config.get('APP_MAP_MAX_PHOTO_PINS', {
        infer: true,
      }),
      pinDotBelowZoom: this.config.get('APP_PIN_DOT_BELOW_ZOOM', {
        infer: true,
      }),
      transitAreas: this.config.get('TRANSIT_ENABLED', { infer: true })
        ? this.config.get('TRANSIT_REGIONS', { infer: true }).map((id) => ({
            id,
            name: TRANSIT_REGIONS[id].name,
            ...TRANSIT_REGIONS[id].bbox,
          }))
        : [],
      osmPinsEnabled: this.config.get('OSM_PINS_ENABLED', {
        infer: true,
      }),
      placeKinds: PLACE_KINDS.map((kind) => ({
        ...kind,
        label: label(`kinds.${kind.key}`),
      })),
      explorePeriods: EXPLORE_PERIOD_ITEMS.map((period) => ({
        ...period,
        label: label(`periods.${period.key}`),
      })),
      reportReasons: REPORT_REASONS.map((key) => ({
        key,
        label: label(`reasons.${key}`),
      })),
    };
  }
}
