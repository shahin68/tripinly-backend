export const PLACE_IMAGES_QUEUE = 'place-images';

export const PlaceImageJobs = {
  /** Daily: places whose image tags changed, then pending downloads. */
  SYNC: 'sync',
  /** Weekly: recheck stored images against Commons. */
  REVALIDATE: 'revalidate',
} as const;
