import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import {
  AccountDeletionDto,
  ConfirmedDeletionDto,
  DataExportDto,
} from './account.dto';
import { AccountService } from './account.service';

/**
 * Account deletion and data export. Both stay open while a consent is owed:
 * nobody has to accept new terms to leave or to get their data.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Delete()
  @AllowDuringOnboarding()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Delete my account',
    description:
      'Needs a Google/Apple sign-in in the last 10 minutes (403 REAUTH_REQUIRED otherwise; then confirm with POST /me/deletion). Signs out everywhere at once; everything is deleted in the background and a confirmation email follows.',
  })
  @ApiAcceptedResponse({ type: AccountDeletionDto })
  delete(@CurrentUser() user: AuthUser): Promise<AccountDeletionDto> {
    return this.account.requestDeletion(user);
  }

  @Post('deletion')
  @AllowDuringOnboarding()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Delete my account after confirming it is me',
    description:
      'For when DELETE /me answers REAUTH_REQUIRED: the app signs in with Google or Apple again and sends that token here instead of switching sessions. The token must belong to this account, else 403 REAUTH_FAILED and nothing is deleted. Then the same as DELETE /me.',
  })
  @ApiAcceptedResponse({ type: AccountDeletionDto })
  deleteConfirmed(
    @CurrentUser() user: AuthUser,
    @Body() body: ConfirmedDeletionDto,
  ): Promise<AccountDeletionDto> {
    return this.account.confirmDeletion(user, body);
  }

  @Post('export')
  @AllowDuringOnboarding()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Export my data',
    description:
      'Starts a ZIP export and emails a download link valid 7 days when ready. One at a time (a pending export is returned again) and one per 24 hours (429 RATE_LIMITED with details.retryAfterSeconds).',
  })
  @ApiAcceptedResponse({ type: DataExportDto })
  requestExport(@CurrentUser() user: AuthUser): Promise<DataExportDto> {
    return this.account.requestExport(user.id);
  }

  @Get('export')
  @AllowDuringOnboarding()
  @ApiOperation({
    summary: 'My latest export',
    description: 'With a download link while ready. 404 when there is none.',
  })
  @ApiOkResponse({ type: DataExportDto })
  latestExport(@CurrentUser() user: AuthUser): Promise<DataExportDto> {
    return this.account.latestExport(user.id);
  }
}
