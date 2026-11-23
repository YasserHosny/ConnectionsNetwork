export type SupportedLocale = 'ar' | 'en';

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['ar', 'en'] as const;

/** Arabic is the default for a first visit; English is the other supported language. */
export const DEFAULT_LOCALE: SupportedLocale = 'ar';

export const RTL_LOCALES: readonly SupportedLocale[] = ['ar'] as const;

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isRtlLocale(locale: SupportedLocale): boolean {
  return RTL_LOCALES.includes(locale);
}

export { default as enCatalog } from './en.json';
export { default as arCatalog } from './ar.json';
