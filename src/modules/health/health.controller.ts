import { Controller, Get, HttpStatus } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { HealthService } from './health.service';

class LivenessDto {
  @ApiProperty({ example: 'ok' })
  status: 'ok';
}

class ReadinessChecksDto {
  @ApiProperty({ enum: ['up', 'down'] })
  database: 'up' | 'down';

  @ApiProperty({ enum: ['up', 'down'] })
  redis: 'up' | 'down';
}

class ReadinessDto {
  @ApiProperty({ example: 'ok' })
  status: 'ok';

  @ApiProperty({ type: ReadinessChecksDto })
  checks: ReadinessChecksDto;
}

@ApiTags('ops')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness: the process is up' })
  @ApiOkResponse({ type: LivenessDto })
  liveness(): LivenessDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: Postgres and Redis are reachable' })
  @ApiOkResponse({ type: ReadinessDto })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description: 'SERVICE_UNAVAILABLE with `details.checks`',
  })
  async readiness(): Promise<ReadinessDto> {
    const report = await this.health.readiness();
    if (!report.ready) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        { checks: report.checks },
      );
    }
    return { status: 'ok', checks: report.checks };
  }
}
