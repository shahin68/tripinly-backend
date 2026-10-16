import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { I18nLang } from 'nestjs-i18n';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ConfirmQueryDto } from '../../common/dto/confirm-query.dto';
import { IdParamDto } from '../../common/dto/id-param.dto';
import {
  CopyMarkerDto,
  CreateMarkerDto,
  MarkerDto,
  MarkerOrderDto,
  UpdateMarkerDto,
} from './markers.dto';
import { AddToTripDto } from '../places/places.dto';
import { MarkersService } from './markers.service';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';

class MarkerOrderResultDto {
  @ApiProperty({ format: 'uuid' })
  dayId: string;

  @ApiProperty({ type: [String], format: 'uuid' })
  markerIds: string[];
}

@ApiTags('markers')
@ApiBearerAuth()
@Controller()
export class MarkersController {
  constructor(private readonly markers: MarkersService) {}

  @Post('days/:id/markers')
  @Idempotent()
  @ApiOperation({
    summary: 'Add a marker to a day',
    description:
      'Send placeId (a place from our results), name + location (custom pin, or a Photon result with osmType/osmId), or location alone (a tap on the map): the server then names the stop after one of our public places within 25 m, else the address there (Photon reverse), else its coordinates. Google place IDs are rejected.',
  })
  @ApiCreatedResponse({ type: MarkerDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: CreateMarkerDto,
    @I18nLang() lang: string,
  ): Promise<MarkerDto> {
    return this.markers.create(user.id, id, body, lang);
  }

  @Post('places/:id/add-to-trip')
  @Idempotent()
  @ApiTags('places')
  @ApiOperation({
    summary: 'Add a place to a trip day',
    description:
      'Same as adding a marker with placeId (editor or owner of the trip).',
  })
  @ApiCreatedResponse({ type: MarkerDto })
  addPlace(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: AddToTripDto,
    @I18nLang() lang: string,
  ): Promise<MarkerDto> {
    return this.markers.create(
      user.id,
      body.dayId,
      { placeId: id, time: body.time, position: body.position },
      lang,
    );
  }

  @Post('markers/:id/copy')
  @Idempotent()
  @ApiOperation({
    summary: 'Copy a marker to one of my trips',
    description:
      'Markers of public trips that are not mine. Same name, location, time and place; no photos, comments or likes. Own and private trips: 403 TRIP_NOT_COPYABLE.',
  })
  @ApiCreatedResponse({ type: MarkerDto })
  copy(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: CopyMarkerDto,
  ): Promise<MarkerDto> {
    return this.markers.copy(user.id, id, body);
  }

  @Get('markers/:id')
  @ApiOperation({ summary: 'A marker' })
  @ApiOkResponse({ type: MarkerDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<MarkerDto> {
    return this.markers.get(user.id, id);
  }

  @Patch('markers/:id')
  @ApiOperation({
    summary: 'Edit a marker',
    description:
      'Name, time, place or location, or move it to another day of the same trip / another position.',
  })
  @ApiOkResponse({ type: MarkerDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: UpdateMarkerDto,
  ): Promise<MarkerDto> {
    return this.markers.update(user.id, id, body);
  }

  @Delete('markers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a marker with everything on it',
    description:
      "Whoever added the stop, or the trip owner (403 FORBIDDEN for other editors: they use DELETE /markers/{id}/mine). Photos, comments and likes go with it. When other people's photos, comments or likes are on it: 409 STOP_HAS_OTHERS_CONTENT (details.photos, details.comments, details.likes) unless confirm=true. A user-made place goes with its last stop, with its place photos.",
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'STOP_HAS_OTHERS_CONTENT' })
  delete(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Query() { confirm }: ConfirmQueryDto,
  ): Promise<void> {
    return this.markers.delete(user.id, id, confirm ?? false);
  }

  @Delete('markers/:id/mine')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove my photos, comments and likes from a marker',
    description:
      "Anyone who can see the stop. The stop and other people's content stay. 204 also when there was nothing of mine.",
  })
  @ApiNoContentResponse()
  removeMine(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.markers.removeMine(user.id, id);
  }

  @Delete('days/:id/markers')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete all of a day's markers",
    description:
      "Clears the day in one request; the day itself stays. 204 also when it was already empty. All or nothing: the trip owner, or an editor when every stop on it is theirs (else 403 FORBIDDEN). Other people's photos, comments or likes on the stops: 409 STOP_HAS_OTHERS_CONTENT unless confirm=true.",
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'STOP_HAS_OTHERS_CONTENT' })
  clearDay(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Query() { confirm }: ConfirmQueryDto,
  ): Promise<void> {
    return this.markers.clearDay(user.id, id, confirm ?? false);
  }

  @Put('days/:id/marker-order')
  @ApiOperation({ summary: "Set the order of a day's markers" })
  @ApiOkResponse({ type: MarkerOrderResultDto })
  async reorder(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: MarkerOrderDto,
  ): Promise<MarkerOrderResultDto> {
    return {
      dayId: id,
      markerIds: await this.markers.reorder(user.id, id, body.markerIds),
    };
  }
}
