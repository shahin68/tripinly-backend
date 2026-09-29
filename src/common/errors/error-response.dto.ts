import { ApiProperty } from '@nestjs/swagger';
import { ERROR_CODES, type ErrorCode } from './error-codes';

export class ErrorBodyDto {
  @ApiProperty({ enum: ERROR_CODES, example: 'NOT_FOUND' })
  code: ErrorCode;

  @ApiProperty({
    description: 'Localized, human-readable text. Never switch on it.',
  })
  message: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Extra data for the code. VALIDATION_FAILED carries `fields`: { "<path>": ["<constraint>"] }.',
  })
  details: Record<string, unknown>;
}

export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto })
  error: ErrorBodyDto;
}
