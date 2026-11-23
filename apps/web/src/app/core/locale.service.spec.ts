import { Directionality } from '@angular/cdk/bidi';
import { TestBed } from '@angular/core/testing';
import {
  TranslateLoader,
  TranslateService,
  provideTranslateLoader,
  provideTranslateService,
} from '@ngx-translate/core';
import { throwError } from 'rxjs';

import { LOCALE_STORAGE_KEY, LocaleService } from './locale.service';

describe('LocaleService', () => {
  const html = document.documentElement;

  function createService(): LocaleService {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    return TestBed.inject(LocaleService);
  }

  beforeEach(() => {
    localStorage.clear();
    html.removeAttribute('dir');
    html.removeAttribute('lang');
  });

  afterEach(() => {
    localStorage.clear();
    html.removeAttribute('dir');
    html.removeAttribute('lang');
  });

  it('defaults to ar and sets dir=rtl', () => {
    const service = createService();

    expect(service.locale()).toBe('ar');
    expect(service.isRtl()).toBeTrue();
    expect(html.getAttribute('lang')).toBe('ar');
    expect(html.getAttribute('dir')).toBe('rtl');
    expect(TestBed.inject(TranslateService).getCurrentLang()).toBe('ar');
    expect(TestBed.inject(Directionality).value).toBe('rtl');
  });

  it('switching to en sets dir=ltr and persists', () => {
    const service = createService();

    service.setLocale('en');

    expect(service.locale()).toBe('en');
    expect(service.isRtl()).toBeFalse();
    expect(html.getAttribute('lang')).toBe('en');
    expect(html.getAttribute('dir')).toBe('ltr');
    expect(TestBed.inject(Directionality).value).toBe('ltr');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('restores the persisted choice on the next start', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');

    const service = createService();

    expect(service.locale()).toBe('en');
    expect(html.getAttribute('dir')).toBe('ltr');
  });

  it('ignores a stored value that is not a supported language', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');

    expect(createService().locale()).toBe('ar');
  });

  it('localStorage throwing does not break setLocale', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('storage blocked');
    spyOn(Storage.prototype, 'setItem').and.throwError('storage blocked');

    const service = createService();
    expect(service.locale()).toBe('ar');

    expect(() => service.setLocale('en')).not.toThrow();
    expect(service.locale()).toBe('en');
    expect(html.getAttribute('dir')).toBe('ltr');
  });

  it('ready() resolves, and logs, when the catalogue cannot be loaded', async () => {
    const logged = spyOn(console, 'error');
    spyOn(console, 'warn'); // ngx-translate also warns about the fallback catalogue
    class FailingLoader implements TranslateLoader {
      getTranslation() {
        return throwError(() => new Error('404'));
      }
    }
    TestBed.configureTestingModule({
      providers: [provideTranslateService({ loader: provideTranslateLoader(FailingLoader) })],
    });

    await expectAsync(TestBed.inject(LocaleService).ready()).toBeResolved();
    expect(logged).toHaveBeenCalled();
  });
});
