import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import type { ContributorInfo } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { DraftStore } from '../../core/draft.store';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { ContributePage } from './contribute.page';

const TOKEN = 'T0KEN_abc-123_SECRET';
const INFO: ContributorInfo = { contributor_display_name: 'Karim Adel', expires_at: '2026-12-20T00:00:00Z' };

const EXPIRED_EN = 'This link has expired or is no longer valid. Ask for a new one.';
const EXPIRED_AR = 'انتهت صلاحية هذا الرابط أو لم يعد صالحًا. اطلب رابطًا جديدًا.';
const NO_TOKEN_EN = 'This page needs the link from your message. Open that link again.';

const linkNotFound = { code: 'link_not_found', message: 'Link not found.', details: null, trace_id: 't' };

/** Puts `#token` in the real address bar, as the WhatsApp link does. */
function openWithHash(hash: string): void {
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

describe('ContributePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let drafts: DraftStore;
  let auth: ReturnType<typeof fakeAuthService>;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const field = (name: string) => el().querySelector(`[formcontrolname="${name}"]`) as HTMLInputElement;
  const text = () => el().textContent ?? '';

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  /** Opens /c; `info` is the answer to the first request (a body, or an error to flush). */
  async function open(
    info: ContributorInfo | { status: number; body?: unknown } | null = INFO,
    url = `/c#${TOKEN}`,
  ): Promise<void> {
    // The real boot path: the router parses `/c#<token>` itself, fragment included.
    await harness.navigateByUrl(url, ContributePage);
    fixture().detectChanges();
    if (info === null) return;
    const request = http.expectOne('/api/v1/contribute/info');
    if ('status' in info) {
      request.flush(info.body ?? null, { status: info.status, statusText: 'x' });
    } else {
      request.flush(info);
    }
    await settle();
  }

  function setText(name: string, value: string): void {
    const input = field(name);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function chooseStrength(value: 'strong' | 'normal' | 'weak'): void {
    (el().querySelector(`mat-radio-button[value="${value}"] input`) as HTMLInputElement).click();
  }

  async function fillAndSubmit(name = 'Sara Ali', strength: 'strong' | 'normal' | 'weak' = 'normal'): Promise<void> {
    setText('nameLatin', name);
    chooseStrength(strength);
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture().whenStable();
  }

  const postRequest = (): TestRequest => http.expectOne('/api/v1/contribute/people');

  async function addPerson(name: string, profession?: string): Promise<void> {
    if (profession) setText('profession', profession);
    await fillAndSubmit(name);
    postRequest().flush({ person_id: 'p-new' }, { status: 201, statusText: 'Created' });
    await settle();
  }

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    openWithHash(`#${TOKEN}`);
    auth = fakeAuthService(fakeSession('aal2')); // an admin's own browser: the bearer must still stay off
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'c', component: ContributePage }]),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: AuthService, useValue: auth },
      ],
    });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    http = TestBed.inject(HttpTestingController);
    drafts = TestBed.inject(DraftStore);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
    sessionStorage.clear();
    openWithHash('');
  });

  it('token read from hash and hash removed', async () => {
    expect(location.hash).toBe(`#${TOKEN}`);

    await harness.navigateByUrl(`/c#${TOKEN}`, ContributePage);
    expect(TestBed.inject(Router).url).toContain(TOKEN); // what the boot path hands the page
    fixture().detectChanges();

    // Gone from the address bar before any request has been made.
    expect(location.hash).toBe('');
    expect(location.href).not.toContain(TOKEN);
    const info = http.expectOne('/api/v1/contribute/info');
    expect(info.request.headers.get('X-Contributor-Token')).toBe(TOKEN);
    info.flush(INFO);
    await settle();
  });

  it('token is gone from the router state too, not only from the address bar', async () => {
    await open();

    const router = TestBed.inject(Router);
    const route = harness.routeDebugElement!.injector.get(ActivatedRoute);
    expect(router.url).toBe('/c');
    expect(router.url).not.toContain(TOKEN);
    expect(router.serializeUrl(router.parseUrl(router.url))).not.toContain(TOKEN);
    expect(route.snapshot.fragment).toBeNull();
    expect(location.hash).toBe('');
    expect(el().querySelector('form')).not.toBeNull(); // the page was kept, not rebuilt or cancelled
  });

  it('token sent in header, never in url', async () => {
    await open();

    await fillAndSubmit();
    const post = postRequest();
    expect(post.request.headers.get('X-Contributor-Token')).toBe(TOKEN);
    expect(post.request.url).not.toContain(TOKEN);
    expect(post.request.urlWithParams).not.toContain(TOKEN);
    expect(JSON.stringify(post.request.body)).not.toContain(TOKEN);
    // An admin signed in on this browser must not leak their bearer to the contributor endpoints.
    expect(post.request.headers.has('Authorization')).toBeFalse();
    post.flush({ person_id: 'p-1' }, { status: 201, statusText: 'Created' });
    await settle();

    // Nowhere the token could be kept or shown.
    expect(text()).not.toContain(TOKEN);
    expect(Object.keys(localStorage).concat(Object.keys(sessionStorage)).join()).not.toContain(TOKEN);
    expect(Object.values(localStorage).join()).not.toContain(TOKEN);
    expect(TestBed.inject(Router).url).not.toContain(TOKEN);
  });

  it('sends the info request with the token header and no bearer', async () => {
    await harness.navigateByUrl(`/c#${TOKEN}`, ContributePage);
    fixture().detectChanges();

    const info = http.expectOne('/api/v1/contribute/info');
    expect(info.request.method).toBe('GET');
    expect(info.request.headers.get('X-Contributor-Token')).toBe(TOKEN);
    expect(info.request.urlWithParams).not.toContain(TOKEN);
    expect(info.request.headers.has('Authorization')).toBeFalse();
    info.flush(INFO);
  });

  it('greets the contributor by name, with only the language switch in the header', async () => {
    await open();

    // The name is isolated (U+2068 ... U+2069), so it keeps its own direction inside the sentence.
    expect(el().querySelector('h1')?.textContent).toContain('Hello, \u2068Karim Adel\u2069');
    expect(el().querySelector('app-language-switch')).not.toBeNull();
    expect(el().querySelector('nav, app-shell, [routerlink]')).toBeNull();
    expect(text()).not.toContain('Sign out');
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('404 shows expired message', async () => {
    drafts.save('contribute', { nameLatin: 'Left over' });

    await open({ status: 404, body: linkNotFound });

    expect(text()).toContain(EXPIRED_EN);
    expect(el().querySelector('form')).toBeNull();
    // A draft must not outlive the link it was typed under.
    expect(drafts.load('contribute')).toBeNull();
  });

  it('shows the expired message in Arabic, from i18n', async () => {
    TestBed.inject(LocaleService).setLocale('ar');

    await open({ status: 404, body: linkNotFound });

    expect(text()).toContain(EXPIRED_AR);
    expect(text()).not.toContain('Link not found.');
  });

  it('asks to open the link from the message again when there is no token at all', async () => {
    openWithHash('');

    await open(null, '/c');

    expect(text()).toContain(NO_TOKEN_EN);
    expect(text()).not.toContain(EXPIRED_EN);
    expect(el().querySelector('form')).toBeNull();
    http.expectNone(() => true);
  });

  it('keeps the token for this tab only', async () => {
    await open();

    expect(sessionStorage.getItem('connections.contributeToken')).toBe(TOKEN);
    expect(JSON.stringify(localStorage)).not.toContain(TOKEN);
  });

  it('still works after a reload: the fragment is gone, the tab kept the token', async () => {
    sessionStorage.setItem('connections.contributeToken', TOKEN);
    openWithHash('');

    await harness.navigateByUrl('/c', ContributePage);
    fixture().detectChanges();

    const info = http.expectOne('/api/v1/contribute/info');
    expect(info.request.headers.get('X-Contributor-Token')).toBe(TOKEN);
    info.flush(INFO);
    await settle();
    expect(el().querySelector('form')).not.toBeNull();
  });

  it('forgets the kept token when the link is dead', async () => {
    await open({ status: 404, body: linkNotFound });

    expect(sessionStorage.getItem('connections.contributeToken')).toBeNull();
  });

  it('treats a malformed token as an expired link without calling the server', async () => {
    openWithHash('#bad token%0d%0aX-Evil: 1');

    await open(null, '/c#bad%20token');

    expect(text()).toContain(EXPIRED_EN);
    expect(location.hash).toBe('');
    http.expectNone(() => true);
  });

  it('a link that dies while the form is open shows expired and clears the draft', async () => {
    await open();
    drafts.save('contribute', { nameLatin: 'Old draft' });

    await fillAndSubmit();
    postRequest().flush(linkNotFound, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(text()).toContain(EXPIRED_EN);
    expect(el().querySelector('form')).toBeNull();
    expect(drafts.load('contribute')).toBeNull();
  });

  it('submitted people listed in session only', async () => {
    await open();
    expect(el().querySelector('.session-list')).toBeNull();

    await addPerson('Sara Ali', 'Designer');

    expect(text()).toContain('Added \u2068Sara Ali\u2069');
    const items = Array.from(el().querySelectorAll('.session-list li'));
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('Sara Ali');
    expect(items[0].textContent).toContain('Designer');

    // Add another: a fresh, empty form, with the first person still listed.
    (el().querySelector('button.add-another') as HTMLButtonElement).click();
    fixture().detectChanges();
    expect(field('nameLatin').value).toBe('');
    await addPerson('Omar Said');
    expect(el().querySelectorAll('.session-list li').length).toBe(2);

    // Nothing was read back from the server: the only calls were info and the two posts.
    http.expectNone(() => true);

    // And nothing is kept: a new visit starts with an empty list.
    expect(Object.values(localStorage).join()).not.toContain('Sara Ali');
    expect(Object.values(sessionStorage).join()).not.toContain('Sara Ali');
  });

  it('sends the person and strength only: no admin notes, no connected-to, no connection note', async () => {
    await open();

    setText('nameAr', 'سارة علي');
    setText('headline', 'Brand designer');
    chooseStrength('strong');
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture().whenStable();

    const post = postRequest();
    expect(post.request.method).toBe('POST');
    const body = post.request.body as { person: Record<string, unknown>; strength: string } & Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['person', 'strength']);
    expect(body.strength).toBe('strong');
    expect(body.person['name_ar']).toBe('سارة علي');
    expect(body.person['headline']).toBe('Brand designer');
    expect('admin_notes' in body.person).toBeFalse();
    post.flush({ person_id: 'p-1' }, { status: 201, statusText: 'Created' });
    await settle();
  });

  it('hides the admin-only fields but still asks for the strength', async () => {
    await open();

    expect(el().querySelector('[formcontrolname="adminNotes"]')).toBeNull();
    expect(el().querySelector('[formcontrolname="connectionNote"]')).toBeNull();
    expect(el().querySelector('app-person-picker')).toBeNull();
    expect(el().querySelector('mat-radio-group')).not.toBeNull();
    expect(text()).toContain('Anyone you could message who would know who you are.');

    setText('nameLatin', 'Sara Ali');
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(text()).toContain('Choose the connection strength.');
    http.expectNone(() => true);
  });

  it('failed submit keeps a draft', async () => {
    await open();

    await fillAndSubmit('Sara Ali', 'weak');
    postRequest().error(new ProgressEvent('error'), { status: 0 });
    await settle();

    expect(drafts.load<{ nameLatin: string; strength: string }>('contribute')?.nameLatin).toBe('Sara Ali');
    expect(drafts.load<{ strength: string }>('contribute')?.strength).toBe('weak');
    expect(text()).toContain('kept on this device');
    expect(el().querySelector('button.retry')).not.toBeNull();
    // Still the form, nothing listed as added.
    expect(el().querySelector('.session-list')).toBeNull();
  });

  it('keeps a draft after a server error, and a retry that works clears it', async () => {
    await open();

    await fillAndSubmit();
    postRequest().flush(null, { status: 503, statusText: 'Unavailable' });
    await settle();
    expect(drafts.load('contribute')).not.toBeNull();

    (el().querySelector('button.retry') as HTMLButtonElement).click();
    await fixture().whenStable();
    postRequest().flush({ person_id: 'p-1' }, { status: 201, statusText: 'Created' });
    await settle();

    expect(drafts.load('contribute')).toBeNull();
    expect(el().querySelectorAll('.session-list li').length).toBe(1);
  });

  /** The SHA-256 of a token as lowercase hex, computed here independently of the page. */
  async function digestOf(token: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('restores a draft saved earlier under the same link', async () => {
    drafts.save('contribute', {
      nameLatin: 'Half typed',
      strength: 'normal',
      draftOwner: await digestOf(TOKEN),
      savedAt: new Date().toISOString(),
    });

    await open();

    expect(field('nameLatin').value).toBe('Half typed');
  });

  it('drops a draft typed under another contributor\'s link', async () => {
    drafts.save('contribute', {
      nameLatin: 'Someone else\'s contact',
      draftOwner: await digestOf('ANOTHER_TOKEN_xyz'),
      savedAt: new Date().toISOString(),
    });

    await open();

    expect(field('nameLatin').value).toBe('');
    expect(drafts.load('contribute')).toBeNull();
  });

  it('drops a draft typed under another link that has the same display name', async () => {
    // Two contributors can share a display name: the name must not decide whose draft it is.
    drafts.save('contribute', {
      nameLatin: 'Other Karim\'s contact',
      draftOwner: await digestOf('A_DIFFERENT_LINK_same_name'),
      savedAt: new Date().toISOString(),
    });

    await open(); // INFO names "Karim Adel", the same name the other link would show

    expect(field('nameLatin').value).toBe('');
    expect(drafts.load('contribute')).toBeNull();
  });

  it('drops a draft owned by a display name, the way older versions saved it', async () => {
    drafts.save('contribute', {
      nameLatin: 'Left by an older version',
      draftOwner: INFO.contributor_display_name,
      savedAt: new Date().toISOString(),
    });

    await open();

    expect(field('nameLatin').value).toBe('');
    expect(drafts.load('contribute')).toBeNull();
  });

  it('keeps the draft under a digest of the token, never the token itself', async () => {
    await open();
    await fillAndSubmit('Sara Ali');
    postRequest().flush(null, { status: 500, statusText: 'Server Error' });
    await settle();

    const stored = drafts.load<{ draftOwner?: string }>('contribute');
    expect(stored?.draftOwner).toBe(await digestOf(TOKEN));
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(localStorage.getItem('connections.draft.contribute')).not.toContain(TOKEN);
  });

  it('sends an Idempotency-Key with each person, and the same one on a retry', async () => {
    await open();

    await fillAndSubmit();
    const first = postRequest();
    const key = first.request.headers.get('Idempotency-Key');
    expect(key).toBeTruthy();
    first.error(new ProgressEvent('error'));
    await settle();

    (el().querySelector('button.retry') as HTMLButtonElement).click();
    const retry = postRequest();
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    retry.flush({ person_id: 'p-new' }, { status: 201, statusText: 'Created' });
    await settle();
  });

  it('locks the form after a failed save; Retry resends the same body with the same key', async () => {
    await open();

    await fillAndSubmit('Sara Ali', 'weak');
    const first = postRequest();
    const body = first.request.body;
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'));
    await settle();

    expect(field('nameLatin').disabled).toBeTrue();
    expect(el().querySelector('.locked-note')).not.toBeNull();
    (el().querySelector('button.retry') as HTMLButtonElement).click();
    const retry = postRequest();
    expect(retry.request.body).toEqual(body);
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    retry.flush({ person_id: 'p-new' }, { status: 201, statusText: 'Created' });
    await settle();
  });

  it('too many requests says to wait a minute and keeps nothing to retry', async () => {
    await open();

    await fillAndSubmit();
    postRequest().flush(
      { code: 'rate_limited', message: 'Rate limit exceeded: 5 per 1 minute', details: null, trace_id: 't' },
      { status: 429, statusText: 'Too Many Requests' },
    );
    await settle();

    expect(text()).toContain('Too many tries. Wait a minute, then try again.');
    expect(text()).not.toContain('Rate limit exceeded');
    // What was typed may stay as an editable draft; not as a submission to resend with its key.
    expect(drafts.load<{ idempotencyKey?: string }>('contribute')?.idempotencyKey).toBeUndefined();
    expect(el().querySelector('form')).not.toBeNull();
  });

  it('too many requests on opening the page offers a retry', async () => {
    await open({ status: 429, body: { code: 'rate_limited', message: 'x', details: null, trace_id: null } });

    expect(text()).toContain('Too many tries. Wait a minute, then try again.');
    expect(el().querySelector('form')).toBeNull();

    (el().querySelector('button.retry-load') as HTMLButtonElement).click();
    http.expectOne('/api/v1/contribute/info').flush(INFO);
    await settle();

    expect(el().querySelector('form')).not.toBeNull();
  });

  it('an unreachable server on opening shows a retry, not the expired message', async () => {
    await open({ status: 503 });

    expect(text()).toContain('Could not reach the server. Try again.');
    expect(text()).not.toContain(EXPIRED_EN);
    expect(drafts.load('contribute')).toBeNull();
  });

  it('suggests tags through the contributor endpoint with the token header', async () => {
    await open();
    (el().querySelector('details.more summary') as HTMLElement).click();
    fixture().detectChanges();

    const input = el().querySelector('app-tag-input input') as HTMLInputElement;
    input.value = 'des';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const tags = http.expectOne((r) => r.url === '/api/v1/contribute/tags');
    expect(tags.request.params.get('kind')).toBe('skill');
    expect(tags.request.params.get('q')).toBe('des');
    expect(tags.request.headers.get('X-Contributor-Token')).toBe(TOKEN);
    expect(tags.request.urlWithParams).not.toContain(TOKEN);
    expect(tags.request.headers.has('Authorization')).toBeFalse();
    tags.flush([{ label: 'Design', category: 'arts_literature' }]);
  });

  it('never asks for tag suggestions with a contact value', async () => {
    await open();
    (el().querySelector('details.more summary') as HTMLElement).click();
    fixture().detectChanges();

    const input = el().querySelector('app-tag-input input') as HTMLInputElement;
    input.value = 'Sara 01012345678';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(http.match((r) => r.url === '/api/v1/contribute/tags').length).toBe(0);
  });
});
