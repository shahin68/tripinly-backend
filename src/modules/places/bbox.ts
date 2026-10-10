import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** From this zoom on, in-view adds OSM places; below it, only Tripinly places (clustered). */
export const OSM_FILL_MIN_ZOOM = 14;

/**
 * Largest bbox side accepted at a zoom level: about eight 256 px tiles, a
 * generous margin over a tablet screen (0.18° at zoom 14, the whole world at 3).
 */
export function maxSpanForZoom(zoom: number): number {
  return Math.min(360, 2880 / 2 ** Math.floor(zoom));
}

/** Parses `minLng,minLat,maxLng,maxLat` (format already checked by the DTO). */
export function parseBbox(value: string): Bbox {
  const [minLng, minLat, maxLng, maxLat] = value.split(',').map(Number);
  const valid =
    minLng >= -180 &&
    maxLng <= 180 &&
    minLat >= -90 &&
    maxLat <= 90 &&
    minLng < maxLng &&
    minLat < maxLat;
  if (!valid) throw AppException.validation({ bbox: ['invalidBbox'] });
  return { minLng, minLat, maxLng, maxLat };
}

export function assertBboxSpan(bbox: Bbox, maxSpan: number): void {
  if (
    bbox.maxLng - bbox.minLng > maxSpan ||
    bbox.maxLat - bbox.minLat > maxSpan
  ) {
    throw new AppException(ErrorCode.BBOX_TOO_LARGE, HttpStatus.BAD_REQUEST, {
      maxSpanDegrees: maxSpan,
    });
  }
}

/**
 * Widens the bbox outwards to a quarter-tile grid, so nearby viewports share a
 * cache entry. Results are computed for the widened box.
 */
export function snapBbox(bbox: Bbox, zoom: number): Bbox {
  const step = 360 / 2 ** (Math.floor(zoom) + 2);
  const down = (value: number) => Math.floor(value / step) * step;
  const up = (value: number) => Math.ceil(value / step) * step;
  return {
    minLng: Math.max(-180, down(bbox.minLng)),
    minLat: Math.max(-90, down(bbox.minLat)),
    maxLng: Math.min(180, up(bbox.maxLng)),
    maxLat: Math.min(90, up(bbox.maxLat)),
  };
}

/**
 * A map square `z/x/y` on the same degree grid as the snapping: `360 / 2^z` degrees a side, square
 * x spans longitudes `[x·side, (x+1)·side]` and y latitudes `[y·side, (y+1)·side]`, cut at the poles.
 */
export function parseTile(value: string): Bbox {
  const [z, x, y] = value.split('/').map(Number);
  const side = 360 / 2 ** z;
  const bbox = {
    minLng: x * side,
    minLat: Math.max(-90, y * side),
    maxLng: (x + 1) * side,
    maxLat: Math.min(90, (y + 1) * side),
  };
  const valid =
    z <= 22 &&
    bbox.minLng >= -180 &&
    bbox.maxLng <= 180 &&
    bbox.minLat < bbox.maxLat;
  if (!valid) throw AppException.validation({ tiles: ['invalidTiles'] });
  return bbox;
}
