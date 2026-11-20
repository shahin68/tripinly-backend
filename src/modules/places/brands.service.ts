import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { type BrandRef, BrandPolicy, renderBrandLogo } from './brands';
import type { CreateBrandDto } from './brands.dto';
import type { PlaceBrandDto } from './places.dto';

const PICKER_LIMIT = 20;
const BRAND_SELECT = {
  id: true,
  name: true,
  wikidataId: true,
  logoHash: true,
} as const;

/**
 * Our brands list (10-maps-places-routing.md, Brands): the source of truth for
 * which brand a place belongs to. The OSM import adds brands from
 * `brand:wikidata`; admins add others and upload logos; people pick from it
 * for their own spots but can't add to it.
 */
@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: BrandPolicy,
  ) {}

  /**
   * Brands whose name has a word starting with [q], most places first; none
   * while brands are off, so the apps show no "This is a brand store".
   */
  async search(q: string): Promise<PlaceBrandDto[]> {
    if (!this.policy.isOn()) return [];
    const rows = await this.prisma.$queryRaw<BrandRef[]>`
      SELECT b.id, b.name, b."wikidataId", b."logoHash" FROM brands b
      WHERE lower(b.name) ~ ('(^|[^[:alnum:]])' || ${escapeRegex(q.toLowerCase())})
      ORDER BY (SELECT count(*) FROM places p WHERE p."brandId" = b.id AND p."isActive") DESC,
               b.name, b.id
      LIMIT ${PICKER_LIMIT}`;
    return rows.map((row) => this.policy.present(row)!);
  }

  /**
   * The logo's bytes, only while it shows (BRAND_LOGOS_ENABLED, not hidden)
   * and [hash] is its current one; otherwise null, which answers 404.
   */
  async logo(id: string, hash: string): Promise<Buffer | null> {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      select: { ...BRAND_SELECT, logo: true },
    });
    if (!brand?.logo || brand.logoHash !== hash) return null;
    if (!this.policy.showsLogo(brand)) return null;
    return Buffer.from(brand.logo);
  }

  async create(input: CreateBrandDto): Promise<PlaceBrandDto> {
    try {
      const brand = await this.prisma.brand.create({
        data: { name: input.name, wikidataId: input.wikidataId ?? null },
        select: BRAND_SELECT,
      });
      return this.policy.present(brand)!;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw AppException.validation({ wikidataId: ['taken'] });
      }
      throw error;
    }
  }

  /** Our own logo for a brand: it wins over Wikimedia's from now on. */
  async uploadLogo(id: string, base64: string): Promise<PlaceBrandDto> {
    await this.findOrThrow(id);
    let rendered: Awaited<ReturnType<typeof renderBrandLogo>>;
    try {
      rendered = await renderBrandLogo(Buffer.from(base64, 'base64'));
    } catch {
      rendered = null;
    }
    if (!rendered) {
      // Not an image sharp can read, or nothing left on white.
      throw new AppException(
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    const brand = await this.prisma.brand.update({
      where: { id },
      data: {
        logo: new Uint8Array(rendered.logo),
        logoHash: rendered.hash,
        logoSource: 'upload',
        commonsTitle: null,
      },
      select: BRAND_SELECT,
    });
    return this.policy.present(brand)!;
  }

  /** Drops our logo; the next sync looks for the Wikimedia one again. */
  async removeLogo(id: string): Promise<PlaceBrandDto> {
    await this.findOrThrow(id);
    const brand = await this.prisma.brand.update({
      where: { id },
      data: {
        logo: null,
        logoHash: null,
        logoSource: null,
        commonsTitle: null,
        logoCheckedAt: null,
      },
      select: BRAND_SELECT,
    });
    return this.policy.present(brand)!;
  }

  /**
   * Ties a place to a brand or unties it (a wrong "brand store" on a user's
   * spot). An OSM place is tied again by the next import while its OSM tag
   * says so.
   */
  async setPlaceBrand(placeId: string, brandId: string | null): Promise<void> {
    if (brandId) await this.findOrThrow(brandId);
    const { count } = await this.prisma.place.updateMany({
      where: { id: placeId },
      data: { brandId },
    });
    if (count === 0) throw AppException.notFound();
  }

  /** A brand id people picked for their spot, checked to exist. */
  async existing(id: string): Promise<string> {
    return (await this.findOrThrow(id)).id;
  }

  private async findOrThrow(id: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!brand) throw AppException.notFound();
    return brand;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
