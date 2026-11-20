import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import type { ReviewPerson } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues, waitFor } from '../../testing/test-helpers';
import { StalePage } from './stale.page';

const PEOPLE: ReviewPerson[] = [
  { person_id: 's-1', display_name: 'Karim Adel', profession: 'Engineer', city: 'Cairo', last_confirmed_at: '2025-01-10T10:00:00Z' },
  { person_id: 's-2', display_name: 'Mona Said', profession: null, city: null, last_confirmed_at: '2025-03-02T10:00:00Z' },
];
const SECRET_URL = 'https://app.example.com/c#STALE-SECRET';

describe('StalePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const rows = () => Array.from(el().querySelectorAll('li.person'));
  const dialog = () => document.querySelector('mat-dialog-container');

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  async function open(people: ReviewPerson[] = PEOPLE): Promise<void> {
    await harness.navigateByUrl('/review/stale', StalePage);
    fixture().detectChanges();
    http.expectOne('/api/v1/review/stale').flush(people);
    await settle();
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'review/stale', component: StalePage },
          { path: 'mfa', children: [] },
        ]),
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

  it('lists who has not been confirmed, with a link to each person and to editing them', async () => {
    await open();

    expect(rows().length).toBe(2);
    expect(rows()[0].textContent).toContain('Karim Adel');
    expect(rows()[0].textContent).toContain('Engineer');
    expect(rows()[0].textContent).toContain('Last confirmed');
    expect(rows()[0].querySelector('a.name')?.getAttribute('href')).toBe('/people/s-1');
    expect(rows()[0].querySelector('a.edit')?.getAttribute('href')).toBe('/people/s-1/edit');
  });

  it('says so when everyone is up to date', async () => {
    await open([]);

    expect(el().querySelector('.empty')?.textContent).toContain('Everyone is up to date');
  });

  it('confirms a person and takes them off the list', async () => {
    await open();

    (rows()[0].querySelector('button.confirm') as HTMLButtonElement).click();
    const req = http.expectOne('/api/v1/people/s-1/confirm');
    expect(req.request.method).toBe('POST');
    req.flush({ id: 's-1' });
    await settle();

    expect(rows().length).toBe(1);
    expect(rows()[0].textContent).toContain('Mona Said');
    expect(el().querySelector('.status')?.textContent).toContain('Confirmed Karim Adel');
  });

  it('creates an update link for that person and offers it on WhatsApp and to copy, in a dialog', async () => {
    await open();

    (rows()[0].querySelector('button.send-link') as HTMLButtonElement).click();
    const req = http.expectOne('/api/v1/links');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ person_id: 's-1' });
    req.flush({ link_id: 'l-1', url: SECRET_URL, expires_at: '2026-12-20T10:00:00Z' });
    await settle();

    await waitFor(fixture(), () => dialog());
    expect(dialog()?.textContent).toContain('Link for Karim Adel');
    expect((dialog()?.querySelector('input.link-url') as HTMLInputElement).value).toBe(SECRET_URL);
    const share = dialog()?.querySelector('a.share-whatsapp') as HTMLAnchorElement;
    expect(share.href.startsWith('https://wa.me/?text=')).toBeTrue();
    expect(decodeURIComponent(share.href.split('?text=')[1])).toContain(SECRET_URL);
    expect(share.target).toBe('_blank');
    expect(share.rel).toContain('noopener');

    const write = spyOn(navigator.clipboard, 'writeText').and.resolveTo();
    (dialog()?.querySelector('button.copy-link') as HTMLButtonElement).click();
    const status = await waitFor(fixture(), () => dialog()?.querySelector('.copy-status')?.textContent);
    expect(write).toHaveBeenCalledOnceWith(SECRET_URL);
    expect(status).toContain('Link copied');

    // The person stays on the list: sending a link does not confirm them.
    expect(rows().length).toBe(2);
  });

  it('shows a translated message, not the API text, when the link cannot be created', async () => {
    await open();

    (rows()[1].querySelector('button.send-link') as HTMLButtonElement).click();
    http.expectOne('/api/v1/links').flush(
      { code: 'internal_error', message: 'English API text', details: null, trace_id: 't' },
      { status: 500, statusText: 'Server Error' },
    );
    await settle();

    const text = el().querySelector('.error')?.textContent ?? '';
    expect(text).toContain('Could not reach the server');
    expect(text).not.toContain('English API text');
    expect(dialog()).toBeNull();
  });

  it('sends the admin to /mfa when the second step has lapsed', async () => {
    await open();

    (rows()[0].querySelector('button.confirm') as HTMLButtonElement).click();
    http.expectOne('/api/v1/people/s-1/confirm').flush(
      { code: 'mfa_required', message: 'x', details: null, trace_id: 't' },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();

    expect(router.url).toBe('/mfa');
  });

  it('offers a retry when the list cannot be loaded', async () => {
    await harness.navigateByUrl('/review/stale', StalePage);
    fixture().detectChanges();
    http.expectOne('/api/v1/review/stale').error(new ProgressEvent('error'));
    await settle();

    expect(el().querySelector('.load-error')).not.toBeNull();
    (el().querySelector('button.retry') as HTMLButtonElement).click();
    http.expectOne('/api/v1/review/stale').flush(PEOPLE);
    await settle();

    expect(rows().length).toBe(2);
  });
});
