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
import { Throttle } from '@nestjs/throttler';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageQueryDto } from '../../common/pagination/pagination';
import { COMMENT_RATE_LIMIT } from '../../common/throttling/throttling.module';
import { CommentsService } from './comments.service';
import { LikesService } from './likes.service';
import {
  CommentDto,
  CommentPageDto,
  CreateCommentDto,
  LikeParamsDto,
  LikeStateDto,
} from './social.dto';

@ApiTags('social')
@ApiBearerAuth()
@Controller()
export class SocialController {
  constructor(
    private readonly comments: CommentsService,
    private readonly likes: LikesService,
  ) {}

  @Get('markers/:id/comments')
  @ApiOperation({ summary: "A marker's comments, oldest first" })
  @ApiOkResponse({ type: CommentPageDto })
  listComments(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Query() query: PageQueryDto,
  ): Promise<CommentPageDto> {
    return this.comments.list(user.id, id, query.cursor, query.limit);
  }

  @Post('markers/:id/comments')
  @Throttle({ default: COMMENT_RATE_LIMIT })
  @ApiOperation({
    summary: 'Comment on a marker',
    description:
      'Plain text, 1–1000 characters. Members, or anyone for a public trip. Not on markers of someone I have a block with (403). 30 per minute.',
  })
  @ApiCreatedResponse({ type: CommentDto })
  createComment(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
    @Body() body: CreateCommentDto,
  ): Promise<CommentDto> {
    return this.comments.create(user.id, id, body.body);
  }

  @Delete('comments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a comment',
    description: 'The author or the trip owner. Idempotent.',
  })
  @ApiNoContentResponse()
  deleteComment(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    return this.comments.delete(user.id, id);
  }

  @Put('likes/:targetType/:targetId')
  @ApiOperation({
    summary: 'Like a trip, marker, photo, comment or place',
    description: 'Idempotent. Returns the new like state and count.',
  })
  @ApiOkResponse({ type: LikeStateDto })
  like(
    @CurrentUser() user: AuthUser,
    @Param() { targetType, targetId }: LikeParamsDto,
  ): Promise<LikeStateDto> {
    return this.likes.like(user.id, targetType, targetId);
  }

  @Delete('likes/:targetType/:targetId')
  @ApiOperation({ summary: 'Remove my like', description: 'Idempotent.' })
  @ApiOkResponse({ type: LikeStateDto })
  unlike(
    @CurrentUser() user: AuthUser,
    @Param() { targetType, targetId }: LikeParamsDto,
  ): Promise<LikeStateDto> {
    return this.likes.unlike(user.id, targetType, targetId);
  }
}
