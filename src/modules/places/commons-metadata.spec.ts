import {
  buildCredit,
  checkCommonsFile,
  commonsTitleFromTag,
  filePageUrl,
  htmlToText,
  titleFromFileName,
  type CommonsFileInfo,
  type ExtMetadata,
} from './commons-metadata';

function file(
  meta: Record<string, string>,
  overrides: Partial<CommonsFileInfo> = {},
): CommonsFileInfo {
  const extmetadata: ExtMetadata = {};
  for (const [key, value] of Object.entries(meta)) {
    extmetadata[key] = { value };
  }
  return {
    title: 'File:Stephansdom, Wien.jpg',
    mime: 'image/jpeg',
    width: 2000,
    height: 1500,
    extmetadata,
    ...overrides,
  };
}

const CC_BY_SA_4 = {
  License: 'cc-by-sa-4.0',
  LicenseShortName: 'CC BY-SA 4.0',
  LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  Artist:
    '<a href="//commons.wikimedia.org/wiki/User:Jane" title="User:Jane">Jane&nbsp;Doe</a>',
};

describe('checkCommonsFile', () => {
  it.each([
    ['cc0', 'CC0'],
    ['pd', 'Public domain'],
    ['cc-by-1.0', 'CC BY 1.0'],
    ['cc-by-sa-2.5', 'CC BY-SA 2.5'],
    ['cc-by-sa-3.0-de', 'CC BY-SA 3.0 de'],
    ['cc-by-4.0', 'CC BY 4.0'],
    ['CC-BY-SA-4.0', 'CC BY-SA 4.0'],
  ])('accepts %s', (license, shortName) => {
    const result = checkCommonsFile(
      file({ License: license, LicenseShortName: shortName }),
    );
    expect(result).toMatchObject({ ok: true, license: license.toLowerCase() });
  });

  it.each([
    ['gfdl'],
    ['cc-by-nc-4.0'],
    ['cc-by-nd-4.0'],
    ['cc-by-sa-4.0-or-gfdl'],
    [''],
  ])('refuses the licence %j', (license) => {
    expect(
      checkCommonsFile(file({ License: license, LicenseShortName: 'X' })),
    ).toEqual({ ok: false, reason: 'license' });
  });

  it('refuses a file without a licence short name', () => {
    expect(checkCommonsFile(file({ License: 'cc0' }))).toEqual({
      ok: false,
      reason: 'license',
    });
  });

  it('refuses non-free files, files with restrictions and files up for deletion', () => {
    expect(checkCommonsFile(file({ ...CC_BY_SA_4, NonFree: 'true' }))).toEqual({
      ok: false,
      reason: 'nonFree',
    });
    expect(
      checkCommonsFile(file({ ...CC_BY_SA_4, Restrictions: 'trademarked' })),
    ).toEqual({ ok: false, reason: 'restrictions' });
    expect(
      checkCommonsFile(
        file({ ...CC_BY_SA_4, DeletionReason: 'Copyright violation' }),
      ),
    ).toEqual({ ok: false, reason: 'deletion' });
  });

  it('keeps a file whose NonFree field says false', () => {
    expect(checkCommonsFile(file({ ...CC_BY_SA_4, NonFree: 'false' })).ok).toBe(
      true,
    );
  });

  it.each([['image/svg+xml'], ['image/tiff'], ['image/gif']])(
    'refuses %s',
    (mime) => {
      expect(checkCommonsFile(file(CC_BY_SA_4, { mime }))).toEqual({
        ok: false,
        reason: 'mime',
      });
    },
  );

  it('refuses images under 640 px on their longest edge', () => {
    expect(
      checkCommonsFile(file(CC_BY_SA_4, { width: 639, height: 400 })),
    ).toEqual({ ok: false, reason: 'tooSmall' });
    expect(
      checkCommonsFile(file(CC_BY_SA_4, { width: 400, height: 640 })).ok,
    ).toBe(true);
  });

  it('reads the author as text and attribution as required unless waived', () => {
    const result = checkCommonsFile(file(CC_BY_SA_4));
    expect(result).toMatchObject({
      ok: true,
      authorText: 'Jane Doe',
      attributionText: null,
      attributionRequired: true,
    });
    expect(
      checkCommonsFile(
        file({
          License: 'cc0',
          LicenseShortName: 'CC0',
          AttributionRequired: 'false',
        }),
      ),
    ).toMatchObject({ ok: true, attributionRequired: false });
  });
});

describe('buildCredit', () => {
  function credit(
    meta: Record<string, string>,
    title = 'File:Stephansdom, Wien.jpg',
  ) {
    const result = checkCommonsFile(file(meta, { title }));
    if (!result.ok) throw new Error(result.reason);
    return buildCredit(title, result);
  }

  it('credits a 4.0 file with author and licence, without a title', () => {
    expect(credit(CC_BY_SA_4)).toEqual({
      author: 'Jane Doe',
      title: null,
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      sourceUrl:
        'https://commons.wikimedia.org/wiki/File:Stephansdom%2C_Wien.jpg',
    });
  });

  it("uses the uploader's attribution wording over the author", () => {
    expect(
      credit({
        ...CC_BY_SA_4,
        Attribution: 'Photo: <b>J. Doe</b> / Wien Museum',
      }).author,
    ).toBe('Photo: J. Doe / Wien Museum');
  });

  it('adds the title for licences before 4.0, from ObjectName or the file name', () => {
    const v3 = {
      License: 'cc-by-sa-3.0-at',
      LicenseShortName: 'CC BY-SA 3.0 at',
      Artist: 'Jane',
    };
    expect(
      credit({ ...v3, ObjectName: 'St. Stephen&#39;s Cathedral' }).title,
    ).toBe("St. Stephen's Cathedral");
    expect(credit(v3).title).toBe('Stephansdom, Wien');
  });

  it('labels public domain files and gives them no title', () => {
    expect(
      credit({
        License: 'pd',
        LicenseShortName: 'Public domain',
        Artist: 'Rudolf von Alt',
      }),
    ).toMatchObject({
      author: 'Rudolf von Alt',
      title: null,
      license: 'Public domain',
    });
  });
});

describe('commonsTitleFromTag', () => {
  it.each([
    ['File:Stephansdom.jpg', 'File:Stephansdom.jpg'],
    ['file:Some_File_name.JPG', 'File:Some File name.JPG'],
    ['File:A.jpg;File:B.jpg', 'File:A.jpg'],
    [
      'https://commons.wikimedia.org/wiki/File:Wien_-_Stephansdom_(1).jpg',
      'File:Wien - Stephansdom (1).jpg',
    ],
    [
      'https://commons.wikimedia.org/wiki/File:Schloss%20Sch%C3%B6nbrunn.jpg?uselang=de',
      'File:Schloss Schönbrunn.jpg',
    ],
    [
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Belvedere_Wien.jpg',
      'File:Belvedere Wien.jpg',
    ],
    [
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Belvedere_Wien.jpg/800px-Belvedere_Wien.jpg',
      'File:Belvedere Wien.jpg',
    ],
  ])('reads %j', (tag, title) => {
    expect(commonsTitleFromTag(tag)).toBe(title);
  });

  it.each([
    [undefined],
    [''],
    ['Category:Stephansdom'],
    ['https://example.com/photo.jpg'],
    ['https://www.flickr.com/photos/x/1'],
    ['https://commons.wikimedia.org/wiki/File:%E0%A4%A'],
  ])('ignores %j', (tag) => {
    expect(commonsTitleFromTag(tag)).toBeNull();
  });
});

describe('helpers', () => {
  it('strips HTML and decodes entities', () => {
    expect(
      htmlToText('<span>A &amp; B</span>\n<i>&#x263A;&#9731;&bogus;</i>'),
    ).toBe('A & B ☺☃&bogus;');
  });

  it('turns a file title into a work title', () => {
    expect(titleFromFileName('File:Karlskirche Wien.jpeg')).toBe(
      'Karlskirche Wien',
    );
  });

  it('builds the file page URL', () => {
    expect(filePageUrl('File:Café Central, Wien.jpg')).toBe(
      'https://commons.wikimedia.org/wiki/File:Caf%C3%A9_Central%2C_Wien.jpg',
    );
  });
});
