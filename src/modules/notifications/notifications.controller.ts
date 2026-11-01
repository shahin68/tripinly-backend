import { IdParamDto } from '../../common/dto/id-param.dto';
import {
  Body,
  Controller,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { PageQueryDto } from '../../common/pagination/pagination';
import {
  MarkReadDto,
  NewActivityDto,
  NotificationPageDto,
  NotificationSettingsDto,
  UpdateNotificationSettingsDto,
} from './notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @ApiOperation({
    summary: 'My in-app notifications, newest first',
    description:
      'Title and body are localized by Accept-Language (else my saved locale). Live updates arrive as notification.created on the user room.',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<NotificationPageDto> {
    return this.notifications.list(user.id, query.cursor, query.limit);
  }

  @Post('notifications/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark notifications as read',
    description:
      'Body `{ "ids": [...] }` (up to 100) or `{ "all": true }`. Unknown or foreign ids are ignored.',
  })
  @ApiNoContentResponse()
  async markRead(
    @CurrentUser() user: AuthUser,
    @Body() body: MarkReadDto,
  ): Promise<void> {
    await this.notifications.markRead(user.id, body);
  }

  @Get('trips/:id/new-activity')
  @ApiOperation({
    summary: 'Stops of a trip with unread notifications for me',
    description:
      'The pins with a "new" mark. Opening a stop sends POST /notifications/read with its markerId, which clears its mark. Trips I can\'t see: 404.',
  })
  @ApiOkResponse({ type: NewActivityDto })
  newActivity(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<NewActivityDto> {
    return this.notifications.newActivity(user.id, id);
  }

  @Get('me/notification-settings')
  @ApiOperation({
    summary: 'My push switches per notification type',
    description:
      'All on by default. Off stops the push only; the in-app notification is still created.',
  })
  @ApiOkResponse({ type: NotificationSettingsDto })
  settings(@CurrentUser() user: AuthUser): Promise<NotificationSettingsDto> {
    return this.notifications.settings(user.id);
  }

  @Patch('me/notification-settings')
  @ApiOperation({ summary: 'Change push switches (send only what changes)' })
  @ApiOkResponse({ type: NotificationSettingsDto })
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsDto> {
    return this.notifications.updateSettings(user.id, body);
  }
}
