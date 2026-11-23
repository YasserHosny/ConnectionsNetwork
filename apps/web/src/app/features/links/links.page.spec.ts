import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import type { LinkOut } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { PersonPickerComponent } from '../people/person-picker.component';
import { fakeAuthService, fakeSession, loadCatalogues, waitFor } from '../../testing/test-helpers';
import { LinksPage } from './links.page';

const DAY_MS = 86_400_000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

const ACTIVE: LinkOut = { link_id: 'l-1', person_id: 'p-1', display_name: 'Karim Adel', expires_at: daysFromNow(10), revoked_at: null, people_added: 3 };
const EXPIRED: LinkOut = { link_id: 'l-2', person_id: 'p-2', display_name: 'Mona Said', expires_at: daysFromNow(-5), revoked_at: null, people_added: 0 };
const REVOKED: LinkOut = { link_id: 'l-3', person_id: 'p-3', display_name: 'Omar Ali', expires_at: daysFromNow(20), revoked_at: daysFromNow(-1), people_added: 7 };

const SECRET_URL = 'https://app.example.com/c#LINK-SECRET-TOKEN';
const issued = (url = SECRET_URL) => ({ link_id: 'l-9', url, expires_at: daysFromNow(30) });

describe('LinksPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const rows = () => Array.from(el().querySelectorAll('li.link'));
  const row = (id: string) => el().querySelector(`li.link[data-link-id="${id}"]`) as HTMLElement;
  const dialog = () => document.querySelector('mat-dialog-container');
  const dialogButton = (cls: string) => dialog()?.querySelector(`button.${cls}`) as HTMLButtonElement | null;

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  async function open(links: LinkOut[] = [ACTIVE, EXPIRED, REVOKED]): Promise<void> {
    await harness.navigateByUrl('/links', LinksPage);
    fixture().detectChanges();
    http.expectOne('/api/v1/links').flush(links);
    await settle();
  }

  function choosePerson(id: string, name: string): void {
    const picker = fixture().debugElement.query(By.directive(PersonPickerComponent));
    (picker.componentInstance as PersonPickerComponent).value.set({ id, name });
    fixture().detectChanges();
  }

  /** Every place the URL could have been left: the page text, form values, storage, the address. */
  function whereIsTheUrl(secret: string): string[] {
    const found: string[] = [];
    if ((document.body.textContent ?? '').includes(secret)) found.push('page text');
    for (const input of Array.from(document.querySelectorAll('input, textarea'))) {
      if ((input as HTMLInputElement).value.includes(secret)) found.push('form value');
    }
    for (const a of Array.from(document.querySelectorAll('a'))) {
      if (decodeURIComponent(a.href).includes(secret)) found.push('link href');
    }
    const stored = (storage: Storage) =>
      Object.keys(storage).some((k) => k.includes(secret) || (storage.getItem(k) ?? '').includes(secret));
    if (stored(localStorage)) found.push('localStorage');
    if (stored(sessionStorage)) found.push('sessionStorage');
    if (router.url.includes(secret)) found.push('router url');
    return found;
  }

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'links', component: LinksPage },
          { path: 'search', children: [] },
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
    sessionStorage.clear();
  });

  it('lists each link with its status and how many people it added', async () => {
    await open();

    expect(rows().length).toBe(3);
    expect(row('l-1').querySelector('.status')?.textContent).toContain('Active');
    expect(row('l-1').textContent).toContain('Karim Adel');
    expect(row('l-1').textContent).toContain('People added: 3');
    expect(row('l-2').querySelector('.status')?.textContent).toContain('Expired');
    expect(row('l-3').querySelector('.status')?.textContent).toContain('Revoked');
    expect(row('l-3').textContent).toContain('People added: 7');
    expect(row('l-1').querySelector('a.name')?.getAttribute('href')).toBe('/people/p-1');
  });

  it('says so when there are no links yet', async () => {
    await open([]);

    expect(el().querySelector('.empty')?.textContent).toContain('No links yet');
  });

  it('expired link shows renew action', async () => {
    await open();

    expect(row('l-2').querySelector('button.renew')).not.toBeNull();
    expect(row('l-1').querySelector('button.renew')).not.toBeNull();
    // A revoked link cannot come back: the API refuses to renew it.
    expect(row('l-3').querySelector('button.renew')).toBeNull();
    expect(row('l-3').querySelector('button.revoke')).toBeNull();
  });

  it('link url shown once and not re-fetchable after navigation', async () => {
    await open([]);
    choosePerson('p-9', 'Layla Hassan');

    (el().querySelector('button.create') as HTMLButtonElement).click();
    const create = http.expectOne('/api/v1/links');
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toEqual({ person_id: 'p-9' });
    create.flush(issued());
    await settle();

    // Shown once, in the dialog, with copy and WhatsApp share.
    await waitFor(fixture(), () => dialog());
    expect((dialog()?.querySelector('input.link-url') as HTMLInputElement).value).toBe(SECRET_URL);
    expect(dialog()?.querySelector('button.copy-link')).not.toBeNull();
    expect((dialog()?.querySelector('a.share-whatsapp') as HTMLAnchorElement).href).toContain('https://wa.me/?text=');
    expect(dialog()?.textContent).toContain('shown only once');
    expect(dialog()?.textContent).toContain('Link for \u2068Layla Hassan\u2069');

    // Shown only once, so neither Escape nor a click beside it may close it: only Done.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    (document.querySelector('.cdk-overlay-backdrop') as HTMLElement | null)?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fixture().detectChanges();
    expect(dialog()).not.toBeNull();

    // The list is refreshed from the API, which never returns the URL.
    http.expectOne('/api/v1/links').flush([{ ...ACTIVE, link_id: 'l-9', person_id: 'p-9', display_name: 'Layla Hassan', people_added: 0 }]);
    await settle();

    (dialogButton('dialog-done') as HTMLButtonElement).click();
    await waitFor(fixture(), () => !dialog());
    expect(whereIsTheUrl(SECRET_URL)).toEqual([]);

    // Away and back: a fresh page asks the API for the list and has no way to show the URL again.
    await router.navigateByUrl('/search');
    await harness.navigateByUrl('/links', LinksPage);
    fixture().detectChanges();
    http.expectOne('/api/v1/links').flush([{ ...ACTIVE, link_id: 'l-9', person_id: 'p-9', display_name: 'Layla Hassan', people_added: 0 }]);
    await settle();

    expect(rows().length).toBe(1);
    expect(whereIsTheUrl(SECRET_URL)).toEqual([]);
    http.expectNone((r) => r.method === 'POST');
  });

  it('keeps the create button off until someone is chosen', async () => {
    await open([]);
    const button = () => el().querySelector('button.create') as HTMLButtonElement;

    expect(button().disabled).toBeTrue();
    choosePerson('p-9', 'Layla Hassan');

    expect(button().disabled).toBeFalse();
  });

  it('offers copy, and says when the browser refused', async () => {
    await open([]);
    choosePerson('p-9', 'Layla Hassan');
    (el().querySelector('button.create') as HTMLButtonElement).click();
    http.expectOne('/api/v1/links').flush(issued());
    await settle();
    http.expectOne('/api/v1/links').flush([]);
    await waitFor(fixture(), () => dialog());

    const write = spyOn(navigator.clipboard, 'writeText').and.rejectWith(new Error('denied'));
    dialogButton('copy-link')?.click();
    const status = await waitFor(fixture(), () => dialog()?.querySelector('.copy-status')?.textContent);

    expect(write).toHaveBeenCalledOnceWith(SECRET_URL);
    expect(status).toContain('Could not copy automatically');
  });

  it('renews an expired link: the new URL is shown once and the list is refreshed', async () => {
    await open();

    (row('l-2').querySelector('button.renew') as HTMLButtonElement).click();
    const renew = http.expectOne('/api/v1/links/l-2/renew');
    expect(renew.request.method).toBe('POST');
    renew.flush({ link_id: 'l-2', url: SECRET_URL, expires_at: daysFromNow(30) });
    await settle();

    await waitFor(fixture(), () => dialog());
    expect(dialog()?.textContent).toContain('Link for \u2068Mona Said\u2069');
    expect((dialog()?.querySelector('input.link-url') as HTMLInputElement).value).toBe(SECRET_URL);

    http.expectOne('/api/v1/links').flush([ACTIVE, { ...EXPIRED, expires_at: daysFromNow(30) }, REVOKED]);
    await settle();
    expect(row('l-2').querySelector('.status')?.textContent).toContain('Active');
  });

  it('says the link was revoked when renewing a revoked link, and refreshes', async () => {
    await open();

    (row('l-2').querySelector('button.renew') as HTMLButtonElement).click();
    http.expectOne('/api/v1/links/l-2/renew').flush(
      { code: 'link_revoked', message: 'English API text', details: null, trace_id: 't' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    const text = el().querySelector('.error')?.textContent ?? '';
    expect(text).toContain('This link was revoked');
    expect(text).not.toContain('English API text');
    expect(dialog()).toBeNull();
    http.expectOne('/api/v1/links').flush([ACTIVE, { ...EXPIRED, revoked_at: daysFromNow(-1) }, REVOKED]);
    await settle();
    expect(row('l-2').querySelector('.status')?.textContent).toContain('Revoked');
  });

  it('asks before revoking, and revokes only on confirm', async () => {
    await open();

    (row('l-1').querySelector('button.revoke') as HTMLButtonElement).click();
    await waitFor(fixture(), () => dialog());
    expect(dialog()?.textContent).toContain('Revoke the link for \u2068Karim Adel\u2069?');
    dialogButton('dialog-cancel')?.click();
    await waitFor(fixture(), () => !dialog());
    http.expectNone((r) => r.method === 'POST');

    (row('l-1').querySelector('button.revoke') as HTMLButtonElement).click();
    (await waitFor(fixture(), () => dialogButton('dialog-confirm'))).click();
    const req = await waitFor(fixture(), () => http.match((r) => r.url === '/api/v1/links/l-1/revoke')[0]);
    expect(req.request.method).toBe('POST');
    req.flush({ ...ACTIVE, revoked_at: new Date().toISOString() });
    await settle();

    expect(row('l-1').querySelector('.status')?.textContent).toContain('Revoked');
    expect(row('l-1').querySelector('button.renew')).toBeNull();
  });

  it('says the link was not found when it is gone, and refreshes the list', async () => {
    await open();

    (row('l-1').querySelector('button.renew') as HTMLButtonElement).click();
    http.expectOne('/api/v1/links/l-1/renew').flush(
      { code: 'not_found', message: 'x', details: null, trace_id: 't' },
      { status: 404, statusText: 'Not Found' },
    );
    await settle();

    expect(el().querySelector('.error')?.textContent).toContain('This link was not found');
    http.expectOne('/api/v1/links').flush([EXPIRED]);
    await settle();
    expect(rows().length).toBe(1);
  });

  it('sends the admin to /mfa when the second step has lapsed', async () => {
    await open();

    (row('l-1').querySelector('button.renew') as HTMLButtonElement).click();
    http.expectOne('/api/v1/links/l-1/renew').flush(
      { code: 'mfa_required', message: 'x', details: null, trace_id: 't' },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();

    expect(router.url).toBe('/mfa');
  });

  it('offers a retry when the links cannot be loaded', async () => {
    await harness.navigateByUrl('/links', LinksPage);
    fixture().detectChanges();
    http.expectOne('/api/v1/links').error(new ProgressEvent('error'));
    await settle();

    expect(el().querySelector('.load-error')).not.toBeNull();
    (el().querySelector('button.retry') as HTMLButtonElement).click();
    http.expectOne('/api/v1/links').flush([ACTIVE]);
    await settle();

    expect(rows().length).toBe(1);
  });
});
