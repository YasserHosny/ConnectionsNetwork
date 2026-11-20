import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import type { DuplicatePair } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues, waitFor } from '../../testing/test-helpers';
import { DuplicatesPage } from './duplicates.page';

const PAIR: DuplicatePair = {
  a: { person_id: 'a-1', display_name: 'Sara Mahmoud', profession: 'Marketing', city: 'Cairo' },
  b: { person_id: 'b-1', display_name: 'Sarah M.', profession: null, city: null },
  matched_on: ['phone', 'email'],
};
const OTHER: DuplicatePair = {
  a: { person_id: 'c-1', display_name: 'Omar Ali', profession: null, city: 'Giza' },
  b: { person_id: 'd-1', display_name: 'Omar A.', profession: null, city: null },
  matched_on: ['social_link'],
};

describe('DuplicatesPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const dialog = () => document.querySelector('mat-dialog-container');
  const dialogButton = (cls: string) => dialog()?.querySelector(`button.${cls}`) as HTMLButtonElement | null;
  const sides = () => Array.from(el().querySelectorAll('.pair')[0].querySelectorAll('.side'));
  const keepButton = (side: number) => sides()[side].querySelector('button.keep') as HTMLButtonElement;

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  async function open(pairs: DuplicatePair[] = [PAIR]): Promise<void> {
    await harness.navigateByUrl('/review/duplicates', DuplicatesPage);
    fixture().detectChanges();
    http.expectOne('/api/v1/duplicates').flush(pairs);
    await settle();
  }

  async function closeDialog(): Promise<void> {
    await waitFor(fixture(), () => !dialog());
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'review/duplicates', component: DuplicatesPage },
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

  it('shows each pair side by side with the reasons they match', async () => {
    await open();

    expect(el().querySelectorAll('.pair').length).toBe(1);
    const [left, right] = sides();
    expect(left.textContent).toContain('Sara Mahmoud');
    expect(left.textContent).toContain('Marketing');
    expect(left.textContent).toContain('Cairo');
    expect(right.textContent).toContain('Sarah M.');
    expect(left.querySelector('a')?.getAttribute('href')).toBe('/people/a-1');
    expect(right.querySelector('a')?.getAttribute('href')).toBe('/people/b-1');
    const reasons = el().querySelector('.reasons')?.textContent ?? '';
    expect(reasons).toContain('Same phone number');
    expect(reasons).toContain('Same email');
  });

  it('says so when there are no possible duplicates', async () => {
    await open([]);

    expect(el().querySelector('.empty')?.textContent).toContain('No possible duplicates');
    expect(el().querySelector('.pair')).toBeNull();
  });

  for (const [side, keep, drop] of [
    [0, 'a-1', 'b-1'],
    [1, 'b-1', 'a-1'],
  ] as const) {
    it(`merge sends keep/drop matching the chosen side (side ${side + 1})`, async () => {
      await open();

      keepButton(side).click();
      const confirmButton = await waitFor(fixture(), () => dialogButton('dialog-confirm'));
      http.expectNone((r) => r.method === 'POST');

      confirmButton.click();
      const req = await waitFor(fixture(), () => http.match((r) => r.url === '/api/v1/duplicates/merge')[0]);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ keep, drop });
      req.flush({ id: keep });
      await settle();

      http.expectOne('/api/v1/duplicates').flush([]);
      await settle();
      expect(el().querySelector('.empty')).not.toBeNull();
      expect(el().querySelector('.status')?.textContent).toContain('Merged');
    });
  }

  it('asks which record is kept and warns that merging cannot be undone', async () => {
    await open();

    keepButton(1).click();
    await waitFor(fixture(), () => dialog());

    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Keep Sarah M.?');
    expect(text).toContain('Sara Mahmoud is merged into Sarah M. and then deleted');
    expect(text).toContain('cannot be undone');
  });

  it('sends nothing when the merge is cancelled', async () => {
    await open();

    keepButton(0).click();
    (await waitFor(fixture(), () => dialogButton('dialog-cancel'))).click();
    await closeDialog();

    http.expectNone((r) => r.method === 'POST');
    expect(el().querySelectorAll('.pair').length).toBe(1);
  });

  it('dismisses a pair as two different people and drops it from the list', async () => {
    await open([PAIR, OTHER]);

    (el().querySelector('.pair button.dismiss') as HTMLButtonElement).click();

    const req = http.expectOne('/api/v1/duplicates/dismiss');
    expect(req.request.body).toEqual({ a: 'a-1', b: 'b-1' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();

    expect(el().querySelectorAll('.pair').length).toBe(1);
    expect(el().querySelector('.pair')?.textContent).toContain('Omar Ali');
    expect(el().querySelector('.status')?.textContent).toContain('different people');
  });

  it('explains that a record belonging to a sign-in account cannot be merged away', async () => {
    await open();

    keepButton(0).click();
    (await waitFor(fixture(), () => dialogButton('dialog-confirm'))).click();
    const req = await waitFor(fixture(), () => http.match((r) => r.url === '/api/v1/duplicates/merge')[0]);
    req.flush(
      { code: 'cannot_drop_account', message: 'English API text', details: null, trace_id: 't' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    const text = el().querySelector('.error')?.textContent ?? '';
    expect(text).toContain('sign-in account');
    expect(text).not.toContain('English API text');
    expect(el().querySelectorAll('.pair').length).toBe(1);
  });

  it('refreshes the list when a person in the pair is already gone', async () => {
    await open();

    (el().querySelector('.pair button.dismiss') as HTMLButtonElement).click();
    http.expectOne('/api/v1/duplicates/dismiss').flush(
      { code: 'validation.invalid_value', message: 'x', details: { field: 'a', reason: 'person_not_found' }, trace_id: 't' },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle();

    http.expectOne('/api/v1/duplicates').flush([OTHER]);
    await settle();
    expect(el().querySelector('.error')?.textContent).toContain('no longer exists');
    expect(el().querySelector('.pair')?.textContent).toContain('Omar Ali');
  });

  it('sends the admin to /mfa when the second step has lapsed', async () => {
    await open();

    (el().querySelector('.pair button.dismiss') as HTMLButtonElement).click();
    http.expectOne('/api/v1/duplicates/dismiss').flush(
      { code: 'mfa_required', message: 'x', details: null, trace_id: 't' },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();

    expect(router.url).toBe('/mfa');
  });

  it('offers a retry when the list cannot be loaded', async () => {
    await harness.navigateByUrl('/review/duplicates', DuplicatesPage);
    fixture().detectChanges();
    http.expectOne('/api/v1/duplicates').error(new ProgressEvent('error'));
    await settle();

    expect(el().querySelector('.load-error')?.textContent).toContain('Could not load');
    (el().querySelector('button.retry') as HTMLButtonElement).click();
    http.expectOne('/api/v1/duplicates').flush([PAIR]);
    await settle();

    expect(el().querySelectorAll('.pair').length).toBe(1);
  });
});

