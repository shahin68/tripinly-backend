import { ApiProperty } from '@nestjs/swagger';
import { TripSummaryDto } from '../trips/trips.dto';
import { UserSummaryDto } from './user-summary';

export class ProfileDto {
  @ApiProperty({ type: UserSummaryDto })
  user: UserSummaryDto;

  @ApiProperty({ description: 'Public trips they own' })
  publicTripCount: number;

  @ApiProperty({
    type: [TripSummaryDto],
    description: 'Their public trips, most recently changed first',
  })
  trips: TripSummaryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as cursor for more trips',
  })
  nextCursor: string | null;
}
