import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import type { SearchResult } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { SearchPage } from './search.page';

const node = (id: string, name: string) => ({ person_id: id, display_name: name });

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  person_id: 'sara',
  display_name: 'Sara Mahmoud',
  profession: 'Digital Marketing',
  headline: null,
  city: 'Cairo',
  matched_skills: [{ label: 'SEO', level: 'expert' }],
  available_for: [],
  last_confirmed_at: '2026-08-20T10:00:00Z',
  is_stale: false,
  path: [node('me', 'Me'), node('ahmed', 'Ahmed'), node('sara', 'Sara Mahmoud')],
  cost: 3,
  steps: 2,
  ...overrides,
});

describe('SearchPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  const searchRequests = () => http.match((r) => r.url === '/api/v1/search');

  async function open(url = '/search'): Promise<void> {
    await harness.navigateByUrl(url, SearchPage);
    fixture().detectChanges();
  }

  function type(selector: string, value: string): void {
    const input = el().querySelector(selector) as HTMLInputElement | HTMLSelectElement;
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  }

  function submit(): void {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'search', component: SearchPage }]),
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

  it('asks for something to search and sends nothing while the form is empty', async () => {
    await open();
    submit();
    await settle();

    expect(el().querySelector('.idle')?.textContent).toContain('Type a name');
  });

  it('answers an empty Search by moving to the text field and announcing what to type', async () => {
    await open();
    submit();
    await settle();

    expect(document.activeElement).toBe(el().querySelector('input[name=q]'));
    expect(el().querySelector('.idle')?.getAttribute('role')).toBe('status');
  });

  it('an emptied search clears the last results and the URL, and asks for something to search', async () => {
    await open('/search?q=seo');
    http.expectOne((r) => r.url === '/api/v1/search').flush([result()]);
    await settle();

    type('input[name=q]', '');
    submit();
    await settle();

    expect(router.url).toBe('/search');
    expect(el().querySelectorAll('app-result-card').length).toBe(0);
    expect(el().querySelector('.idle')?.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(el().querySelector('input[name=q]'));
  });

  it('Clear also takes away the warning about a contact value', async () => {
    await open();
    type('input[name=q]', 'sara@example.com');
    submit();
    await settle();
    expect(el().querySelector('.contact-hint')).not.toBeNull();

    (el().querySelector('button.clear') as HTMLButtonElement).click();
    await settle();

    expect(el().querySelector('.contact-hint')).toBeNull();
  });

  describe('the filters', () => {
    const panel = () => el().querySelector('details.filters-panel') as HTMLDetailsElement;
    const narrow = (matches: boolean) =>
      spyOn(window, 'matchMedia').and.returnValue({ matches } as MediaQueryList);

    it('are folded on a phone, so the results come first', async () => {
      narrow(false);
      await open();

      expect(panel().open).toBeFalse();
      expect(panel().querySelector('summary')?.textContent).toContain('Filters');
    });

    it('open on a phone when one is set, and say how many', async () => {
      narrow(false);
      await open('/search?city=Cairo&seniority=manager');
      http.expectOne((r) => r.url === '/api/v1/search').flush([]);
      await settle();

      expect(panel().open).toBeTrue();
      expect(panel().querySelector('summary')?.textContent).toContain('2');
    });

    it('say "Filters" once: the fieldset legend is only for screen readers', async () => {
      narrow(true);
      await open();

      const legend = el().querySelector('fieldset.filters legend') as HTMLElement;
      expect(legend.textContent).toContain('Filters');
      expect(getComputedStyle(legend).position).toBe('absolute');
      expect(legend.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    });

    it('stay open on a wider screen', async () => {
      narrow(true);
      await open();

      expect(panel().open).toBeTrue();
    });
  });

  it('searches with the typed text and puts it in the URL for back and forward', async () => {
    await open();
    type('input[name=q]', 'seo');
    submit();
    await settle();

    const req = http.expectOne((r) => r.url === '/api/v1/search');
    expect(req.request.params.get('q')).toBe('seo');
    expect(req.request.params.get('limit')).toBe('50');
    req.flush([result()]);
    await settle();

    expect(router.url).toBe('/search?q=seo');
    expect(el().querySelectorAll('app-result-card').length).toBe(1);
    expect(el().querySelector('.count')?.textContent).toContain('1');
  });

  it('sends every filter under the API parameter names', async () => {
    await open();
    type('select[name=category]', 'technical');
    type('select[name=minLevel]', 'good');
    type('input[name=industry]', 'Banking');
    type('select[name=seniority]', 'manager');
    type('select[name=availableFor]', 'freelance');
    type('input[name=city]', 'Cairo');
    submit();
    await settle();

    const req = http.expectOne((r) => r.url === '/api/v1/search');
    const sent = Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
    expect(sent).toEqual({
      category: 'technical',
      min_level: 'good',
      industry: 'Banking',
      seniority: 'manager',
      available_for: 'freelance',
      city: 'Cairo',
      limit: '50',
    });
    req.flush([]);
    await settle();

    expect(el().querySelector('.no-results')?.textContent).toContain('No one matches this search');
  });

  it('restores the form and runs the search from the URL', async () => {
    await open('/search?q=seo&city=Cairo&min_level=expert');

    const req = http.expectOne((r) => r.url === '/api/v1/search');
    expect(req.request.params.get('q')).toBe('seo');
    expect(req.request.params.get('city')).toBe('Cairo');
    expect(req.request.params.get('min_level')).toBe('expert');
    req.flush([result()]);
    await settle();

    expect((el().querySelector('input[name=q]') as HTMLInputElement).value).toBe('seo');
    expect((el().querySelector('select[name=minLevel]') as HTMLSelectElement).value).toBe('expert');
  });

  it('searches again when the URL changes (back and forward)', async () => {
    await open('/search?q=seo');
    http.expectOne((r) => r.url === '/api/v1/search').flush([result()]);
    await settle();

    await router.navigateByUrl('/search?q=design');
    await settle();

    const req = http.expectOne((r) => r.url === '/api/v1/search');
    expect(req.request.params.get('q')).toBe('design');
    req.flush([]);
    await settle();
    expect((el().querySelector('input[name=q]') as HTMLInputElement).value).toBe('design');
  });

  it('runs the same search again when Search is pressed with nothing changed', async () => {
    await open('/search?q=seo');
    http.expectOne((r) => r.url === '/api/v1/search').flush([result()]);
    await settle();

    submit();
    await settle();

    const again = searchRequests();
    expect(again.length).toBe(1);
    expect(again[0].request.params.get('q')).toBe('seo');
    again[0].flush([result()]);
  });

  it('does not search for a phone-like query, says why, and keeps it out of the URL', async () => {
    await open();
    type('input[name=q]', '+20 10 1234 5678');
    submit();
    await settle();

    expect(searchRequests().length).toBe(0);
    expect(el().querySelector('.contact-hint')?.textContent).toContain('cannot be searched');
    expect(router.url).toBe('/search');
  });

  it('does not search for a name with a phone number in it', async () => {
    await open();
    type('input[name=q]', 'Sara 01012345678');
    submit();
    await settle();

    expect(searchRequests().length).toBe(0);
    expect(el().querySelector('.contact-hint')).not.toBeNull();
    expect(router.url).toBe('/search');
  });

  it('does not search for an email address either', async () => {
    await open();
    type('input[name=q]', 'sara@example.com');
    submit();
    await settle();

    expect(searchRequests().length).toBe(0);
    expect(el().querySelector('.contact-hint')).not.toBeNull();
    expect(router.url).toBe('/search');
  });

  it('cleans a phone-like query out of the URL without searching', async () => {
    await open('/search?q=01012345678');
    await settle();

    expect(searchRequests().length).toBe(0);
    expect(router.url).toBe('/search');
    expect(el().querySelector('.contact-hint')).not.toBeNull();
  });

  it('keeps the other filters when a phone-like query is cleaned out of the URL', async () => {
    await open('/search?q=01012345678&city=Cairo');
    await settle();

    // Redirected to the clean URL, which now searches on the city alone.
    const req = http.expectOne((r) => r.url === '/api/v1/search');
    expect(req.request.params.has('q')).toBeFalse();
    expect(req.request.params.get('city')).toBe('Cairo');
    req.flush([]);
    expect(router.url).toBe('/search?city=Cairo');
  });

  it('clears the form and the results', async () => {
    await open('/search?q=seo');
    http.expectOne((r) => r.url === '/api/v1/search').flush([result()]);
    await settle();

    (el().querySelector('button.clear') as HTMLButtonElement).click();
    await settle();

    expect(router.url).toBe('/search');
    expect(el().querySelectorAll('app-result-card').length).toBe(0);
    expect((el().querySelector('input[name=q]') as HTMLInputElement).value).toBe('');
  });

  it('lists the results in the order the API gave them', async () => {
    await open('/search?q=a');
    http
      .expectOne((r) => r.url === '/api/v1/search')
      .flush([result({ person_id: 'a', display_name: 'Ali' }), result({ person_id: 'b', display_name: 'Basma' })]);
    await settle();

    const names = Array.from(el().querySelectorAll('app-result-card a.name')).map((a) => a.textContent?.trim());
    expect(names).toEqual(['Ali', 'Basma']);
  });

  it('says when it shows only the 50 closest people, so a broad search is narrowed', async () => {
    await open('/search?q=a');
    http
      .expectOne((r) => r.url === '/api/v1/search')
      .flush(Array.from({ length: 50 }, (_, i) => result({ person_id: `p${i}`, display_name: `P ${i}` })));
    await settle();

    expect(el().querySelector('.limit-note')?.textContent).toContain('Showing the 50 closest people');
  });

  it('says nothing about a limit when fewer people match', async () => {
    await open('/search?q=a');
    http.expectOne((r) => r.url === '/api/v1/search').flush([result()]);
    await settle();

    expect(el().querySelector('.limit-note')).toBeNull();
  });

  it('shows a translated error, never the API text', async () => {
    await open('/search?q=seo');
    http
      .expectOne((r) => r.url === '/api/v1/search')
      .flush(
        { code: 'internal_error', message: 'Boom from the server', details: null, trace_id: 't' },
        { status: 500, statusText: 'Server Error' },
      );
    await settle();

    expect(el().querySelector('[role=alert]')?.textContent).toContain('Could not reach the server');
    expect(el().textContent).not.toContain('Boom');
  });

  it('goes to /mfa when the MFA step has lapsed', async () => {
    await open('/search?q=seo');
    const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);
    http
      .expectOne((r) => r.url === '/api/v1/search')
      .flush(
        { code: 'mfa_required', message: 'x', details: null, trace_id: 't' },
        { status: 403, statusText: 'Forbidden' },
      );
    await settle();

    expect(navigate).toHaveBeenCalledWith(jasmine.stringMatching(/^\/mfa(\?|$)/));
  });
});
