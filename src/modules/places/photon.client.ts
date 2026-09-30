import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import type { SearchResultDto } from './places.dto';

const PHOTON_TIMEOUT_MS = 2_000;
const PHOTON_LIMIT = 8;
/** Languages the public Photon index has names for; others get local names. */
const PHOTON_LANGUAGES = new Set(['en', 'de', 'fr']);
const OSM_TYPE: Record<string, SearchResultDto['osmType']> = {
  N: 'node',
  W: 'way',
  R: 'relation',
};

interface PhotonFeature {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
}

export interface PhotonQuery {
  q: string;
  lang: string;
  near?: { lat: number; lng: number };
}

/**
 * Photon (OSM geocoder) for addresses, streets and cities. Results carry no
 * id: the client sends name + location (+ OSM ids) when adding a marker. Any
 * failure returns no results; search then shows our places only.
 */
@Injectable()
export class PhotonClient {
  private readonly logger = new Logger(PhotonClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async search({ q, lang, near }: PhotonQuery): Promise<SearchResultDto[]> {
    const url = new URL(
      '/api',
      this.config.get('PHOTON_BASE_URL', { infer: true }),
    );
    url.searchParams.set('q', q);
    url.searchParams.set('limit', String(PHOTON_LIMIT));
    if (PHOTON_LANGUAGES.has(lang)) url.searchParams.set('lang', lang);
    if (near) {
      url.searchParams.set('lat', String(near.lat));
      url.searchParams.set('lon', String(near.lng));
    }
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Tripinly/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { features?: unknown };
      return Array.isArray(body.features)
        ? body.features.flatMap(
            (feature: PhotonFeature) => toResult(feature) ?? [],
          )
        : [];
    } catch (error) {
      // No query text or coordinates in logs.
      this.logger.warn(
        `Photon search failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return [];
    }
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function toResult(feature: PhotonFeature): SearchResultDto | null {
  const props = feature.properties ?? {};
  const coordinates = feature.geometry?.coordinates;
  if (feature.geometry?.type !== 'Point' || !Array.isArray(coordinates))
    return null;
  const [lng, lat] = coordinates as unknown[];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const street = [text(props.street), text(props.housenumber)]
    .filter(Boolean)
    .join(' ');
  const name = text(props.name) ?? (street || undefined);
  if (!name) return null;

  const city = text(props.city) ?? text(props.district) ?? text(props.county);
  const address = [
    street && street !== name ? street : undefined,
    city && city !== name ? city : undefined,
    text(props.country) !== name ? text(props.country) : undefined,
  ].filter(Boolean);

  const osmType = OSM_TYPE[String(props.osm_type)] ?? null;
  const osmId =
    typeof props.osm_id === 'number' &&
    Number.isSafeInteger(props.osm_id) &&
    props.osm_id > 0
      ? String(props.osm_id)
      : null;

  return {
    source: 'photon',
    id: null,
    name: name.slice(0, 120),
    category: null,
    location: { lat, lng },
    isTripinly: false,
    likeCount: 0,
    type: text(props.type) ?? null,
    address: address.length ? address.join(', ') : null,
    osmType: osmType && osmId ? osmType : null,
    osmId: osmType && osmId ? osmId : null,
  };
}
