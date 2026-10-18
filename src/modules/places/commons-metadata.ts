/**
 * Licence filter and credit builder for Wikimedia Commons files, from the
 * `extmetadata` that the imageinfo API returns (CommonsMetadata extension).
 * See docs/knowledge/10-maps-places-routing.md, "Place images".
 */

/** One `extmetadata` field: `{ value, source }`; only `value` is read. */
export type ExtMetadata = Record<string, { value?: unknown } | undefined>;

export interface CommonsFileInfo {
  /** "File:…" title. */
  title: string;
  mime: string;
  width: number;
  height: number;
  extmetadata: ExtMetadata;
}

/** Shorter images than this, on their longest edge, are too small to show. */
export const MIN_IMAGE_EDGE_PX = 640;

const ACCEPTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * CC0, public domain, and CC BY / CC BY-SA 1.0–4.0 including country ports
 * (`cc-by-sa-3.0-de`). Anything else (GFDL-only, NC, ND, unknown) is refused.
 */
const ACCEPTED_LICENSE =
  /^(cc0|pd|cc-by(-sa)?-(1\.0|2\.0|2\.5|3\.0|4\.0)(-[a-z]{2,})?)$/;

export type RejectReason =
  'mime' | 'tooSmall' | 'nonFree' | 'license' | 'restrictions' | 'deletion';

export interface AcceptedLicense {
  ok: true;
  /** Normalized licence code, such as `cc-by-sa-4.0` or `pd`. */
  license: string;
  licenseShortName: string;
  licenseUrl: string | null;
  attributionRequired: boolean;
  authorText: string | null;
  attributionText: string | null;
  objectName: string | null;
}

export type LicenseCheck =
  AcceptedLicense | { ok: false; reason: RejectReason };

/** Whether a Commons file may be shown, and the licence data its credit needs. */
export function checkCommonsFile(file: CommonsFileInfo): LicenseCheck {
  const meta = file.extmetadata;
  if (!ACCEPTED_MIMES.has(file.mime)) return { ok: false, reason: 'mime' };
  if (Math.max(file.width, file.height) < MIN_IMAGE_EDGE_PX) {
    return { ok: false, reason: 'tooSmall' };
  }
  if (field(meta, 'DeletionReason')) return { ok: false, reason: 'deletion' };
  if (isTrue(field(meta, 'NonFree'))) return { ok: false, reason: 'nonFree' };
  if (field(meta, 'Restrictions')) {
    return { ok: false, reason: 'restrictions' };
  }
  const license = field(meta, 'License')?.toLowerCase() ?? '';
  const licenseShortName = field(meta, 'LicenseShortName');
  if (!ACCEPTED_LICENSE.test(license) || !licenseShortName) {
    return { ok: false, reason: 'license' };
  }
  return {
    ok: true,
    license,
    licenseShortName,
    licenseUrl: field(meta, 'LicenseUrl'),
    // Commons leaves it out for most CC files; only an explicit "false" waives it.
    attributionRequired: field(meta, 'AttributionRequired') !== 'false',
    authorText: textOrNull(field(meta, 'Artist')),
    attributionText: textOrNull(field(meta, 'Attribution')),
    objectName: textOrNull(field(meta, 'ObjectName')),
  };
}

export interface CommonsCredit {
  /** Who to credit: the uploader's attribution wording, else the author. */
  author: string | null;
  /** The work's title; only licences before 4.0 require it. */
  title: string | null;
  /** Licence short name, such as "CC BY-SA 4.0" or "Public domain". */
  license: string;
  licenseUrl: string | null;
  /** The file page on Commons. */
  sourceUrl: string;
}

/**
 * The credit shown under a Commons image. CC 4.0 needs the creator and the
 * licence; older CC versions also need the title "if supplied" (3.0 §4(c)(ii),
 * 2.0 §4(c)); public domain needs none, but we still credit when we can.
 */
export function buildCredit(
  commonsTitle: string,
  license: Pick<
    AcceptedLicense,
    | 'license'
    | 'licenseShortName'
    | 'licenseUrl'
    | 'authorText'
    | 'attributionText'
    | 'objectName'
  >,
): CommonsCredit {
  const isPublicDomain = license.license === 'pd' || license.license === 'cc0';
  const needsTitle = !isPublicDomain && !license.license.includes('-4.0');
  return {
    author: license.attributionText ?? license.authorText,
    title: needsTitle
      ? (license.objectName ?? titleFromFileName(commonsTitle))
      : null,
    license:
      license.license === 'pd' ? 'Public domain' : license.licenseShortName,
    licenseUrl: license.licenseUrl,
    sourceUrl: filePageUrl(commonsTitle),
  };
}

/** The credit of a stored place image (see `buildCredit`). */
export function placeImageCredit(image: {
  commonsTitle: string;
  licenseCode: string | null;
  licenseShortName: string | null;
  licenseUrl: string | null;
  authorText: string | null;
  attributionText: string | null;
  objectName: string | null;
}): CommonsCredit {
  return buildCredit(image.commonsTitle, {
    license: image.licenseCode ?? '',
    licenseShortName: image.licenseShortName ?? '',
    licenseUrl: image.licenseUrl,
    authorText: image.authorText,
    attributionText: image.attributionText,
    objectName: image.objectName,
  });
}

/** "File:Stephansdom, Wien.jpg" → "Stephansdom, Wien". */
export function titleFromFileName(commonsTitle: string): string {
  return commonsTitle.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '');
}

export function filePageUrl(commonsTitle: string): string {
  const name = commonsTitle.replace(/ /g, '_');
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(name).replace(/%3A/g, ':')}`;
}

/**
 * The Commons title an OSM `wikimedia_commons` or `image` tag points to, or
 * null. `image` often holds other hosts' URLs, which we never use; a
 * `Category:` link names many files and is left out too.
 */
export function commonsTitleFromTag(value: string | undefined): string | null {
  if (!value) return null;
  const tag = value.split(';')[0].trim();
  let name: string | null = null;
  if (/^file:/i.test(tag)) {
    name = tag.slice('File:'.length);
  } else {
    const url = tag.match(
      /^https?:\/\/(?:commons|upload)\.wikimedia\.org\/(?:wiki\/File:([^?#]+)|wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+))/i,
    );
    const raw = url?.[1] ?? url?.[2];
    if (raw) {
      try {
        name = decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  if (!name) return null;
  name = name.replace(/_/g, ' ').trim();
  return name ? `File:${name}` : null;
}

/** Plain text from Commons' HTML fields: tags dropped, entities decoded, spaces collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith('#x'))
        return codePoint(parseInt(lower.slice(2), 16), entity);
      if (lower.startsWith('#'))
        return codePoint(parseInt(lower.slice(1), 10), entity);
      return NAMED_ENTITIES[lower] ?? entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function codePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

function field(meta: ExtMetadata, key: string): string | null {
  const value = meta[key]?.value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function textOrNull(html: string | null): string | null {
  if (!html) return null;
  const text = htmlToText(html);
  return text ? text : null;
}

function isTrue(value: string | null): boolean {
  return value !== null && value.toLowerCase() !== 'false' && value !== '0';
}
