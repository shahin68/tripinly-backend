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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AllowDuringOnboarding,
  type AuthUser,
  CurrentUser,
} from '../../common/auth/auth.decorators';
import { ConsentsDto, RecordConsentDto } from '../consents/consents.dto';
import { ConsentsService } from '../consents/consents.service';
import { DevicesService } from './devices.service';
import {
  FcmTokenParamDto,
  MeDto,
  RegisterDeviceDto,
  UpdateMeDto,
} from './users.dto';
import { UsersService } from './users.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly consents: ConsentsService,
    private readonly devices: DevicesService,
  ) {}

  @Get()
  @AllowDuringOnboarding()
  @ApiOperation({ summary: 'Own profile, onboarding state and entitlements' })
  @ApiOkResponse({ type: MeDto })
  getMe(@CurrentUser() user: AuthUser): Promise<MeDto> {
    return this.users.getMe(user.id);
  }

  @Patch()
  @AllowDuringOnboarding()
  @ApiOperation({
    summary: 'Update profile',
    description:
      'Onboarding sets username, displayName and birthDate. Under-16 birth dates delete the account (AGE_REQUIREMENT_NOT_MET).',
  })
  @ApiOkResponse({ type: MeDto })
  updateMe(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateMeDto,
  ): Promise<MeDto> {
    return this.users.updateMe(user.id, body);
  }

  @Get('consents')
  @AllowDuringOnboarding()
  @ApiOperation({
    summary: 'Latest consent per document and what is still required',
  })
  @ApiOkResponse({ type: ConsentsDto })
  listConsents(@CurrentUser() user: AuthUser): Promise<ConsentsDto> {
    return this.consentsFor(user.id);
  }

  @Post('consents')
  @AllowDuringOnboarding()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant or withdraw consent to a document version' })
  @ApiOkResponse({ type: ConsentsDto })
  async recordConsent(
    @CurrentUser() user: AuthUser,
    @Body() body: RecordConsentDto,
  ): Promise<ConsentsDto> {
    await this.consents.record(user.id, body);
    await this.users.completeOnboardingIfReady(user.id);
    return this.consentsFor(user.id);
  }

  @Put('devices/:fcmToken')
  @AllowDuringOnboarding()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register or refresh a push device' })
  @ApiNoContentResponse()
  registerDevice(
    @CurrentUser() user: AuthUser,
    @Param() params: FcmTokenParamDto,
    @Body() body: RegisterDeviceDto,
  ): Promise<void> {
    return this.devices.register(user.id, params.fcmToken, body);
  }

  @Delete('devices/:fcmToken')
  @AllowDuringOnboarding()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unregister a push device' })
  @ApiNoContentResponse()
  removeDevice(
    @CurrentUser() user: AuthUser,
    @Param() params: FcmTokenParamDto,
  ): Promise<void> {
    return this.devices.remove(user.id, params.fcmToken);
  }

  private async consentsFor(userId: string): Promise<ConsentsDto> {
    const [rows, missingRequired] = await Promise.all([
      this.consents.listForUser(userId),
      this.consents.missingRequired(userId),
    ]);
    return {
      items: rows.map((row) => ({
        documentType: row.documentType,
        version: row.version,
        locale: row.locale,
        granted: row.grantedAt !== null,
        grantedAt: row.grantedAt?.toISOString() ?? null,
        withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      })),
      missingRequired,
    };
  }
}
