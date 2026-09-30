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
  PhotoOrderDto,
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
  @ApiOperation({ summary: "A marker's photos in gallery order" })
  @ApiOkResponse({ type: [PhotoDto] })
  gallery(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<PhotoDto[]> {
    return this.photos.gallery(user.id, id);
  }

  @Put('markers/:id/photo-order')
  @ApiOperation({ summary: 'Reorder the gallery' })
  @ApiOkResponse({ type: [PhotoDto] })
  reorder(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: PhotoOrderDto,
  ): Promise<PhotoDto[]> {
    return this.photos.reorder(user.id, id, body.photoIds);
  }

  @Put('markers/:id/cover')
  @ApiOperation({
    summary: "Choose the marker's cover photo (its map pin thumbnail)",
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
      'The uploader, the trip owner or an editor. A deleted cover passes to the next photo.',
  })
  @ApiNoContentResponse()
  delete(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.photos.delete(user.id, id);
  }
}
