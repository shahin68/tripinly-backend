import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** `:id` path parameter; a malformed id fails validation with `fields.id`. */
export class IdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}
