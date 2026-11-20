import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { REVIEW_ROUTES } from './review.routes';

describe('Review page', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const tab = (name: string) => el().querySelector(`nav a.tab-${name}`) as HTMLAnchorElement;

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'review', children: REVIEW_ROUTES }]),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: AuthService, useValue: fakeAuthService(fakeSession('aal2')) },
      ],
    });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('opens on the duplicates list', async () => {
    await harness.navigateByUrl('/review');
    http.expectOne('/api/v1/duplicates').flush([]);
    await settle();

    expect(router.url).toBe('/review/duplicates');
    expect(el().querySelector('h1')?.textContent).toContain('Review');
    expect(tab('duplicates').getAttribute('aria-current')).toBe('page');
    expect(tab('stale').getAttribute('aria-current')).toBeNull();
  });

  it('has a section for each list, each loading only when opened', async () => {
    await harness.navigateByUrl('/review');
    http.expectOne('/api/v1/duplicates').flush([]);
    await settle();
    expect(Array.from(el().querySelectorAll('nav a')).map((a) => a.textContent?.trim())).toEqual([
      'Possible duplicates',
      'Needs confirming',
      'Not connected to you',
    ]);

    tab('stale').click();
    await settle();
    http.expectOne('/api/v1/review/stale').flush([]);
    await settle();
    expect(router.url).toBe('/review/stale');
    expect(tab('stale').getAttribute('aria-current')).toBe('page');

    tab('unreachable').click();
    await settle();
    http.expectOne('/api/v1/review/unreachable').flush([]);
    await settle();
    expect(router.url).toBe('/review/unreachable');
  });
});
