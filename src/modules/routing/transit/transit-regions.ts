/**
 * Where public transport routes work: one recipe per city, read by the api
 * (coverage areas, sent to the apps), the transit builder (what to download
 * and build) and the transit service. A city goes live by adding its id to
 * TRANSIT_REGIONS on Railway (docs/knowledge/10-maps-places-routing.md).
 */
export interface TransitRegion {
  id: string;
  /** Shown to people, e.g. in the app's "not available here" note. */
  name: string;
  /** Covered area: routes start and end inside it. */
  bbox: { south: number; west: number; north: number; east: number };
  /** IANA time zone the timetables run in. */
  timeZone: string;
  /** GTFS timetables, merged into one build. */
  feeds: { id: string; url: string; licence: string; credit: string }[];
  /** Geofabrik extract the streets (walking to and from stops) are cut from. */
  osmExtract: string;
}

export const TRANSIT_REGIONS: Record<string, TransitRegion> = {
  vienna: {
    id: 'vienna',
    name: 'Vienna',
    bbox: { south: 48.11, west: 16.18, north: 48.33, east: 16.58 },
    timeZone: 'Europe/Vienna',
    feeds: [
      {
        id: 'wl',
        url: 'https://www.wienerlinien.at/ogd_realtime/doku/ogd/gtfs/gtfs.zip',
        licence: 'CC BY 4.0',
        // Vienna's open data portal asks for this credit (checked again before launch).
        credit: 'Wiener Linien, Datenquelle: Stadt Wien – data.wien.gv.at',
      },
    ],
    osmExtract: 'europe/austria',
  },
};

export const TRANSIT_REGION_IDS = Object.keys(TRANSIT_REGIONS);

/** The region containing both points, if any. */
export function regionFor(
  ids: readonly string[],
  ...points: { lat: number; lng: number }[]
): TransitRegion | undefined {
  return ids
    .map((id) => TRANSIT_REGIONS[id])
    .find(
      (region) =>
        region !== undefined &&
        points.every(
          ({ lat, lng }) =>
            lat >= region.bbox.south &&
            lat <= region.bbox.north &&
            lng >= region.bbox.west &&
            lng <= region.bbox.east,
        ),
    );
}

/** "Timetables: Wiener Linien (CC BY 4.0)" for the regions given. */
export function transitCredit(regions: readonly TransitRegion[]): string {
  return regions
    .flatMap((region) => region.feeds)
    .map((feed) => `${feed.credit} (${feed.licence})`)
    .join(', ');
}
