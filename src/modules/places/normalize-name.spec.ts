import { normalizePlaceName } from './normalize-name';

describe('normalizePlaceName', () => {
  it('folds case, diacritics and whitespace', () => {
    expect(normalizePlaceName('  Café   Sacher ')).toBe('cafe sacher');
    expect(normalizePlaceName('Szépművészeti Múzeum')).toBe(
      'szepmuveszeti muzeum',
    );
    expect(normalizePlaceName('Stephansdom\tWien')).toBe('stephansdom wien');
  });
});
