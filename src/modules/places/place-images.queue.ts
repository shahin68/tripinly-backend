export const PLACE_IMAGES_QUEUE = 'place-images';

export const PlaceImageJobs = {
  /** Daily: places whose image tags changed, then pending downloads. */
  SYNC: 'sync',
  /** Weekly: recheck stored images against Commons. */
  REVALIDATE: 'revalidate',
} as const;

/**
 * A run that fails (Wikimedia asking to slow down for long, a timeout) is tried
 * again 10, 20 and 40 minutes later instead of waiting for the next day.
 */
export const PLACE_IMAGE_JOB_RETRIES = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 10 * 60_000 },
} as const;
