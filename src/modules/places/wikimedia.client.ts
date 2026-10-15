import { Injectable, Logger } from '@nestjs/common';
import type { CommonsFileInfo, ExtMetadata } from './commons-metadata';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
/** Wikimedia's User-Agent policy asks for a contact (Shahin's OK, 2026-10-11). */
const USER_AGENT = 'TripinlyPlaceImages/1.0 (tripinly@gmail.com)';
/** Both APIs take at most 50 ids or titles per request. */
export const WIKIMEDIA_BATCH = 50;
/** A standard Commons thumbnail width; other widths are refused since 2026. */
const THUMB_WIDTH = 1280;
const TIMEOUT_MS = 15_000;
/** Times a request is tried when Wikimedia says to slow down (429 or maxlag). */
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_S = 5;
const MAX_RETRY_AFTER_S = 120;
/** At most about one request a second (Wikimedia robot policy). */
const REQUEST_GAP_MS = 1_000;
const UPLOAD_HOST = 'upload.wikimedia.org';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface CommonsImage extends CommonsFileInfo {
  /** The resized copy to download (≤ 1280 px wide), from the API. */
  thumbUrl: string;
  sha1: string;
}

/**
 * Reads Wikidata main images (P18) and Commons file details, and downloads
 * Commons thumbnails. Requests go one at a time, about one a second; when
 * Wikimedia answers 429 or a maxlag error the client waits for Retry-After
 * and tries again. Use it from one job at a time.
 */
@Injectable()
export class WikimediaClient {
  private readonly logger = new Logger(WikimediaClient.name);
  private nextRequestAt = 0;

  /**
   * Each item's main image (P18) as a "File:…" title. Deprecated statements
   * are skipped and a preferred one wins. Items without one are left out.
   */
  async wikidataMainImages(qids: string[]): Promise<Map<string, string>> {
    assertBatch(qids);
    const result = new Map<string, string>();
    if (qids.length === 0) return result;
    const body = await this.get(WIKIDATA_API, {
      action: 'wbgetentities',
      ids: qids.join('|'),
      props: 'claims',
    });
    const entities = (body.entities ?? {}) as Record<string, WikidataEntity>;
    for (const [id, entity] of Object.entries(entities)) {
      const file = mainImage(entity.claims?.P18 ?? []);
      if (file) result.set(id, `File:${file}`);
    }
    return result;
  }

  /**
   * Details of Commons files by title. A title Commons doesn't have maps to
   * null (deleted or never existed); titles come back as given, even when
   * Commons normalizes them.
   */
  async commonsImages(
    titles: string[],
  ): Promise<Map<string, CommonsImage | null>> {
    assertBatch(titles);
    const result = new Map<string, CommonsImage | null>();
    if (titles.length === 0) return result;
    const body = await this.get(COMMONS_API, {
      action: 'query',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|sha1|extmetadata',
      iiurlwidth: String(THUMB_WIDTH),
      titles: titles.join('|'),
    });
    const query = (body.query ?? {}) as CommonsQuery;
    const asGiven = new Map<string, string>();
    for (const n of query.normalized ?? []) asGiven.set(n.to, n.from);
    for (const title of titles) result.set(title, null);
    for (const page of query.pages ?? []) {
      const title = asGiven.get(page.title) ?? page.title;
      if (!result.has(title)) continue;
      const info = page.imageinfo?.[0];
      result.set(
        title,
        page.missing || !info ? null : toImage(page.title, info),
      );
    }
    return result;
  }

  /**
   * A Commons thumbnail the imageinfo API returned. Only Wikimedia's upload
   * host is fetched, and files over 25 MB are refused.
   */
  async download(thumbUrl: string): Promise<Buffer> {
    const url = new URL(thumbUrl);
    if (url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST) {
      throw new WikimediaError('not a Commons upload URL');
    }
    const response = await this.send(url, 'image/*', DOWNLOAD_TIMEOUT_MS);
    if (!response.ok) throw new WikimediaError(`HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new WikimediaError('too large');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_DOWNLOAD_BYTES) throw new WikimediaError('too large');
    return body;
  }

  private async get(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({
      ...params,
      format: 'json',
      formatversion: '2',
      maxlag: '5',
    })) {
      url.searchParams.set(key, value);
    }
    for (let attempt = 1; ; attempt++) {
      const response = await this.send(url, 'application/json', TIMEOUT_MS);
      if (!response.ok) throw new WikimediaError(`HTTP ${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      const code = (body.error as { code?: string } | undefined)?.code;
      if (!body.error) return body;
      if (code !== 'maxlag') {
        throw new WikimediaError(`API error ${code ?? 'unknown'}`);
      }
      if (attempt >= MAX_ATTEMPTS) throw new WikimediaError('maxlag');
      await this.slowDown('maxlag', response);
    }
  }

  /**
   * One request at a time, at least REQUEST_GAP_MS apart (the robot policy),
   * tried again after Retry-After when Wikimedia answers 429.
   */
  private async send(
    url: URL,
    accept: string,
    timeoutMs: number,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextRequestAt = Date.now() + REQUEST_GAP_MS;
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 429) return response;
      if (attempt >= MAX_ATTEMPTS) throw new WikimediaError('HTTP 429');
      await this.slowDown('HTTP 429', response);
    }
  }

  private async slowDown(reason: string, response: Response): Promise<void> {
    const waitS = retryAfterSeconds(response.headers.get('retry-after'));
    this.logger.warn(
      `Wikimedia asked to slow down (${reason}); waiting ${waitS} s`,
    );
    await sleep(waitS * 1000);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WikimediaError extends Error {
  override name = 'WikimediaError';
}

interface WikidataStatement {
  rank?: 'preferred' | 'normal' | 'deprecated';
  mainsnak?: { snaktype?: string; datavalue?: { value?: unknown } };
}

interface WikidataEntity {
  claims?: Record<string, WikidataStatement[]>;
}

interface CommonsQuery {
  normalized?: { from: string; to: string }[];
  pages?: {
    title: string;
    missing?: boolean;
    imageinfo?: CommonsImageInfo[];
  }[];
}

interface CommonsImageInfo {
  thumburl?: string;
  url?: string;
  width?: number;
  height?: number;
  mime?: string;
  sha1?: string;
  extmetadata?: ExtMetadata;
}

function mainImage(statements: WikidataStatement[]): string | null {
  const usable = statements.filter(
    (s) =>
      s.rank !== 'deprecated' &&
      s.mainsnak?.snaktype === 'value' &&
      typeof s.mainsnak.datavalue?.value === 'string',
  );
  const best = usable.find((s) => s.rank === 'preferred') ?? usable[0];
  return best ? (best.mainsnak!.datavalue!.value as string) : null;
}

function toImage(title: string, info: CommonsImageInfo): CommonsImage | null {
  const thumbUrl = info.thumburl ?? info.url;
  if (!thumbUrl || !info.mime || !info.sha1) return null;
  return {
    title,
    mime: info.mime,
    width: info.width ?? 0,
    height: info.height ?? 0,
    extmetadata: info.extmetadata ?? {},
    thumbUrl,
    sha1: info.sha1,
  };
}

function assertBatch(items: string[]): void {
  if (items.length > WIKIMEDIA_BATCH) {
    throw new RangeError(`At most ${WIKIMEDIA_BATCH} per request`);
  }
}

/** Retry-After in seconds (HTTP allows seconds or a date), within limits. */
export function retryAfterSeconds(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_S;
  const seconds = /^\d+$/.test(header.trim())
    ? Number(header.trim())
    : (Date.parse(header) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(1, Math.ceil(seconds)));
}
