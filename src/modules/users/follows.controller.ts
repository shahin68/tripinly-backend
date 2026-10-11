import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { type Page, PageQueryDto } from '../../common/pagination/pagination';
import { FollowsService } from './follows.service';
import { UserSummaryDto } from './user-summary';

class UserPageDto implements Page<UserSummaryDto> {
  @ApiProperty({ type: [UserSummaryDto] })
  items: UserSummaryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as cursor for the next page',
  })
  nextCursor: string | null;
}

@ApiTags('follows')
@ApiBearerAuth()
@Controller()
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  @Put('users/:id/follow')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Follow a user',
    description:
      'No approval needed; idempotent. Two users who follow each other are friends. Yourself → 400 VALIDATION_FAILED (`fields.id = ["cannotFollowSelf"]`). Unknown, suspended or deleted users and a block either way → 404.',
  })
  @ApiNoContentResponse()
  follow(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.follows.follow(user.id, id);
  }

  @Delete('users/:id/follow')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unfollow a user',
    description:
      'Idempotent, also when there was no follow. Yourself → 400 VALIDATION_FAILED.',
  })
  @ApiNoContentResponse()
  unfollow(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.follows.unfollow(user.id, id);
  }

  @Get('me/friends')
  @ApiOperation({
    summary: 'My friends (people I follow who follow me back)',
    description:
      'By display name, then id. Leaves out suspended users and anyone with a block either way. Used by the trip member picker.',
  })
  @ApiOkResponse({ type: UserPageDto })
  friends(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<UserPageDto> {
    return this.follows.friends(user.id, query.cursor, query.limit);
  }

  @Get('me/following')
  @ApiOperation({
    summary: 'People I follow',
    description: 'Most recently followed first.',
  })
  @ApiOkResponse({ type: UserPageDto })
  following(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<UserPageDto> {
    return this.follows.following(user.id, query.cursor, query.limit);
  }

  @Get('me/followers')
  @ApiOperation({
    summary: 'People who follow me',
    description: 'Most recent first.',
  })
  @ApiOkResponse({ type: UserPageDto })
  followers(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<UserPageDto> {
    return this.follows.followers(user.id, query.cursor, query.limit);
  }
}
