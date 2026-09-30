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
import { ApiProperty } from '@nestjs/swagger';
import { UserSummaryDto } from './user-summary';
import { PageQueryDto } from '../../common/pagination/pagination';
import { ProfileDto } from './profile.dto';
import {
  CheckUsernameQueryDto,
  SearchUsersQueryDto,
  UsernameAvailabilityDto,
  UsernameParamDto,
} from './users.dto';

class UserSearchResultDto {
  @ApiProperty({ type: [UserSummaryDto], description: 'Up to 20 matches' })
  items: UserSummaryDto[];
}
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
  @ApiOperation({ summary: 'Find people by username or display name prefix' })
  @ApiOkResponse({ type: UserSearchResultDto })
  async search(
    @CurrentUser() user: AuthUser,
    @Query() query: SearchUsersQueryDto,
  ): Promise<UserSearchResultDto> {
    return { items: await this.users.search(user.id, query.q) };
  }

  // Keep after the fixed paths above: ':username' would match them otherwise.
  @Get(':username')
  @ApiOperation({
    summary: 'A public profile with public trips',
    description:
      'Trips are paginated with cursor and limit. Unknown users and users with a block either way: 404.',
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
