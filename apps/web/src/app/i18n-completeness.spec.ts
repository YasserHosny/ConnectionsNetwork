import { arCatalog, enCatalog } from '@connections/i18n';

function leafKeys(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix];
  return Object.entries(node).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n catalogues', () => {
  const en = leafKeys(enCatalog).sort();
  const ar = leafKeys(arCatalog).sort();

  it('have the same keys in en and ar', () => {
    expect(ar.filter((k) => !en.includes(k))).withContext('only in ar.json').toEqual([]);
    expect(en.filter((k) => !ar.includes(k))).withContext('only in en.json').toEqual([]);
  });

  it('have no empty strings', () => {
    const empty = (catalogue: unknown, keys: string[]) =>
      keys.filter((k) => {
        const value = k.split('.').reduce<unknown>((n, part) => (n as Record<string, unknown>)[part], catalogue);
        return typeof value !== 'string' || value.trim() === '';
      });

    expect(empty(enCatalog, en)).toEqual([]);
    expect(empty(arCatalog, ar)).toEqual([]);
  });
});
