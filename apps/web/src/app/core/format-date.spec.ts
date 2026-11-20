import { formatDate } from './format-date';

describe('formatDate', () => {
  it('writes the date in the language asked for', () => {
    expect(formatDate('2026-11-20T10:00:00Z', 'en')).toBe('Nov 20, 2026');
    expect(formatDate('2026-11-20T10:00:00Z', 'ar')).toMatch(/2026|٢٠٢٦/);
  });

  it('gives nothing for a date it cannot read', () => {
    expect(formatDate('not a date', 'en')).toBe('');
  });
});
