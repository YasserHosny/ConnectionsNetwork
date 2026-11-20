import { isDevMode } from '@angular/core';
import {
  MissingTranslationHandler,
  type MissingTranslationHandlerParams,
} from '@ngx-translate/core';

/** A missing key is loud in development and falls back to the raw key in production. */
export class AppMissingTranslationHandler implements MissingTranslationHandler {
  handle(params: MissingTranslationHandlerParams): string {
    if (isDevMode()) {
      const lang = params.translateService.getCurrentLang() || 'unknown';
      console.error(`[i18n] missing translation: "${params.key}" in "${lang}"`);
      return `[MISSING: ${params.key}]`;
    }
    return params.key;
  }
}
