import type { SupportedLocale } from '@connections/i18n';

/** A timestamp as a date in the app language ("20 Nov 2026"); '' when it cannot be read. */
export function formatDate(iso: string, locale: SupportedLocale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}
