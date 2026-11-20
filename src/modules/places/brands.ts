import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import type { Env } from '../../common/config/env';
import type { CommonsFileInfo, ExtMetadata } from './commons-metadata';
import type { PlaceBrandDto } from './places.dto';

/** A place's brand as the place queries select it (`BRAND_COLUMN`). */
export interface BrandRef {
  id: string;
  name: string;
  wikidataId: string | null;
  logoHash: string | null;
}

/** Logos are this many pixels square: sharp on a 44 dp pin at 2x, a few KB. */
export const BRAND_LOGO_SIZE = 96;
/** Above this the logo is encoded again at a lower quality. */
const MAX_LOGO_BYTES = 8 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;

/** The URL path of a brand's logo; its hash changes with the logo, so phones may cache it forever. */
export function brandLogoPath(id: string, hash: string): string {
  return `/v1/brands/${id}/logo/${hash}`;
}

/**
 * Whether a brand's logo shows: only with BRAND_LOGOS_ENABLED and when the
 * brand isn't in BRAND_LOGOS_HIDDEN (by name or Wikidata id, any case). A
 * brand without a shown logo still comes with its name; its pin stays round.
 */
@Injectable()
export class BrandPolicy {
  constructor(private readonly config: ConfigService<Env, true>) {}

  showsLogo(brand: Pick<BrandRef, 'name' | 'wikidataId'>): boolean {
    if (!this.config.get('BRAND_LOGOS_ENABLED', { infer: true })) return false;
    const hidden = this.config.get('BRAND_LOGOS_HIDDEN', { infer: true });
    return !hidden.some(
      (entry) =>
        entry === brand.name.trim().toLowerCase() ||
        entry === brand.wikidataId?.toLowerCase(),
    );
  }

  present(brand: BrandRef | null | undefined): PlaceBrandDto | null {
    if (!brand) return null;
    return {
      id: brand.id,
      name: brand.name,
      logoUrl:
        brand.logoHash && this.showsLogo(brand)
          ? brandLogoPath(brand.id, brand.logoHash)
          : null,
    };
  }
}

/**
 * Any logo image (PNG, JPEG, WebP, SVG) as a small square WebP for a pin: put
 * on white, cut to the logo itself, fitted into BRAND_LOGO_SIZE with white
 * around. Null when nothing is left on white (a white logo on transparency
 * would vanish on the pin's white tile).
 */
export async function renderBrandLogo(
  input: Buffer,
): Promise<{ logo: Buffer; hash: string } | null> {
  const flat = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    density: 300,
  })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  let trimmed: Buffer;
  try {
    trimmed = await sharp(flat)
      .trim({ background: '#ffffff', threshold: 10 })
      .toBuffer();
  } catch {
    // Nothing but background.
    return null;
  }
  const { channels } = await sharp(trimmed).stats();
  const darkest = Math.min(...channels.slice(0, 3).map((c) => c.min));
  if (darkest > 235) return null;
  const square = sharp(trimmed).resize(BRAND_LOGO_SIZE, BRAND_LOGO_SIZE, {
    fit: 'contain',
    background: '#ffffff',
  });
  let logo = await square.clone().webp({ quality: 82 }).toBuffer();
  if (logo.length > MAX_LOGO_BYTES) {
    logo = await square.clone().webp({ quality: 55 }).toBuffer();
  }
  return {
    logo,
    hash: createHash('sha256').update(logo).digest('hex').slice(0, 16),
  };
}

const LOGO_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
]);
/** Logos need no credit on a pin: public domain or CC0 only. */
const LOGO_LICENSES = new Set(['pd', 'cc0']);

/**
 * Whether a Commons file can be a brand logo: public domain or CC0, not
 * deleted or non-free. "Trademarked" is the only restriction allowed: it's
 * about the brand, not the file's copyright, and BRAND_LOGOS_ENABLED waits for
 * legal review (Shahin, 2026-11-20).
 */
export function isUsableLogo(file: CommonsFileInfo): boolean {
  const meta = file.extmetadata;
  if (!LOGO_MIMES.has(file.mime)) return false;
  if (field(meta, 'DeletionReason')) return false;
  if (/^true$/i.test(field(meta, 'NonFree') ?? '')) return false;
  const restrictions = (field(meta, 'Restrictions') ?? '')
    .split('|')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (restrictions.some((r) => r !== 'trademarked')) return false;
  return LOGO_LICENSES.has(field(meta, 'License')?.toLowerCase() ?? '');
}

function field(meta: ExtMetadata, key: string): string | undefined {
  const value = meta[key]?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
