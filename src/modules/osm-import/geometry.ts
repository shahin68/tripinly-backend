type Position = number[];
type Ring = Position[];

export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] }
  | { type: string; coordinates?: unknown };

export interface Point {
  lat: number;
  lng: number;
}

/**
 * One point that stands for a feature on the map: the node itself, the middle
 * vertex of a line, and for an area a point guaranteed to lie inside it (the
 * centroid when it is inside, otherwise the middle of the widest interior
 * span on a horizontal line through the area). Degrees are treated as planar,
 * which is fine at POI scale.
 */
export function representativePoint(geometry: Geometry): Point | null {
  switch (geometry.type) {
    case 'Point':
      return toPoint(geometry.coordinates as Position);
    case 'LineString':
      return middleVertex(geometry.coordinates as Position[]);
    case 'MultiLineString': {
      const lines = geometry.coordinates as Position[][];
      return middleVertex(longest(lines, (line) => line.length) ?? []);
    }
    case 'Polygon':
      return pointInPolygon(geometry.coordinates as Ring[]);
    case 'MultiPolygon': {
      const polygons = geometry.coordinates as Ring[][];
      const largest = longest(polygons, (polygon) =>
        Math.abs(signedArea(polygon[0] ?? [])),
      );
      return largest ? pointInPolygon(largest) : null;
    }
    default:
      return null;
  }
}

function toPoint(position: Position | undefined): Point | null {
  if (!position || position.length < 2) return null;
  const [lng, lat] = position;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function middleVertex(line: Position[]): Point | null {
  return toPoint(line[Math.floor(line.length / 2)]);
}

function longest<T>(items: T[], size: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestSize = -Infinity;
  for (const item of items) {
    const value = size(item);
    if (value > bestSize) {
      best = item;
      bestSize = value;
    }
  }
  return best;
}

function signedArea(ring: Ring): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

function pointInPolygon(polygon: Ring[]): Point | null {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return null;

  const centroid = ringCentroid(outer);
  if (centroid && contains(polygon, centroid[0], centroid[1])) {
    return toPoint(centroid);
  }

  // Concave or holed area: scan the latitude through the ring's middle.
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [, lat] of outer) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  for (const fraction of [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875]) {
    const lat = minLat + (maxLat - minLat) * fraction;
    const span = widestInteriorSpan(polygon, lat);
    if (span) return toPoint([(span[0] + span[1]) / 2, lat]);
  }
  return toPoint(outer[0]);
}

function ringCentroid(ring: Ring): Position | null {
  const area = signedArea(ring);
  if (area === 0) return null;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  return [x / (6 * area), y / (6 * area)];
}

/** Even-odd rule over all rings, so holes count as outside. */
function contains(polygon: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function widestInteriorSpan(
  polygon: Ring[],
  y: number,
): [number, number] | null {
  const crossings: number[] = [];
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y) {
        crossings.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
  }
  crossings.sort((a, b) => a - b);
  let best: [number, number] | null = null;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const width = crossings[i + 1] - crossings[i];
    if (width > 0 && (!best || width > best[1] - best[0])) {
      best = [crossings[i], crossings[i + 1]];
    }
  }
  return best;
}
