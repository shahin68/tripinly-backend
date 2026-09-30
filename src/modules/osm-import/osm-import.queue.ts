export const OSM_IMPORT_QUEUE = 'osm-import';

export interface OsmImportJob {
  region: string;
}

/** BullMQ ids can't contain ':'; region paths contain '/'. */
export function regionJobKey(prefix: string, region: string): string {
  return `${prefix}-${region.replace(/[^a-z0-9-]/g, '-')}`;
}
