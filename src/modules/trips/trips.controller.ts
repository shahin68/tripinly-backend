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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageQueryDto } from '../../common/pagination/pagination';
import { MembersService } from './members.service';
import {
  AddMemberDto,
  CreateTripDto,
  MemberParamsDto,
  MeStatsDto,
  TripDayDto,
  TripDto,
  TripMemberDto,
  TripSummaryPageDto,
  UpdateTripDto,
} from './trips.dto';
import { TripsService } from './trips.service';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';

@ApiTags('trips')
@ApiBearerAuth()
@Controller()
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly members: MembersService,
  ) {}

  @Post('trips')
  @Idempotent()
  @ApiOperation({
    summary: 'Create a trip',
    description: 'One day per date, or one "Day 1" without dates.',
  })
  @ApiCreatedResponse({ type: TripDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateTripDto,
  ): Promise<TripDto> {
    return this.trips.create(user.id, body);
  }

  @Get('trips/:id')
  @ApiOperation({ summary: 'Trip with members, days and markers' })
  @ApiOkResponse({ type: TripDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<TripDto> {
    return this.trips.get(user.id, id);
  }

  @Post('trips/:id/copy')
  @Idempotent()
  @ApiOperation({
    summary: 'Add a public trip to my trips',
    description:
      'Copies title, dates, days and markers into a new trip I own (my default visibility). No photos, comments, likes or members. Own and private trips: 403 TRIP_NOT_COPYABLE.',
  })
  @ApiCreatedResponse({ type: TripDto })
  copy(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<TripDto> {
    return this.trips.copy(user.id, id);
  }

  @Patch('trips/:id')
  @ApiOperation({ summary: 'Owner: title, dates, visibility' })
  @ApiOkResponse({ type: TripDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: UpdateTripDto,
  ): Promise<TripDto> {
    return this.trips.update(user.id, id, body);
  }

  @Delete('trips/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Owner: delete the trip with everything in it' })
  @ApiNoContentResponse()
  delete(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.trips.delete(user.id, id);
  }

  @Post('trips/:id/days')
  @Idempotent()
  @ApiOperation({
    summary: 'Append a day',
    description: 'Extends endDate by one day for dated trips.',
  })
  @ApiCreatedResponse({ type: TripDayDto })
  addDay(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<TripDayDto> {
    return this.trips.addDay(user.id, id);
  }

  @Delete('days/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a day and its markers',
    description:
      'Later days move up. The last remaining day can’t be deleted (fields.id = ["lastDay"]).',
  })
  @ApiNoContentResponse()
  deleteDay(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.trips.deleteDay(user.id, id);
  }

  @Post('trips/:id/members')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Owner adds an editor by username. Idempotent.' })
  @ApiOkResponse({ type: TripMemberDto })
  addMember(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: AddMemberDto,
  ): Promise<TripMemberDto> {
    return this.members.addByUsername(user.id, id, body.username);
  }

  @Delete('trips/:id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Owner removes an editor, or an editor leaves (own userId)',
  })
  @ApiNoContentResponse()
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param() params: MemberParamsDto,
  ): Promise<void> {
    return this.members.remove(user.id, params.id, params.userId);
  }

  @Get('me/trips')
  @ApiOperation({
    summary: 'Trips I own or collaborate on, most recently changed first',
  })
  @ApiOkResponse({ type: TripSummaryPageDto })
  myTrips(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<TripSummaryPageDto> {
    return this.trips.listMine(user.id, query.cursor, query.limit);
  }

  @Get('me/stats')
  @ApiOperation({ summary: 'My trip, marker and photo counts' })
  @ApiOkResponse({ type: MeStatsDto })
  stats(@CurrentUser() user: AuthUser): Promise<MeStatsDto> {
    return this.trips.stats(user.id);
  }
}
