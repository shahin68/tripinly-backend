import { Controller, Get, Query } from '@nestjs/common';
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
import { CheckUsernameQueryDto, UsernameAvailabilityDto } from './users.dto';
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
}
