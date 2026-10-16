import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** `?confirm=true`: go ahead although the server warned (409) the first time. */
export class ConfirmQueryDto {
  @ApiPropertyOptional({
    default: false,
    description:
      "true deletes other people's photos, comments and likes too; without it that answers 409 STOP_HAS_OTHERS_CONTENT",
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  confirm?: boolean;
}
