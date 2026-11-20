import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isUsableLogo, renderBrandLogo } from './brands';
import { WIKIMEDIA_BATCH, WikimediaClient } from './wikimedia.client';

/** Brands looked at per run; the job queues itself again while more remain. */
const BRANDS_PER_RUN = 200;
/** A brand's Wikimedia logo is looked for again after this long. */
const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface BrandLogoSyncResult {
  brands: number;
  logos: number;
  more: boolean;
}

/**
 * Brand logos from Wikimedia (10-maps-places-routing.md, Brands): a brand's
 * Wikidata logo (P154) on Commons, public domain or CC0 only, made into a tiny
 * square WebP (`renderBrandLogo`) and kept on the brand row. A logo we uploaded
 * wins and is never replaced. Only brands with an active place are looked at,
 * the brands with the most places first; each again a month later.
 */
@Injectable()
export class BrandLogosService {
  private readonly logger = new Logger(BrandLogosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wikimedia: WikimediaClient,
  ) {}

  async sync(now = new Date()): Promise<BrandLogoSyncResult> {
    const due = await this.prisma.$queryRaw<
      { id: string; wikidataId: string; commonsTitle: string | null }[]
    >`
      SELECT b.id, b."wikidataId", b."commonsTitle" FROM brands b
      WHERE b."wikidataId" IS NOT NULL
        AND b."logoSource" IS DISTINCT FROM 'upload'
        AND (b."logoCheckedAt" IS NULL
             OR b."logoCheckedAt" < ${new Date(now.getTime() - RECHECK_AFTER_MS)})
        AND EXISTS (SELECT 1 FROM places p WHERE p."brandId" = b.id AND p."isActive")
      ORDER BY (SELECT count(*) FROM places p WHERE p."brandId" = b.id AND p."isActive") DESC, b.id
      LIMIT ${BRANDS_PER_RUN}`;
    let logos = 0;
    for (let i = 0; i < due.length; i += WIKIMEDIA_BATCH) {
      const batch = due.slice(i, i + WIKIMEDIA_BATCH);
      const titles = await this.wikimedia.wikidataLogos(
        batch.map((brand) => brand.wikidataId),
      );
      const files = await this.wikimedia.commonsImages([
        ...new Set(titles.values()),
      ]);
      for (const brand of batch) {
        const title = titles.get(brand.wikidataId) ?? null;
        const file = title ? (files.get(title) ?? null) : null;
        let rendered: Awaited<ReturnType<typeof renderBrandLogo>> = null;
        if (file && isUsableLogo(file)) {
          try {
            rendered = await renderBrandLogo(
              await this.wikimedia.download(file.thumbUrl),
            );
          } catch (error) {
            // A passing failure keeps the logo it has; the next run tries again.
            this.logger.warn(
              `Brand logo ${brand.wikidataId} failed: ${(error as Error).name}`,
            );
            continue;
          }
        }
        // Only a brand still without an upload of ours: one may have come meanwhile.
        await this.prisma.brand.updateMany({
          where: {
            id: brand.id,
            OR: [{ logoSource: null }, { logoSource: 'wikimedia' }],
          },
          data: rendered
            ? {
                logo: new Uint8Array(rendered.logo),
                logoHash: rendered.hash,
                logoSource: 'wikimedia',
                commonsTitle: title,
                logoCheckedAt: now,
              }
            : {
                logo: null,
                logoHash: null,
                logoSource: null,
                commonsTitle: null,
                logoCheckedAt: now,
              },
        });
        if (rendered) logos++;
      }
    }
    // Logged even with nothing due, so the logs show the sync ran.
    this.logger.log(`Brand logos: ${due.length} brands, ${logos} logos`);
    return {
      brands: due.length,
      logos,
      more: due.length === BRANDS_PER_RUN,
    };
  }
}
