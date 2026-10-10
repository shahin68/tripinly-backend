import { ApiProperty } from '@nestjs/swagger';

/**
 * Values that steer the apps' behaviour, served so they change without an app
 * update. The app keeps a default for each, used until this answers.
 */
export class AppConfigDto {
  @ApiProperty({
    example: 300,
    description:
      "Seconds a map square's places stay fresh. The app keeps showing older ones and reloads them in the background when they come into view.",
  })
  placesRefreshSeconds!: number;
}
