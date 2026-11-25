import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

import { provideAppTranslations } from './translations';

describe('the app translations', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideAppTranslations()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  // A first visit on a flaky phone connection must not show raw keys: nothing is fetched.
  for (const [lang, appName] of [
    ['ar', 'شبكة المعارف'],
    ['en', 'Connections'],
  ] as const) {
    it(`has ${lang} without loading anything over the network`, async () => {
      const translate = TestBed.inject(TranslateService);

      await firstValueFrom(translate.use(lang));

      expect(translate.instant('common.appName')).toBe(appName);
      http.expectNone(() => true);
    });
  }
});
