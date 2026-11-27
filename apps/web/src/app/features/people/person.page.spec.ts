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

  describe('right after a quick add', () => {
    it('says the person was saved and offers to add another', async () => {
      const navigated = router.navigateByUrl('/people/p-7', { state: { justAdded: true } });
      (await until(() => http.match('/api/v1/people/p-7')[0])).flush(PERSON);
      http.expectOne('/api/v1/people/p-7/paths?k=4').flush(PATHS);
      await navigated;
      await settle();

      const banner = el().querySelector('.just-added') as HTMLElement;
      expect(banner.getAttribute('role')).toBe('status');
      expect(banner.querySelector('a')?.getAttribute('href')).toBe('/add');
      expect(banner.textContent).toContain('Add another person');
    });

    it('is not offered when the person is simply opened', async () => {
      await open();

      expect(el().querySelector('.just-added')).toBeNull();
    });
  });

  it('opens a social link saved without a scheme on the web, and never a script link', async () => {
    await harness.navigateByUrl('/people/p-7', PersonPage);
    fixture().detectChanges();
    http.expectOne('/api/v1/people/p-7').flush({
      ...PERSON,
      social_links: [
        { id: 's1', kind: 'linkedin', url: 'linkedin.com/in/sara' },
        { id: 's2', kind: 'website', url: 'javascript:alert(1)' },
      ],
    });
    http.expectOne('/api/v1/people/p-7/paths?k=4').flush(PATHS);
    await settle();

    const links = Array.from(el().querySelectorAll('.links a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://linkedin.com/in/sara', null]);
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
    expect((rows[0].querySelector('select.connection-strength') as HTMLSelectElement).value).toBe('strong');
    expect(rows[0].textContent).toContain('old friends');
    expect((rows[1].querySelector('select.connection-strength') as HTMLSelectElement).value).toBe('weak');
  });

  describe('managing connections', () => {
    /** After a change the page asks again for the person and the paths, without blanking. */
    async function expectRefresh(): Promise<void> {
      http.expectOne('/api/v1/people/p-7').flush(PERSON);
      http.expectOne('/api/v1/people/p-7/paths?k=4').flush(PATHS);
      await settle();
      expect(el().querySelector('h1')?.textContent).toContain('Sara Mahmoud');
    }

    it('adds a connection to someone already in the network, to you by default', async () => {
      await open();
      button('add-connection').click();
      const container = await until(dialog);

      expect(container.textContent).toContain('Connect \u2068Sara Mahmoud\u2069');
      expect(container.textContent).toContain('Anyone you could message who would know who you are.');
      (container.querySelector('mat-radio-button[value="normal"] input') as HTMLInputElement).click();
      (container.querySelector('button.dialog-submit') as HTMLButtonElement).click();

      const post = http.expectOne('/api/v1/connections');
      expect(post.request.method).toBe('POST');
      expect(post.request.body).toEqual({ person_a: 'p-7', person_b: ADMIN_PERSON_ID, strength: 'normal' });
      post.flush({ id: 'k3' }, { status: 201, statusText: 'Created' });
      await until(() => !dialog());

      await expectRefresh();
      expect(el().querySelector('.connection-notice')?.textContent).toContain('Connection added.');
    });

    it('says so, in the dialog, when the two are already connected', async () => {
      await open();
      button('add-connection').click();
      const container = await until(dialog);
      (container.querySelector('mat-radio-button[value="weak"] input') as HTMLInputElement).click();
      (container.querySelector('button.dialog-submit') as HTMLButtonElement).click();

      http
        .expectOne('/api/v1/connections')
        .flush(
          { code: 'conflict', message: 'Request conflicts.', details: { reason: 'already_connected' }, trace_id: 't' },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();

      expect(dialog()?.textContent).toContain('These two people are already connected.');
      (document.querySelector('.dialog-cancel') as HTMLButtonElement).click();
      await until(() => !dialog());
    });

    it('changes the strength of a connection', async () => {
      await open();
      const select = el().querySelector('.connections li select.connection-strength') as HTMLSelectElement;
      expect(select.getAttribute('aria-label')).toContain('Karim');

      select.value = 'normal';
      select.dispatchEvent(new Event('change'));

      const patch = http.expectOne('/api/v1/connections/k1');
      expect(patch.request.method).toBe('PATCH');
      expect(patch.request.body).toEqual({ strength: 'normal' });
      patch.flush({ id: 'k1' });
      await expectRefresh();
      expect(el().querySelector('.connection-notice')?.textContent).toContain('Connection updated.');
    });

    it('shows a translated error and the stored strength again when the change fails', async () => {
      await open();
      const select = el().querySelector('.connections li select.connection-strength') as HTMLSelectElement;
      select.value = 'weak';
      select.dispatchEvent(new Event('change'));

      http.expectOne('/api/v1/connections/k1').flush(null, { status: 503, statusText: 'x' });
      await settle();

      expect(el().querySelector('.action-error')?.textContent).toContain('Could not reach the server');
      expect((el().querySelector('.connections li select.connection-strength') as HTMLSelectElement).value).toBe(
        'strong',
      );
    });

    it('removes a connection after confirmation', async () => {
      await open();
      (el().querySelector('.connections li button.remove-connection') as HTMLButtonElement).click();
      const container = await until(dialog);

      expect(container.textContent).toContain('Remove the connection with \u2068Karim\u2069?');
      (document.querySelector('.dialog-confirm') as HTMLButtonElement).click();
      const del = await deleteRequest();
      expect(del.request.url).toBe('/api/v1/connections/k1');
      del.flush(null, { status: 204, statusText: 'No Content' });

      await expectRefresh();
      expect(el().querySelector('.connection-notice')?.textContent).toContain('Connection removed.');
    });

    it('removes nothing when the confirmation is cancelled', async () => {
      await open();
      (el().querySelector('.connections li button.remove-connection') as HTMLButtonElement).click();
      await until(dialog);
      (document.querySelector('.dialog-cancel') as HTMLButtonElement).click();
      await until(() => !dialog());

      expect(http.match((r) => r.method === 'DELETE').length).toBe(0);
    });
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

  it('treats a malformed person link as not found, with a way back to search', async () => {
    await harness.navigateByUrl('/people/not-a-uuid', PersonPage);
    const invalid = { code: 'validation.invalid_request', message: 'x', details: null, trace_id: 't' };
    http.expectOne('/api/v1/people/not-a-uuid').flush(invalid, { status: 422, statusText: 'x' });
    http.expectOne('/api/v1/people/not-a-uuid/paths?k=4').flush(invalid, { status: 422, statusText: 'x' });
    await settle();

    expect(el().querySelector('[role=alert]')?.textContent).toContain('was not found');
    expect(el().querySelector('button.retry')).toBeNull();
    expect(el().querySelector('a.back-to-search')?.getAttribute('href')).toBe('/search');
  });

  describe('your own connection', () => {
    const MINE = {
      ...PERSON,
      connections: [{ id: 'k9', person_id: ADMIN_PERSON_ID, display_name: 'Yasser Hosny', strength: 'normal', note: null }],
    } as unknown as PersonOut;

    async function openMine(): Promise<void> {
      await harness.navigateByUrl('/people/p-7', PersonPage);
      http.expectOne('/api/v1/people/p-7').flush(MINE);
      http.expectOne('/api/v1/people/p-7/paths?k=4').flush(PATHS);
      await settle();
    }

    it('reads "You", as in the path, not your own name', async () => {
      await openMine();

      const link = el().querySelector('.connections li a') as HTMLAnchorElement;
      expect(link.textContent?.trim()).toBe('You');
      expect(el().querySelector('.connections')?.textContent).not.toContain('Yasser Hosny');
    });

    it('is announced to screen readers as yours', async () => {
      await openMine();

      const li = el().querySelector('.connections li') as HTMLElement;
      expect(li.querySelector('button.remove-connection')?.getAttribute('aria-label')).toBe('Remove your connection');
      expect(li.querySelector('select.connection-strength')?.getAttribute('aria-label')).toBe('Strength of your connection');
    });

    it('is removed with a question in your words', async () => {
      await openMine();
      (el().querySelector('.connections li button.remove-connection') as HTMLButtonElement).click();
      const container = await until(dialog);

      expect(container.textContent).toContain('Remove your connection with \u2068Sara Mahmoud\u2069?');
      expect(container.textContent).not.toContain('Yasser Hosny');
      (document.querySelector('.dialog-cancel') as HTMLButtonElement).click();
      await until(() => !dialog());
    });
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

      expect(dialog()?.textContent).toContain('Delete \u2068Sara Mahmoud\u2069?');
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
