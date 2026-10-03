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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
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
      'Send placeId (a place from our results) or name + location (custom pin, or a Photon result with osmType/osmId). Google place IDs are rejected.',
  })
  @ApiCreatedResponse({ type: MarkerDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: CreateMarkerDto,
  ): Promise<MarkerDto> {
    return this.markers.create(user.id, id, body);
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
  ): Promise<MarkerDto> {
    return this.markers.create(user.id, body.dayId, {
      placeId: id,
      time: body.time,
      position: body.position,
    });
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
  @ApiOperation({ summary: 'Delete a marker' })
  @ApiNoContentResponse()
  delete(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.markers.delete(user.id, id);
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
