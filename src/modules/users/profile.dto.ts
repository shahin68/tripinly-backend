import { ApiProperty } from '@nestjs/swagger';
import { TripSummaryDto } from '../trips/trips.dto';
import { UserSummaryDto } from './user-summary';

export class ProfileDto {
  @ApiProperty({ type: UserSummaryDto })
  user: UserSummaryDto;

  @ApiProperty({
    description:
      'People who follow them (leaves out suspended users and anyone with a block with me)',
  })
  followerCount: number;

  @ApiProperty({
    description:
      'People they follow (leaves out suspended users and anyone with a block with me)',
  })
  followingCount: number;

  @ApiProperty({ description: 'I follow them' })
  isFollowing: boolean;

  @ApiProperty({ description: 'They follow me' })
  followsMe: boolean;

  @ApiProperty({
    description: 'We follow each other; they appear in my friends list',
  })
  isFriend: boolean;

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
