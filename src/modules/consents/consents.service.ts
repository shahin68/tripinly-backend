import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import type {
  ConsentDocumentType,
  LegalDocument,
} from '../../generated/prisma/client';

/** Must be accepted (current version) before using the app. */
export const REQUIRED_DOCUMENTS: readonly ConsentDocumentType[] = [
  'terms',
  'privacy',
];

const DOCUMENT_CACHE_MS = 30_000;
const CONSENT_OK_TTL_SECONDS = 600;
const consentOkKey = (userId: string) => `consents:ok:${userId}`;

export interface RequiredVersion {
  documentType: ConsentDocumentType;
  /** Latest published version: what users accept now. */
  currentVersion: string;
  /** Accepting any version published on/after this still counts (no re-consent needed since). */
  minimumPublishedAt: Date;
}

export interface ConsentRecordInput {
  documentType: ConsentDocumentType;
  version: string;
  locale: string;
  granted: boolean;
}

@Injectable()
export class ConsentsService {
  private cache?: { at: number; documents: LegalDocument[] };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Current version of each document type, in the best available locale. */
  async currentDocuments(locale: string): Promise<LegalDocument[]> {
    const documents = await this.publishedDocuments();
    const result: LegalDocument[] = [];
    for (const type of ['terms', 'privacy', 'marketing'] as const) {
      const ofType = documents.filter((doc) => doc.documentType === type);
      if (ofType.length === 0) continue;
      const latest = ofType[0].version;
      const variants = ofType.filter((doc) => doc.version === latest);
      result.push(pickLocale(variants, locale));
    }
    return result;
  }

  async requiredVersions(): Promise<RequiredVersion[]> {
    const documents = await this.publishedDocuments();
    return REQUIRED_DOCUMENTS.flatMap((type) => {
      const ofType = documents.filter((doc) => doc.documentType === type);
      if (ofType.length === 0) return [];
      const reconsentPoints = ofType.filter((doc) => doc.requiresReconsent);
      const minimum =
        reconsentPoints[0]?.publishedAt ??
        ofType[ofType.length - 1].publishedAt;
      return [
        {
          documentType: type,
          currentVersion: ofType[0].version,
          minimumPublishedAt: minimum,
        },
      ];
    });
  }

  /** Required document types the user still has to accept. */
  async missingRequired(userId: string): Promise<ConsentDocumentType[]> {
    const [required, documents, latestRows] = await Promise.all([
      this.requiredVersions(),
      this.publishedDocuments(),
      this.prisma.consent.findMany({
        where: { userId, documentType: { in: [...REQUIRED_DOCUMENTS] } },
        orderBy: { createdAt: 'desc' },
        distinct: ['documentType'],
      }),
    ]);
    const missing = REQUIRED_DOCUMENTS.filter(
      (type) => !required.some((r) => r.documentType === type),
    );
    for (const requirement of required) {
      const row = latestRows.find(
        (r) => r.documentType === requirement.documentType,
      );
      const acceptedPublishedAt = row?.grantedAt
        ? documents.find(
            (doc) =>
              doc.documentType === requirement.documentType &&
              doc.version === row.version,
          )?.publishedAt
        : undefined;
      if (
        !acceptedPublishedAt ||
        acceptedPublishedAt < requirement.minimumPublishedAt
      ) {
        missing.push(requirement.documentType);
      }
    }
    return missing;
  }

  /** Cached check for the request guard; invalidated on every consent change. */
  async hasRequired(userId: string): Promise<boolean> {
    const fingerprint = await this.requirementFingerprint();
    const cached = await this.redis.get(consentOkKey(userId)).catch(() => null);
    if (cached === fingerprint) return true;
    const ok = (await this.missingRequired(userId)).length === 0;
    if (ok) {
      await this.redis
        .set(consentOkKey(userId), fingerprint, 'EX', CONSENT_OK_TTL_SECONDS)
        .catch(() => undefined);
    }
    return ok;
  }

  async record(userId: string, input: ConsentRecordInput): Promise<void> {
    const documents = await this.publishedDocuments();
    const ofType = documents.filter(
      (doc) => doc.documentType === input.documentType,
    );
    const exists = ofType.some((doc) => doc.version === input.version);
    const isCurrent = ofType[0]?.version === input.version;
    if (!exists || (input.granted && !isCurrent)) {
      throw AppException.validation({ version: ['notCurrentVersion'] });
    }
    const now = new Date();
    await this.prisma.consent.create({
      data: {
        userId,
        documentType: input.documentType,
        version: input.version,
        locale: input.locale,
        grantedAt: input.granted ? now : null,
        withdrawnAt: input.granted ? null : now,
      },
    });
    await this.redis.del(consentOkKey(userId)).catch(() => undefined);
  }

  /** Latest consent row per document type. */
  async listForUser(userId: string) {
    return this.prisma.consent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      distinct: ['documentType'],
    });
  }

  private async requirementFingerprint(): Promise<string> {
    const required = await this.requiredVersions();
    return required
      .map((r) => `${r.documentType}@${r.minimumPublishedAt.toISOString()}`)
      .join('|');
  }

  /** Published documents, newest first, cached briefly in memory. */
  private async publishedDocuments(): Promise<LegalDocument[]> {
    if (this.cache && Date.now() - this.cache.at < DOCUMENT_CACHE_MS) {
      return this.cache.documents;
    }
    const documents = await this.prisma.legalDocument.findMany({
      where: { publishedAt: { lte: new Date() } },
      orderBy: [{ publishedAt: 'desc' }, { version: 'desc' }],
    });
    this.cache = { at: Date.now(), documents };
    return documents;
  }

  /** Test hook: forget cached documents after inserting new ones. */
  clearCache(): void {
    this.cache = undefined;
  }
}

export function pickLocale<T extends { locale: string }>(
  variants: T[],
  locale: string,
): T {
  const wanted = locale.toLowerCase();
  const language = wanted.split('-')[0];
  return (
    variants.find((v) => v.locale.toLowerCase() === wanted) ??
    variants.find((v) => v.locale.toLowerCase().split('-')[0] === language) ??
    variants.find((v) => v.locale.toLowerCase().startsWith('en')) ??
    variants[0]
  );
}
