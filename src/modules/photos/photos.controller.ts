import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { UPLOAD_RATE_LIMIT } from '../../common/throttling/throttling.module';
import { MarkerDto } from '../markers/markers.dto';
import {
  CoverDto,
  PhotoDto,
  UploadUrlRequestDto,
  UploadUrlResponseDto,
} from './photos.dto';
import { PhotosService } from './photos.service';

@ApiTags('photos')
@ApiBearerAuth()
@Controller()
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post('markers/:id/photos/upload-url')
  @Throttle({ default: UPLOAD_RATE_LIMIT })
  @ApiOperation({
    summary: 'Start a photo upload',
    description:
      'Creates the photo (pending_upload) and returns a pre-signed PUT URL valid 10 minutes. PUT the file with the given headers, then call POST /photos/{id}/complete. JPEG, PNG or WebP (convert HEIC to JPEG first), at most 15 MB, 30 photos per marker. 503 while storage is not configured.',
  })
  @ApiCreatedResponse({ type: UploadUrlResponseDto })
  uploadUrl(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: UploadUrlRequestDto,
  ): Promise<UploadUrlResponseDto> {
    return this.photos.requestUpload(user.id, id, body);
  }

  @Post('places/:id/photos/upload-url')
  @Throttle({ default: UPLOAD_RATE_LIMIT })
  @ApiOperation({
    summary: 'Start a place photo upload',
    description:
      'A photo on a place (an OSM place or a user place you can see), not on a trip; it stays until you delete it. Same upload flow and file rules as marker photos. At most APP_PLACE_PHOTO_DAILY_LIMIT (default 20) place photos per person in 24 hours → 422 DAILY_PHOTO_LIMIT_REACHED (details.max). 404 for a place you cannot see. photo.ready and photo.failed arrive in your own user room.',
  })
  @ApiCreatedResponse({ type: UploadUrlResponseDto })
  placeUploadUrl(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: UploadUrlRequestDto,
  ): Promise<UploadUrlResponseDto> {
    return this.photos.requestPlaceUpload(user.id, id, body);
  }

  @Get('places/:id/photos')
  @ApiOperation({
    summary: "A place's photos",
    description:
      "Ready place photos, plus photos on stops here in public trips that APP_PLACE_PHOTO_PIN_MIN_LIKES (3) people other than the uploader liked (the same photos, not copies; markerId set), most liked first, then newest; at most 100. Your own place photos still processing or failed are included. A place photo by someone you blocked (or who blocked you) shows without its uploader; their trip photos don't show.",
  })
  @ApiOkResponse({ type: [PhotoDto] })
  placeGallery(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<PhotoDto[]> {
    return this.photos.placeGallery(user.id, id);
  }

  @Post('photos/:id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Confirm an upload',
    description:
      'The uploader confirms the file is uploaded; processing starts (photo.ready follows). Calling it again returns the photo as it is.',
  })
  @ApiAcceptedResponse({ type: PhotoDto })
  complete(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<PhotoDto> {
    return this.photos.complete(user.id, id);
  }

  @Get('markers/:id/photos')
  @ApiOperation({
    summary:
      "A stop's photo grid: members' uploads still processing or failed first, then its photos, the place's popular photos and its Commons images ranked by likes (on a tie the stop's own first, then newest)",
  })
  @ApiOkResponse({ type: [PhotoDto] })
  gallery(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<PhotoDto[]> {
    return this.photos.gallery(user.id, id);
  }

  @Put('markers/:id/cover')
  @ApiOperation({
    summary:
      "Pick the stop's cover (its map pin thumbnail): any ready photo or Commons image in its photo grid",
  })
  @ApiOkResponse({ type: MarkerDto })
  cover(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: CoverDto,
  ): Promise<MarkerDto> {
    return this.photos.setCover(user.id, id, body.photoId);
  }

  @Delete('photos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a photo',
    description:
      'Trip photos: the uploader, the trip owner or an editor; a deleted cover passes to the next photo. Place photos: only the uploader.',
  })
  @ApiNoContentResponse()
  delete(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.photos.delete(user.id, id);
  }
}
