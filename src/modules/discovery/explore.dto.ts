import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination';

export class ExploreTripsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    default: true,
    description: 'false leaves out trips the caller owns or edits',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeMine?: boolean;
}
