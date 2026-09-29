import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import type { PlaceCategory } from '../../src/generated/prisma/client';
import { normalizePlaceName } from '../../src/modules/places/normalize-name';

export interface PlaceSeed {
  name: string;
  lat: number;
  lng: number;
  category?: PlaceCategory;
  source?: 'osm' | 'user';
  popularity?: number;
  isActive?: boolean;
  names?: Record<string, string>;
  tags?: Record<string, string>;
  osmId?: number;
}

let nextOsmId = 1_000_000;

/** Inserts a place directly (OSM by default, with a fresh node id). Returns its id. */
export async function insertPlace(
  app: INestApplication,
  seed: PlaceSeed,
): Promise<string> {
  const source = seed.source ?? 'osm';
  const normalizedName = normalizePlaceName(seed.name);
  const variants = new Set([normalizedName]);
  for (const value of Object.values(seed.names ?? {}))
    variants.add(normalizePlaceName(value));
  const place = await app.get(PrismaService).place.create({
    data: {
      name: seed.name,
      normalizedName,
      searchText: [...variants].join(' '),
      names: seed.names ?? {},
      category: seed.category ?? 'attraction',
      lat: seed.lat,
      lng: seed.lng,
      source,
      osmType: source === 'osm' ? 'node' : undefined,
      osmId: source === 'osm' ? BigInt(seed.osmId ?? nextOsmId++) : undefined,
      osmRegion: source === 'osm' ? 'test/region' : undefined,
      popularity: seed.popularity ?? 0,
      isActive: seed.isActive ?? true,
      tags: seed.tags ?? {},
    },
    select: { id: true },
  });
  return place.id;
}
