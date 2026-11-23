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

/** A place kind the apps show (spot card, filter chips, pins). */
export class PlaceKindDto {
  @ApiProperty({
    example: 'cafe',
    description: 'The key places carry as `category`',
  })
  key!: string;

  @ApiProperty({
    example: 'Café',
    description: 'In the Accept-Language language',
  })
  label!: string;

  @ApiProperty({
    type: 'integer',
    example: 4,
    description:
      "An ID in the apps' icon table; never reused. An ID the app doesn't know shows the plain Spot icon",
  })
  icon!: number;

  @ApiProperty({ description: 'People can pick it for a spot they make' })
  forSpots!: boolean;

  @ApiProperty({ description: 'Offered as a filter chip' })
  forFilters!: boolean;
}

/** An Explore period the apps offer (Near me is the apps' own toggle on top). */
export class ExplorePeriodItemDto {
  @ApiProperty({
    example: 'month',
    description: 'Sent back as `period` to GET /explore/trips',
  })
  key!: string;

  @ApiProperty({ example: 'This month' })
  label!: string;

  @ApiProperty({
    type: 'integer',
    example: 60,
    description: 'As PlaceKindDto.icon',
  })
  icon!: number;

  @ApiProperty({ description: 'The one picked when Explore opens' })
  isDefault!: boolean;
}

/** A reason people can give when they report something. */
export class ReportReasonDto {
  @ApiProperty({
    example: 'spam',
    description: 'Sent back as `reason` to POST /reports',
  })
  key!: string;

  @ApiProperty({ example: 'Spam' })
  label!: string;
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

  @ApiProperty({
    type: [PlaceKindDto],
    description:
      'Every place kind in display order, labels in the Accept-Language language. The apps keep it with the config, per language.',
  })
  placeKinds!: PlaceKindDto[];

  @ApiProperty({
    type: [ExplorePeriodItemDto],
    description: "Explore's periods in menu order",
  })
  explorePeriods!: ExplorePeriodItemDto[];

  @ApiProperty({
    type: [ReportReasonDto],
    description: 'Report reasons in display order',
  })
  reportReasons!: ReportReasonDto[];
}
