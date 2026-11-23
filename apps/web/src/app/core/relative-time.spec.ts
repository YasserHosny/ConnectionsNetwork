import { relativeTime } from './relative-time';

const NOW = new Date('2026-11-20T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('relativeTime', () => {
  it('says today for the last day', () => {
    expect(relativeTime(ago(0), 'en', NOW)).toBe('today');
  });

  it('counts days under a month, months under a year, then years', () => {
    expect(relativeTime(ago(5), 'en', NOW)).toBe('5 days ago');
    expect(relativeTime(ago(95), 'en', NOW)).toBe('3 months ago');
    expect(relativeTime(ago(400), 'en', NOW)).toBe('last year');
    expect(relativeTime(ago(800), 'en', NOW)).toBe('2 years ago');
  });

  it('uses the language asked for', () => {
    expect(relativeTime(ago(95), 'ar', NOW)).toMatch(/أشهر|شهر/);
  });

  it('returns an empty string for a date it cannot read', () => {
    expect(relativeTime('not a date', 'en', NOW)).toBe('');
  });
});
