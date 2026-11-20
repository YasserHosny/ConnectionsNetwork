import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import type { AlternativePath, PersonOut } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { ADMIN_PERSON_ID, fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { PersonPage } from './person.page';

const PERSON = {
  id: 'p-7',
  name_ar: null,
  name_latin: 'Sara Mahmoud',
  display_name: 'Sara Mahmoud',
  headline: 'Marketing lead',
  organization: 'Acme',
  profession: 'Digital Marketing',
  seniority: 'manager',
  available_for: ['freelance'],
  city: 'Cairo',
  country: 'Egypt',
  admin_notes: 'met at a wedding',
  last_confirmed_at: '2026-08-20T10:00:00Z',
  is_stale: false,
  skills: [
    { tag_id: 't1', label: 'SEO', category: 'business', level: 'expert' },
    { tag_id: 't2', label: 'Meta Ads', category: 'business', level: null },
  ],
  industries: [{ tag_id: 't3', label: 'Retail' }],
  social_links: [{ id: 's1', kind: 'linkedin', url: 'https://linkedin.com/in/sara' }],
  contacts: [{ id: 'c1', kind: 'phone', value: '01012345678', added_by_person_id: null }],
  connections: [
    { id: 'k1', person_id: 'karim', display_name: 'Karim', strength: 'strong', note: 'old friends' },
    { id: 'k2', person_id: 'omar', display_name: 'Omar', strength: 'weak', note: null },
  ],
} as unknown as PersonOut;

const node = (id: string, name: string) => ({ person_id: id, display_name: name });
const PATHS: AlternativePath[] = [
  { cost: 3, path: [node('me', 'Me'), node('karim', 'Karim'), node('p-7', 'Sara Mahmoud')] },
  { cost: 5, path: [node('me', 'Me'), node('ahmed', 'Ahmed'), node('omar', 'Omar'), node('p-7', 'Sara Mahmoud')] },
];

describe('PersonPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const button = (cls: string) => el().querySelector(`button.${cls}`) as HTMLButtonElement;
  const dialog = () => document.querySelector('mat-dialog-container');
  const pathNames = (path: Element) =>
    Array.from(path.querySelectorAll('li')).map((li) => li.querySelector('a')?.textContent ?? li.textContent);

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  /** The dialog animates in and out; wait for what the test needs rather than a fixed time. */
  async function until<T>(condition: () => T): Promise<NonNullable<T>> {
    let value = condition();
    for (let i = 0; i < 100 && !value; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fixture().detectChanges();
      value = condition();
    }
    expect(value).toBeTruthy();
    return value as NonNullable<T>;
  }

  const deleteRequest = () => until(() => http.match((r) => r.method === 'DELETE')[0]);

  async function open(id = 'p-7', loadPaths = true): Promise<void> {
    await harness.navigateByUrl(`/people/${id}`, PersonPage);
    fixture().detectChanges();
    http.expectOne(`/api/v1/people/${id}`).flush({ ...PERSON, id });
    if (loadPaths) http.expectOne(`/api/v1/people/${id}/paths?k=4`).flush(PATHS);
    await settle();
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'people/:id', component: PersonPage }, { path: 'search', children: [] }]),
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

  it('shows the profile', async () => {
    await open();

    const text = el().textContent ?? '';
    expect(el().querySelector('h1')?.textContent).toContain('Sara Mahmoud');
    for (const expected of [
      'Marketing lead',
      'Acme',
      'Digital Marketing',
      'Manager',
      'Cairo',
      'Egypt',
      'Takes freelance work',
      'SEO (Expert)',
      'Meta Ads',
      'Retail',
      'LinkedIn',
      'Phone',
      '01012345678',
      'met at a wedding',
      'Last confirmed',
    ]) {
      expect(text).withContext(expected).toContain(expected);
    }
    expect(el().querySelector('a[href="https://linkedin.com/in/sara"]')).not.toBeNull();
    expect(el().querySelector('.stale-badge')).toBeNull();
  });

  it('marks a stale profile', async () => {
    await harness.navigateByUrl('/people/p-7', PersonPage);
    http.expectOne('/api/v1/people/p-7').flush({ ...PERSON, is_stale: true });
    http.expectOne('/api/v1/people/p-7/paths?k=4').flush(PATHS);
    await settle();

    expect(el().querySelector('.stale-badge')?.textContent).toContain('Not confirmed for over a year');
  });

  it('lists one-hop connections with their strength, each linking to that person', async () => {
    await open();

    const rows = Array.from(el().querySelectorAll('.connections li'));
    expect(rows.map((r) => r.querySelector('a')?.getAttribute('href'))).toEqual(['/people/karim', '/people/omar']);
    expect(rows[0].textContent).toContain('Strong');
    expect(rows[0].textContent).toContain('old friends');
    expect(rows[1].textContent).toContain('Weak');
  });

  it('shows the best path from you, and the other paths on request', async () => {
    await open();

    expect(pathNames(el().querySelector('.best-path .path-line') as Element)).toEqual(['You', 'Karim', 'Sara Mahmoud']);
    expect(el().querySelector('.alternatives')).toBeNull();

    button('toggle-alternatives').click();
    fixture().detectChanges();

    const others = Array.from(el().querySelectorAll('.alternatives .path-line')).map(pathNames);
    expect(others).toEqual([['You', 'Ahmed', 'Omar', 'Sara Mahmoud']]);
    expect(button('toggle-alternatives').getAttribute('aria-expanded')).toBe('true');
  });

  it('says so when the person cannot be reached from you', async () => {
    await harness.navigateByUrl('/people/p-7', PersonPage);
    http.expectOne('/api/v1/people/p-7').flush(PERSON);
    http.expectOne('/api/v1/people/p-7/paths?k=4').flush([]);
    await settle();

    expect(el().querySelector('.no-path')?.textContent).toContain('Not connected to you');
    expect(el().querySelector('button.toggle-alternatives')).toBeNull();
  });

  it('shows "this is you" and asks for no paths on your own page', async () => {
    await harness.navigateByUrl(`/people/${ADMIN_PERSON_ID}`, PersonPage);
    http.expectOne(`/api/v1/people/${ADMIN_PERSON_ID}`).flush({ ...PERSON, id: ADMIN_PERSON_ID });
    await settle();

    expect(el().querySelector('.is-you')?.textContent).toContain('This is you');
  });

  it('keeps the profile when only the paths fail to load', async () => {
    await harness.navigateByUrl('/people/p-7', PersonPage);
    http.expectOne('/api/v1/people/p-7').flush(PERSON);
    http.expectOne('/api/v1/people/p-7/paths?k=4').error(new ProgressEvent('error'));
    await settle();

    expect(el().querySelector('h1')?.textContent).toContain('Sara Mahmoud');
    expect(el().querySelector('.paths-error')?.textContent).toContain('Could not load the paths');
  });

  it('loads the next person when you follow a connection', async () => {
    await open();

    await router.navigateByUrl('/people/karim');
    http.expectOne('/api/v1/people/karim').flush({ ...PERSON, id: 'karim', display_name: 'Karim' });
    http.expectOne('/api/v1/people/karim/paths?k=4').flush([]);
    await settle();

    expect(el().querySelector('h1')?.textContent).toContain('Karim');
  });

  it('says so when the person does not exist', async () => {
    await harness.navigateByUrl('/people/nope', PersonPage);
    http
      .expectOne('/api/v1/people/nope')
      .flush(
        { code: 'not_found', message: 'Resource was not found.', details: null, trace_id: 't' },
        { status: 404, statusText: 'Not Found' },
      );
    http.expectOne('/api/v1/people/nope/paths?k=4').flush([]);
    await settle();

    expect(el().querySelector('h1')).toBeNull();
    expect(el().querySelector('[role=alert]')?.textContent).toContain('was not found');
  });

  it('offers a retry when the person cannot be loaded', async () => {
    await harness.navigateByUrl('/people/p-7', PersonPage);
    http.expectOne('/api/v1/people/p-7').error(new ProgressEvent('error'));
    http.expectOne('/api/v1/people/p-7/paths?k=4').flush([]);
    await settle();

    (el().querySelector('button.retry') as HTMLButtonElement).click();
    http.expectOne('/api/v1/people/p-7').flush(PERSON);
    http.expectOne('/api/v1/people/p-7/paths?k=4').flush(PATHS);
    await settle();

    expect(el().querySelector('h1')?.textContent).toContain('Sara Mahmoud');
  });

  it('links to the edit page', async () => {
    await open();

    expect(el().querySelector('a.edit')?.getAttribute('href')).toBe('/people/p-7/edit');
  });

  it('confirms the details and shows the refreshed profile', async () => {
    await open();
    button('confirm').click();

    const req = http.expectOne('/api/v1/people/p-7/confirm');
    expect(req.request.method).toBe('POST');
    req.flush({ ...PERSON, is_stale: false, last_confirmed_at: '2026-11-20T09:00:00Z', headline: 'Refreshed' });
    await settle();

    expect(el().textContent).toContain('Refreshed');
    expect(el().querySelector('.confirmed')?.textContent).toContain('Marked as confirmed');
  });

  it('shows a translated error when confirming fails', async () => {
    await open();
    button('confirm').click();
    http
      .expectOne('/api/v1/people/p-7/confirm')
      .flush(
        { code: 'internal_error', message: 'Boom from the server', details: null, trace_id: 't' },
        { status: 500, statusText: 'Server Error' },
      );
    await settle();

    expect(el().querySelector('.action-error')?.textContent).toContain('Could not reach the server');
    expect(el().textContent).not.toContain('Boom');
  });

  describe('delete', () => {
    it('asks first, and does nothing when cancelled', async () => {
      await open();
      button('delete').click();
      await until(dialog);

      expect(dialog()?.textContent).toContain('Delete Sara Mahmoud?');
      (document.querySelector('.dialog-cancel') as HTMLButtonElement).click();
      await until(() => !dialog());

      http.expectNone('/api/v1/people/p-7');
    });

    it('deletes after confirmation and goes to search', async () => {
      await open();
      const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);
      button('delete').click();
      await until(dialog);
      (document.querySelector('.dialog-confirm') as HTMLButtonElement).click();
      (await deleteRequest()).flush(null, { status: 204, statusText: 'No Content' });
      await settle();

      expect(navigate).toHaveBeenCalledWith('/search');
    });

    it('explains that you cannot delete yourself', async () => {
      await open();
      const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);
      button('delete').click();
      await until(dialog);
      (document.querySelector('.dialog-confirm') as HTMLButtonElement).click();
      (await deleteRequest()).flush(
        { code: 'cannot_delete_self', message: "The admin's own person cannot be deleted.", details: null, trace_id: 't' },
        { status: 409, statusText: 'Conflict' },
      );
      await settle();

      expect(el().querySelector('.action-error')?.textContent).toContain('You cannot delete your own profile');
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
