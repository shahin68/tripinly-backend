/** Lowercase, diacritics removed, whitespace collapsed ("  Café  Sacher " → "cafe sacher"). */
export function normalizePlaceName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
