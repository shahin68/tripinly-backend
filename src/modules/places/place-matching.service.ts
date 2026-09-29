import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import {
  Prisma,
  type PlaceCategory,
  type PlaceSource,
} from '../../generated/prisma/client';
import { TripAccessService } from '../trips/trip-access.service';
import { normalizePlaceName } from './normalize-name';

type Tx = Prisma.TransactionClient;

/** Custom pins within this distance and with the same normalized name share a place. */
export const PLACE_MATCH_RADIUS_METERS = 30;

export type PlaceInput =
  | { placeId: string }
  | {
      name: string;
      lat: number;
      lng: number;
      osm?: { type: 'node' | 'way' | 'relation'; id: bigint };
      category?: PlaceCategory;
    };

export interface MatchedPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * Links markers to places (geo-discovery skill): an existing place by id, by
 * OSM ids, or by name within 30 m; otherwise a new `user` place. Runs inside
 * the caller's transaction. Never takes Google data.
 */
@Injectable()
export class PlaceMatchingService {
  constructor(private readonly access: TripAccessService) {}

  /** `userId` is the caller: a place picked by id must be one they can see. */
  async match(
    tx: Tx,
    input: PlaceInput,
    userId: string,
  ): Promise<MatchedPlace> {
    if ('placeId' in input) {
      const place = await tx.place.findFirst({
        where: { id: input.placeId, isActive: true },
        select: {
          id: true,
          name: true,
          lat: true,
          lng: true,
          source: true,
          popularity: true,
        },
      });
      if (!place || !(await this.isVisible(tx, userId, place))) {
        throw AppException.validation({ placeId: ['notFound'] });
      }
      return { id: place.id, name: place.name, lat: place.lat, lng: place.lng };
    }

    const normalizedName = normalizePlaceName(input.name);
    if (input.osm) {
      const existing = await tx.place.findUnique({
        where: {
          osmType_osmId: { osmType: input.osm.type, osmId: input.osm.id },
        },
        select: { id: true, name: true, lat: true, lng: true },
      });
      if (existing) return existing;
    } else {
      const [nearby] = await tx.$queryRaw<MatchedPlace[]>`
        SELECT id, name, lat, lng FROM places
        WHERE "normalizedName" = ${normalizedName} AND "isActive"
          AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography, ${PLACE_MATCH_RADIUS_METERS})
        ORDER BY location <-> ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography
        LIMIT 1`;
      if (nearby) return nearby;
    }

    const data: Prisma.PlaceCreateInput = {
      name: input.name,
      normalizedName,
      searchText: normalizedName,
      category: input.category ?? 'other',
      lat: input.lat,
      lng: input.lng,
      source: 'user',
      osmType: input.osm?.type,
      osmId: input.osm?.id,
    };
    if (!input.osm) {
      return tx.place.create({
        data,
        select: { id: true, name: true, lat: true, lng: true },
      });
    }
    // Two markers for the same OSM feature may race; the unique (osmType, osmId) decides.
    const [created] = await tx.$queryRaw<MatchedPlace[]>`
      INSERT INTO places (id, name, "normalizedName", "searchText", category, lat, lng, source, "osmType", "osmId", "updatedAt")
      VALUES (gen_random_uuid(), ${data.name}, ${normalizedName}, ${normalizedName}, ${data.category}::"PlaceCategory",
              ${input.lat}, ${input.lng}, 'user', ${input.osm.type}::"OsmType", ${input.osm.id}, now())
      ON CONFLICT ("osmType", "osmId") DO UPDATE SET "updatedAt" = places."updatedAt"
      RETURNING id, name, lat, lng`;
    return created;
  }

  /**
   * OSM places and places liked on public trips are public. Any other user
   * place (a custom pin, maybe from a private trip) only to people who can see
   * a marker at it.
   */
  async isVisible(
    db: Tx,
    userId: string,
    place: { id: string; source: PlaceSource; popularity: number },
  ): Promise<boolean> {
    if (place.source === 'osm' || place.popularity > 0) return true;
    const marker = await db.marker.findFirst({
      where: { placeId: place.id, trip: this.access.visibleTripsWhere(userId) },
      select: { id: true },
    });
    return marker !== null;
  }
}
