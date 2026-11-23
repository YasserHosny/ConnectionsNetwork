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
import {
  ADMIN_PERSON_ID,
  fakeAuthService,
  fakeSession,
  loadCatalogues,
  waitFor,
} from '../../testing/test-helpers';
import { UnreachablePage } from './unreachable.page';

const PEOPLE: ReviewPerson[] = [
  { person_id: 'u-1', display_name: 'Omar Ali', profession: 'Driver', city: 'Giza', last_confirmed_at: '2026-05-01T10:00:00Z' },
  { person_id: 'u-2', display_name: 'Mona Said', profession: null, city: null, last_confirmed_at: '2026-06-01T10:00:00Z' },
];

describe('UnreachablePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const rows = () => Array.from(el().querySelectorAll('li.person'));
  const dialog = () => document.querySelector('mat-dialog-container');
  const inDialog = <T extends Element>(selector: string) => dialog()?.querySelector(selector) as T | null;

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  async function open(people: ReviewPerson[] = PEOPLE): Promise<void> {
    await harness.navigateByUrl('/review/unreachable', UnreachablePage);
    fixture().detectChanges();
    http.expectOne('/api/v1/review/unreachable').flush(people);
    await settle();
  }

  async function openConnectDialog(row = 0): Promise<void> {
    (rows()[row].querySelector('button.connect') as HTMLButtonElement).click();
    await waitFor(fixture(), () => dialog());
  }

  function chooseStrength(value: string): void {
    inDialog<HTMLInputElement>(`mat-radio-button[value="${value}"] input`)?.click();
    fixture().detectChanges();
  }

  const submit = () => inDialog<HTMLButtonElement>('button.dialog-submit')?.click();

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'review/unreachable', component: UnreachablePage },
          { path: 'mfa', children: [] },
          { path: 'login', children: [] },
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

  it('lists the people with no path from you', async () => {
    await open();

    expect(rows().length).toBe(2);
    expect(rows()[0].textContent).toContain('Omar Ali');
    expect(rows()[0].textContent).toContain('Driver');
    expect(rows()[0].querySelector('a.name')?.getAttribute('href')).toBe('/people/u-1');
  });

  it('says so when everyone is connected', async () => {
    await open([]);

    expect(el().querySelector('.empty')?.textContent).toContain('Everyone is connected to you');
  });

  it('opens the connect dialog for that person, with the strength help text', async () => {
    await open();

    await openConnectDialog(1);

    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Connect \u2068Mona Said\u2069');
    expect(text).toContain('Connection strength');
    expect(text).toContain('People you met only once: weak.');
    expect(text).toContain('Me (default)');
  });

  it('asks for a strength and sends nothing without one', async () => {
    await open();
    await openConnectDialog();

    submit();
    fixture().detectChanges();

    http.expectNone((r) => r.method === 'POST');
    expect(inDialog('.field-error')?.textContent).toContain('Choose the connection strength');
  });

  it('connects the person to you by default and takes them off the list', async () => {
    await open();
    await openConnectDialog();

    chooseStrength('weak');
    submit();
    const req = http.expectOne('/api/v1/connections');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ person_a: 'u-1', person_b: ADMIN_PERSON_ID, strength: 'weak' });
    req.flush({ id: 'k-1', person_a: 'u-1', person_b: ADMIN_PERSON_ID, strength: 'weak', note: null });
    await settle();

    await waitFor(fixture(), () => !dialog());
    expect(rows().length).toBe(1);
    expect(rows()[0].textContent).toContain('Mona Said');
    expect(el().querySelector('.status')?.textContent).toContain('Connected \u2068Omar Ali\u2069');
  });

  it('connects the person to someone found by name', async () => {
    await open();
    await openConnectDialog();

    const input = inDialog<HTMLInputElement>('input[type=search]') as HTMLInputElement;
    input.value = 'Karim';
    input.dispatchEvent(new Event('input'));
    const search = await waitFor(fixture(), () => http.match((r) => r.url === '/api/v1/search')[0]);
    search.flush([{ person_id: 'karim', display_name: 'Karim Adel', profession: null, city: null }]);
    await settle();
    (inDialog('.results button') as HTMLButtonElement).click();
    fixture().detectChanges();
    chooseStrength('strong');
    submit();

    const req = http.expectOne('/api/v1/connections');
    expect(req.request.body).toEqual({ person_a: 'u-1', person_b: 'karim', strength: 'strong' });
    req.flush({ id: 'k-2' });
    await settle();
    await waitFor(fixture(), () => !dialog());
    expect(rows().length).toBe(1);
  });

  it('keeps the dialog open and says why when the two are already connected', async () => {
    await open();
    await openConnectDialog();

    chooseStrength('normal');
    submit();
    http.expectOne('/api/v1/connections').flush(
      { code: 'conflict', message: 'English API text', details: null, trace_id: 't' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    const text = inDialog('.dialog-error')?.textContent ?? '';
    expect(text).toContain('already connected');
    expect(text).not.toContain('English API text');
    expect(rows().length).toBe(2);
  });

  it('sends the admin to /mfa when the second step has lapsed', async () => {
    await open();
    await openConnectDialog();

    chooseStrength('normal');
    submit();
    http.expectOne('/api/v1/connections').flush(
      { code: 'mfa_required', message: 'x', details: null, trace_id: 't' },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();

    expect(router.url).toBe('/mfa');
    // The router moved on, but a dialog does not close on that by itself: it must not stay open over /mfa.
    await waitFor(fixture(), () => !dialog());
    expect(dialog()).toBeNull();
  });

  it('closes the dialog and goes to /login when the session has ended', async () => {
    await open();
    await openConnectDialog();

    chooseStrength('normal');
    submit();
    http.expectOne('/api/v1/connections').flush(
      { code: 'unauthorized', message: 'x', details: null, trace_id: 't' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await settle();

    await waitFor(fixture(), () => router.url === '/login');
    await waitFor(fixture(), () => !dialog());
    expect(dialog()).toBeNull();
  });

  it('closes the dialog without sending anything on cancel', async () => {
    await open();
    await openConnectDialog();

    inDialog<HTMLButtonElement>('button.dialog-cancel')?.click();
    await waitFor(fixture(), () => !dialog());

    http.expectNone((r) => r.method === 'POST');
    expect(rows().length).toBe(2);
  });

  it('offers a retry when the list cannot be loaded', async () => {
    await harness.navigateByUrl('/review/unreachable', UnreachablePage);
    fixture().detectChanges();
    http.expectOne('/api/v1/review/unreachable').error(new ProgressEvent('error'));
    await settle();

    expect(el().querySelector('.load-error')).not.toBeNull();
    (el().querySelector('button.retry') as HTMLButtonElement).click();
    http.expectOne('/api/v1/review/unreachable').flush(PEOPLE);
    await settle();

    expect(rows().length).toBe(2);
  });
});
