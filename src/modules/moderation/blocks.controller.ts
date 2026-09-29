import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageQueryDto, type Page } from '../../common/pagination/pagination';
import { UserSummaryDto } from '../users/user-summary';
import { BlocksService } from './blocks.service';

class BlockedUsersDto implements Page<UserSummaryDto> {
  @ApiProperty({ type: [UserSummaryDto] })
  items: UserSummaryDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  nextCursor: string | null;
}

@ApiTags('blocks')
@ApiBearerAuth()
@Controller()
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Post('users/:id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Block a user',
    description:
      'Mutual in effect. Also removes each user from the other’s trips as an editor. Idempotent.',
  })
  @ApiNoContentResponse()
  block(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.blocks.block(user.id, id);
  }

  @Delete('users/:id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock a user. Idempotent.' })
  @ApiNoContentResponse()
  unblock(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.blocks.unblock(user.id, id);
  }

  @Get('me/blocks')
  @ApiOperation({ summary: 'Users I have blocked' })
  @ApiOkResponse({ type: BlockedUsersDto })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<BlockedUsersDto> {
    return this.blocks.listBlocked(user.id, query.cursor, query.limit);
  }
}
