/** Every file of a photo lives under this prefix; deleting the prefix deletes the photo's files. */
export function photoPrefix(photoId: string): string {
  return `photos/${photoId}/`;
}

export function photoKeys(photoId: string) {
  const prefix = photoPrefix(photoId);
  return {
    /** The upload; replaced by a re-encoded copy without metadata once processed. */
    original: `${prefix}original`,
    /** 256 px square, for map pins and lists. */
    thumb: `${prefix}thumb.webp`,
    /** At most 1600 px on the long edge. */
    display: `${prefix}display.webp`,
  };
}

/** Anything that signs GET URLs (StorageService). Null when storage is off. */
export interface UrlSigner {
  signedGetUrl(key: string): string | null;
}

export function thumbUrl(
  signer: UrlSigner,
  photoId: string | null,
): string | null {
  return photoId ? signer.signedGetUrl(photoKeys(photoId).thumb) : null;
}
