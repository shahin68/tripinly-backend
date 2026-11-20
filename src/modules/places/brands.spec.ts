import type { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import type { Env } from '../../common/config/env';
import type { CommonsFileInfo, ExtMetadata } from './commons-metadata';
import {
  BRAND_LOGO_SIZE,
  BrandPolicy,
  brandLogoPath,
  isUsableLogo,
  renderBrandLogo,
} from './brands';

function policy(enabled: boolean, hidden: string[] = []): BrandPolicy {
  const values = { BRAND_LOGOS_ENABLED: enabled, BRAND_LOGOS_HIDDEN: hidden };
  const config = {
    get: (key: keyof typeof values) => values[key],
  } as unknown as ConfigService<Env, true>;
  return new BrandPolicy(config);
}

const ZARA = {
  id: '0b5e2c4a-1111-4222-8333-944455556666',
  name: 'Zara',
  wikidataId: 'Q147662',
  logoHash: '3f2a9c01d4e5b6a7',
};

describe('BrandPolicy', () => {
  it('shows the logo only while logos are on', () => {
    expect(policy(true).present(ZARA)).toEqual({
      id: ZARA.id,
      name: 'Zara',
      logoUrl: brandLogoPath(ZARA.id, ZARA.logoHash),
    });
    expect(policy(false).present(ZARA)?.logoUrl).toBeNull();
  });

  it.each([['zara'], ['q147662']])(
    'hides a brand listed by name or Wikidata id (%s)',
    (entry) => {
      const brand = policy(true, [entry]).present(ZARA);
      expect(brand).toMatchObject({ name: 'Zara', logoUrl: null });
    },
  );

  it('is on only with BRAND_LOGOS_ENABLED', () => {
    expect(policy(true).isOn()).toBe(true);
    expect(policy(false).isOn()).toBe(false);
  });

  it('keeps the name of a brand without a logo, and no brand stays null', () => {
    expect(
      policy(true).present({ ...ZARA, logoHash: null })?.logoUrl,
    ).toBeNull();
    expect(policy(true).present(null)).toBeNull();
  });
});

function file(
  meta: Record<string, string>,
  mime = 'image/svg+xml',
): CommonsFileInfo {
  const extmetadata: ExtMetadata = {};
  for (const [key, value] of Object.entries(meta)) extmetadata[key] = { value };
  return {
    title: 'File:Zara Logo.svg',
    mime,
    width: 800,
    height: 300,
    extmetadata,
  };
}

describe('isUsableLogo', () => {
  it.each([
    [{ License: 'pd' }, true],
    [{ License: 'cc0' }, true],
    [{ License: 'pd', Restrictions: 'trademarked' }, true],
    [{ License: 'cc-by-sa-4.0' }, false],
    [{ License: 'pd', Restrictions: 'trademarked|personality' }, false],
    [{ License: 'pd', NonFree: 'true' }, false],
    [{ License: 'pd', DeletionReason: 'copyvio' }, false],
    [{}, false],
  ])('%j → %s', (meta, usable) => {
    expect(isUsableLogo(file(meta))).toBe(usable);
  });

  it('refuses files that are not images', () => {
    expect(isUsableLogo(file({ License: 'pd' }, 'application/pdf'))).toBe(
      false,
    );
  });
});

describe('renderBrandLogo', () => {
  const svg = (body: string, width = 600, height = 200) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`,
    );

  it('makes a small square WebP of the logo itself', async () => {
    const result = await renderBrandLogo(
      svg('<rect x="100" y="50" width="400" height="100" fill="#000"/>'),
    );
    expect(result).not.toBeNull();
    const meta = await sharp(result!.logo).metadata();
    expect(meta).toMatchObject({
      format: 'webp',
      width: BRAND_LOGO_SIZE,
      height: BRAND_LOGO_SIZE,
    });
    expect(result!.logo.length).toBeLessThan(8 * 1024);
    expect(result!.hash).toMatch(/^[0-9a-f]{16}$/);
    // Cut to the logo: a wide logo fills the width, white above and below.
    const { data, info } = await sharp(result!.logo)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) =>
      data[(y * info.width + x) * info.channels];
    expect(at(2, BRAND_LOGO_SIZE / 2)).toBeLessThan(60);
    expect(at(BRAND_LOGO_SIZE / 2, 2)).toBeGreaterThan(200);
  });

  it('gives the same hash for the same logo', async () => {
    const input = svg('<circle cx="300" cy="100" r="80" fill="#c00"/>');
    const [a, b] = await Promise.all([
      renderBrandLogo(input),
      renderBrandLogo(input),
    ]);
    expect(a!.hash).toBe(b!.hash);
  });

  it('drops a white logo that would vanish on the white pin', async () => {
    expect(
      await renderBrandLogo(
        svg('<rect x="100" y="50" width="400" height="100" fill="#fff"/>'),
      ),
    ).toBeNull();
  });

  it('fails on bytes that are not an image', async () => {
    await expect(
      renderBrandLogo(Buffer.from('not an image')),
    ).rejects.toThrow();
  });
});
