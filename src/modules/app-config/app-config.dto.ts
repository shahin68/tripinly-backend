import { ApiProperty } from '@nestjs/swagger';

/** A city with public transport routes: both ends of a route must be inside it. */
export class TransitAreaDto {
  @ApiProperty({ example: 'vienna' })
  id!: string;

  @ApiProperty({ example: 'Vienna' })
  name!: string;

  @ApiProperty({ example: 48.11 })
  south!: number;

  @ApiProperty({ example: 16.18 })
  west!: number;

  @ApiProperty({ example: 48.33 })
  north!: number;

  @ApiProperty({ example: 16.58 })
  east!: number;
}

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

  @ApiProperty({
    example: 2560,
    description:
      'Longest edge, in pixels, the app shrinks a photo to before uploading it.',
  })
  photoMaxEdgePx!: number;

  @ApiProperty({
    example: 85,
    description:
      'JPEG quality (50–100) the app encodes photos with before uploading.',
  })
  photoJpegQuality!: number;

  @ApiProperty({
    example: 2,
    description: 'How many photos the app uploads at the same time.',
  })
  photoParallelUploads!: number;

  @ApiProperty({
    example: 95,
    description:
      "A place's `prominence` from which its map pin is drawn largest.",
  })
  pinLargeMinProminence!: number;

  @ApiProperty({
    example: 60,
    description:
      "A place's `prominence` from which its map pin is drawn middle-sized; below it, smallest.",
  })
  pinMediumMinProminence!: number;

  @ApiProperty({
    example: 150,
    description:
      'Most place pins the app draws on the map at once: liked places first, then the best known.',
  })
  mapMaxPins!: number;

  @ApiProperty({
    example: 90,
    description:
      "A place's pin shows its photo (`coverThumbUrl`) when its `prominence` is at least this, or its `hotCount` reaches `photoPinMinHotCount`.",
  })
  photoPinMinProminence!: number;

  @ApiProperty({
    example: 3,
    description:
      "A place's pin shows its photo when its `hotCount` is at least this, or `photoPinMinProminence`.",
  })
  photoPinMinHotCount!: number;

  @ApiProperty({
    example: 100,
    description:
      'Most pins the app draws with a photo at once, in pin order (liked places first, then the best known); the rest keep their icon.',
  })
  mapMaxPhotoPins!: number;

  @ApiProperty({
    example: 14,
    description:
      'Below this camera zoom (0–22), the app draws place pins as small dots, growing back to pins when zoomed in; the tapped place stays a pin.',
  })
  pinDotBelowZoom!: number;

  @ApiProperty({
    type: [TransitAreaDto],
    description:
      'Where public transport routes (mode=transit) work. The tram button is dimmed where a route would start or end outside every area, and everywhere when this is empty (switched off). Grows as cities are added on the server, without an app update.',
  })
  transitAreas!: TransitAreaDto[];

  @ApiProperty({
    example: true,
    description:
      "Whether OpenStreetMap places are listed (OSM_PINS_ENABLED). Off: the server leaves them out of in-view, tiles, search (no addresses), along the way, Around, Nearby and Popular, so only users' own spots come back; routes stay. The apps then show the OpenStreetMap credit only with a route.",
  })
  osmPinsEnabled!: boolean;
}
