import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/auth.decorators';
import type { Env } from '../../common/config/env';
import { AppConfigDto } from './app-config.dto';

@ApiTags('app-config')
@Controller('app-config')
export class AppConfigController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Settings for the apps',
    description:
      'Values that steer app behaviour (cache times, limits), set per environment, so they change without an app update. Public: the app reads it at start, before sign-in.',
  })
  @ApiOkResponse({ type: AppConfigDto })
  get(): AppConfigDto {
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
      photoPinMinLikes: this.config.get('APP_PHOTO_PIN_MIN_LIKES', {
        infer: true,
      }),
      mapMaxPhotoPins: this.config.get('APP_MAP_MAX_PHOTO_PINS', {
        infer: true,
      }),
    };
  }
}
