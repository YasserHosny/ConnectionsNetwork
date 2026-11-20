import { Direction, Directionality } from '@angular/cdk/bidi';
import { DOCUMENT, Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  isRtlLocale,
  isSupportedLocale,
} from '@connections/i18n';
import { firstValueFrom } from 'rxjs';

export const LOCALE_STORAGE_KEY = 'connections.locale';

/**
 * The app language: Arabic by default, English on request, remembered on this device.
 *
 * Setting a language also sets `<html lang dir>` (rtl for Arabic) and the CDK's Directionality,
 * so Material overlays and menus mirror with the page.
 */
@Injectable({ providedIn: 'root' })
export class LocaleService {
  private readonly translate = inject(TranslateService);
  private readonly document = inject(DOCUMENT);
  private readonly directionality = inject(Directionality);

  private readonly current = signal<SupportedLocale>(DEFAULT_LOCALE);

  readonly locale = this.current.asReadonly();
  readonly isRtl = computed(() => isRtlLocale(this.current()));

  constructor() {
    this.translate.addLangs([...SUPPORTED_LOCALES]);
    this.translate.setFallbackLang('en');
    this.apply(this.readStored() ?? DEFAULT_LOCALE);
  }

  setLocale(locale: SupportedLocale): void {
    this.apply(locale);
    this.persist(locale);
  }

  /**
   * Resolves once the current language's catalogue has loaded, so the first paint has text. A
   * catalogue that fails to load is logged and the app starts anyway (showing raw keys) rather
   * than staying blank.
   */
  async ready(): Promise<void> {
    try {
      await firstValueFrom(this.translate.use(this.current()));
    } catch (error) {
      console.error('[i18n] the language catalogue could not be loaded', error);
    }
  }

  private apply(locale: SupportedLocale): void {
    this.current.set(locale);
    this.translate.use(locale);

    const dir: Direction = isRtlLocale(locale) ? 'rtl' : 'ltr';
    const root = this.document.documentElement;
    root.setAttribute('lang', locale);
    root.setAttribute('dir', dir);

    if (this.directionality.value !== dir) {
      this.directionality.valueSignal.set(dir);
      this.directionality.change.emit(dir);
    }
  }

  /** Storage can throw (private mode, blocked site data): the choice then lasts for the session. */
  private readStored(): SupportedLocale | null {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      return isSupportedLocale(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  private persist(locale: SupportedLocale): void {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Not persisted; see readStored.
    }
  }
}
