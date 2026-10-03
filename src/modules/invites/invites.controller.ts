import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { TripDto } from '../trips/trips.dto';
import {
  InviteDto,
  InviteParamsDto,
  InvitePreviewDto,
  InvitesDto,
  InviteTokenParamDto,
} from './invites.dto';
import { InvitesService } from './invites.service';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';

@ApiTags('invites')
@ApiBearerAuth()
@Controller()
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post('trips/:id/invites')
  @Idempotent()
  @ApiOperation({
    summary: 'Owner creates an invite link (valid 7 days, reusable)',
  })
  @ApiCreatedResponse({ type: InviteDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<InviteDto> {
    return this.invites.create(user.id, id);
  }

  @Get('trips/:id/invites')
  @ApiOperation({ summary: "Owner lists the trip's active invite links" })
  @ApiOkResponse({ type: InvitesDto })
  list(
    @CurrentUser() user: AuthUser,
    @Param() { id }: IdParamDto,
  ): Promise<InvitesDto> {
    return this.invites.listActive(user.id, id);
  }

  @Delete('trips/:id/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Owner revokes an invite link. Idempotent.' })
  @ApiNoContentResponse()
  revoke(
    @CurrentUser() user: AuthUser,
    @Param() params: InviteParamsDto,
  ): Promise<void> {
    return this.invites.revoke(user.id, params.id, params.inviteId);
  }

  @Get('invites/:token')
  @ApiOperation({
    summary: 'Preview an invite (trip title, owner)',
    description: '410 INVITE_EXPIRED when expired or revoked.',
  })
  @ApiOkResponse({ type: InvitePreviewDto })
  preview(
    @CurrentUser() user: AuthUser,
    @Param() { token }: InviteTokenParamDto,
  ): Promise<InvitePreviewDto> {
    return this.invites.preview(user.id, token);
  }

  @Post('invites/:token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Join the trip as an editor. Idempotent for members.',
  })
  @ApiOkResponse({ type: TripDto })
  accept(
    @CurrentUser() user: AuthUser,
    @Param() { token }: InviteTokenParamDto,
  ): Promise<TripDto> {
    return this.invites.accept(user.id, token);
  }
}
