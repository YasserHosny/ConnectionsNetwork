import { Injectable, type Provider } from '@angular/core';
import {
  MissingTranslationHandler,
  type TranslationObject,
  TranslateLoader,
  provideTranslateService,
} from '@ngx-translate/core';
import { arCatalog, enCatalog } from '@connections/i18n';
import { type Observable, of } from 'rxjs';

import { AppMissingTranslationHandler } from './missing-translation.handler';

const CATALOGUES: Readonly<Record<string, TranslationObject>> = { ar: arCatalog, en: enCatalog };

/**
 * Both catalogues ship inside the bundle (about 5 KB each, gzipped). Fetching them at runtime
 * left a first visit on a flaky connection (a contributor opening their link on mobile data) with
 * raw keys on every label and no retry.
 */
@Injectable()
export class BundledTranslateLoader implements TranslateLoader {
  getTranslation(lang: string): Observable<TranslationObject> {
    return of(CATALOGUES[lang] ?? {});
  }
}

/** The translation service as the app runs it. */
export function provideAppTranslations(): Provider[] {
  return provideTranslateService({
    fallbackLang: 'en',
    loader: { provide: TranslateLoader, useClass: BundledTranslateLoader },
    // An explicit useClass provider: provideMissingTranslationHandler(Class) misdetects a
    // minified class and crashed production bootstrap in ProcurePilot.
    missingTranslationHandler: {
      provide: MissingTranslationHandler,
      useClass: AppMissingTranslationHandler,
    },
  });
}
