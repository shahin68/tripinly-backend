import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AllowDuringOnboarding,
  type AuthUser,
  CurrentUser,
} from '../../common/auth/auth.decorators';
import { PageQueryDto } from '../../common/pagination/pagination';
import { ProfileDto } from './profile.dto';
import {
  CheckUsernameQueryDto,
  SearchUsersQueryDto,
  UserSearchPageDto,
  UsernameAvailabilityDto,
  UsernameParamDto,
} from './users.dto';

import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('check-username')
  @AllowDuringOnboarding()
  @ApiOperation({ summary: 'Whether a username is valid and free' })
  @ApiOkResponse({ type: UsernameAvailabilityDto })
  checkUsername(
    @CurrentUser() user: AuthUser,
    @Query() query: CheckUsernameQueryDto,
  ): Promise<UsernameAvailabilityDto> {
    return this.users.checkUsername(user.id, query.username);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Find people by username or display name prefix',
    description:
      'Friends first, then people who follow you or whom you follow, then (with lat/lng) people with a public trip around the point, then the most followed; paged with cursor and limit. Without q: everyone, ranked the same way. Never yourself or anyone with a block either way.',
  })
  @ApiOkResponse({ type: UserSearchPageDto })
  search(
    @CurrentUser() user: AuthUser,
    @Query() query: SearchUsersQueryDto,
  ): Promise<UserSearchPageDto> {
    return this.users.search(user.id, query);
  }

  // Keep after the fixed paths above: ':username' would match them otherwise.
  @Get(':username')
  @ApiOperation({
    summary: 'A public profile with public trips',
    description:
      'Trips are paginated with cursor and limit, most recently updated first. On your own profile the trips include your private ones (publicTripCount still counts public trips only). Unknown users and users with a block either way: 404.',
  })
  @ApiOkResponse({ type: ProfileDto })
  profile(
    @CurrentUser() user: AuthUser,
    @Param() { username }: UsernameParamDto,
    @Query() query: PageQueryDto,
  ): Promise<ProfileDto> {
    return this.users.profile(user.id, username, query.cursor, query.limit);
  }
}
