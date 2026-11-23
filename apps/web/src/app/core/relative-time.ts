import type { SupportedLocale } from '@connections/i18n';

const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

/**
 * How long ago a timestamp was, in the given language ("3 months ago", "قبل 3 أشهر"): days under a
 * month, months under a year, then years. A date that cannot be read gives ''.
 */
export function relativeTime(iso: string, locale: SupportedLocale, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.max(0, Math.floor((now.getTime() - then) / DAY_MS));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (days < DAYS_PER_MONTH) return format.format(-days, 'day');
  if (days < DAYS_PER_YEAR) return format.format(-Math.floor(days / DAYS_PER_MONTH), 'month');
  return format.format(-Math.floor(days / DAYS_PER_YEAR), 'year');
}
