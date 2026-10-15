import type { UrlSigner } from '../photos/photo-keys';

/** Every file of a place image lives under this prefix. */
export function placeImagePrefix(imageId: string): string {
  return `place-images/${imageId}/`;
}

export function placeImageKeys(imageId: string) {
  const prefix = placeImagePrefix(imageId);
  return {
    /** 256 px square, for map pins and the card strip. */
    thumb: `${prefix}thumb.webp`,
    /** At most 1280 px wide, never upscaled. */
    display: `${prefix}display.webp`,
  };
}

export function placeImageThumbUrl(
  signer: UrlSigner,
  imageId: string | null,
): string | null {
  return imageId ? signer.signedGetUrl(placeImageKeys(imageId).thumb) : null;
}
