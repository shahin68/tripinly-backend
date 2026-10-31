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
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ConfirmQueryDto } from '../../common/dto/confirm-query.dto';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageQueryDto } from '../../common/pagination/pagination';
import { MembersService } from './members.service';
import {
  AddMemberDto,
  AddMembersDto,
  CreateTripDto,
  JoinRequestDto,
  JoinRequestPageDto,
  MemberParamsDto,
  MeStatsDto,
  TripDayDto,
  TripDto,
  TripMemberDto,
  TripMembersDto,
  TripSummaryPageDto,
  UpdateTripDto,
} from './trips.dto';
import { TripSharingService } from './trip-sharing.service';
import { TripsService } from './trips.service';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';

@ApiTags('trips')
@ApiBearerAuth()
@Controller()
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly members: MembersService,
    private readonly sharing: TripSharingService,
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
      'Later days move up. The last remaining day can’t be deleted (fields.id = ["lastDay"]). Its stops go too, so the trip owner, or an editor when every stop on it is theirs (else 403 FORBIDDEN). Other people\'s photos, comments or likes on them: 409 STOP_HAS_OTHERS_CONTENT unless confirm=true.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'STOP_HAS_OTHERS_CONTENT' })
  deleteDay(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Query() { confirm }: ConfirmQueryDto,
  ): Promise<void> {
    return this.trips.deleteDay(user.id, id, confirm ?? false);
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

  @Post('trips/:id/members/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Owner adds several editors at once, e.g. friends picked in a row',
    description:
      'All or nothing: unknown usernames give 400 VALIDATION_FAILED with fields["usernames.<i>"] = ["notFound"], people the owner blocked ["blocked"]. People already in the trip stay as they are. More than APP_TRIP_MAX_MEMBERS people in the trip (default 50, owner included) gives 422 LIMIT_REACHED. Returns the requested people as members, in request order.',
  })
  @ApiOkResponse({ type: TripMembersDto })
  async addMembers(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: AddMembersDto,
  ): Promise<TripMembersDto> {
    return { items: await this.members.addMany(user.id, id, body.usernames) };
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

  @Put('trips/:id/save')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Save someone else's public trip to my trips",
    description:
      "Idempotent. The trip stays the owner's: it shows in GET /me/trips with savedByMe = true and role viewer, always the live original, read-only. Not listed while it is private or hidden; gone when the owner deletes it. Own trips and trips I am a member of: 403 FORBIDDEN. Private trips and a block either way: 404.",
  })
  @ApiNoContentResponse()
  save(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.sharing.save(user.id, id);
  }

  @Delete('trips/:id/save')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a saved trip from my trips',
    description: 'Idempotent, also when it was never saved.',
  })
  @ApiNoContentResponse()
  unsave(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.sharing.unsave(user.id, id);
  }

  @Post('trips/:id/join-request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask the owner to join a public trip as an editor',
    description:
      'The owner gets a join_requested notification and accepts or declines. Repeating a pending request returns it unchanged. Once declined: 409 JOIN_REQUEST_DECLINED. Own trips and trips I am a member of: 403 FORBIDDEN. Private trips and a block either way: 404.',
  })
  @ApiOkResponse({ type: JoinRequestDto })
  @ApiConflictResponse({ description: 'JOIN_REQUEST_DECLINED' })
  requestJoin(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<JoinRequestDto> {
    return this.sharing.requestJoin(user.id, id);
  }

  @Delete('trips/:id/join-request')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Withdraw my pending request to join',
    description: 'Idempotent. A declined request stays declined.',
  })
  @ApiNoContentResponse()
  cancelJoin(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.sharing.cancelJoin(user.id, id);
  }

  @Get('trips/:id/join-requests')
  @ApiOperation({
    summary: 'Owner: pending requests to join, newest first',
    description: "Others: 403 FORBIDDEN (404 when they can't see the trip).",
  })
  @ApiOkResponse({ type: JoinRequestPageDto })
  joinRequests(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Query() query: PageQueryDto,
  ): Promise<JoinRequestPageDto> {
    return this.sharing.listJoinRequests(
      user.id,
      id,
      query.cursor,
      query.limit,
    );
  }

  @Post('join-requests/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Owner: accept a request; the person becomes an editor',
    description:
      'Removes the request (and their save of the trip). The person gets an added_to_trip notification; trip members get member.added. Over APP_TRIP_MAX_MEMBERS: 422 LIMIT_REACHED. Not the owner, already decided, or the person is gone or blocked: 404.',
  })
  @ApiOkResponse({ type: TripMemberDto })
  acceptJoin(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<TripMemberDto> {
    return this.sharing.accept(user.id, id);
  }

  @Post('join-requests/:id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Owner: decline a request',
    description:
      "The person isn't told, and their myJoinRequest becomes declined; they can't ask again. Not the owner or already decided: 404.",
  })
  @ApiNoContentResponse()
  declineJoin(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.sharing.decline(user.id, id);
  }

  @Get('me/trips')
  @ApiOperation({
    summary:
      'Trips I own, collaborate on or saved, most recently changed first',
    description:
      'Saved trips (savedByMe = true, role viewer) only while they are public and visible to me.',
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
