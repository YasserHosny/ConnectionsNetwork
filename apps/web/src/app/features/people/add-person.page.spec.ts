import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { CreatePersonResponse, NewPersonRequest } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { DraftStore } from '../../core/draft.store';
import { LocaleService } from '../../core/locale.service';
import {
  ADMIN_PERSON_ID,
  fakeAuthService,
  fakeSession,
  loadCatalogues,
} from '../../testing/test-helpers';
import { AddPersonPage } from './add-person.page';

function createdPerson(id: string, duplicates: CreatePersonResponse['possible_duplicates'] = []) {
  return { person: { id, display_name: 'Sara Ali' }, possible_duplicates: duplicates } as CreatePersonResponse;
}

describe('AddPersonPage', () => {
  let fixture: ComponentFixture<AddPersonPage>;
  let http: HttpTestingController;
  let drafts: DraftStore;
  let navigate: jasmine.Spy;

  const el = () => fixture.nativeElement as HTMLElement;
  const nameInput = () => el().querySelector('[formcontrolname="nameLatin"]') as HTMLInputElement;

  function fillAndSubmit(): void {
    nameInput().value = 'Sara Ali';
    nameInput().dispatchEvent(new Event('input'));
    (el().querySelector('mat-radio-button[value="weak"] input') as HTMLInputElement).click();
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: AuthService, useValue: fakeAuthService(fakeSession('aal2')) },
      ],
    });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    http = TestBed.inject(HttpTestingController);
    drafts = TestBed.inject(DraftStore);
    navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  function open(): void {
    fixture = TestBed.createComponent(AddPersonPage);
    fixture.detectChanges();
  }

  it('opening add page restores a saved draft', () => {
    drafts.save('add-person', { nameLatin: 'Sara Draft', strength: 'strong' });

    open();

    expect(nameInput().value).toBe('Sara Draft');
    expect(el().querySelector('.draft-note')).not.toBeNull();
  });

  it('successful submit clears draft', async () => {
    drafts.save('add-person', { nameLatin: 'Sara Draft', strength: 'strong' });
    open();

    fillAndSubmit();
    const req = http.expectOne('/api/v1/people');
    expect(req.request.method).toBe('POST');
    const body = req.request.body as NewPersonRequest;
    expect(body.person.name_latin).toBe('Sara Ali');
    expect(body.strength).toBe('weak');
    expect(body.connect_to_person_id).toBe(ADMIN_PERSON_ID);
    req.flush(createdPerson('new-1'));
    await settle();

    expect(drafts.load('add-person')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/people/new-1', { state: { justAdded: true } });
  });

  it('retries a failed save with the same Idempotency-Key, so the person is created once', async () => {
    open();

    fillAndSubmit();
    const first = http.expectOne('/api/v1/people');
    const key = first.request.headers.get('Idempotency-Key');
    expect(key).toBeTruthy();
    first.error(new ProgressEvent('error'));
    await settle();

    (el().querySelector('button.retry') as HTMLButtonElement).click();
    const retry = http.expectOne('/api/v1/people');
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    retry.flush(createdPerson('new-1'));
    await settle();
  });

  it('keeps the draft when the save fails', async () => {
    open();

    fillAndSubmit();
    http.expectOne('/api/v1/people').error(new ProgressEvent('error'));
    await settle();

    expect((drafts.load('add-person') as { nameLatin: string }).nameLatin).toBe('Sara Ali');
    expect(el().querySelector('button.retry')).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('duplicate hints from the response are shown with a link to the existing person', async () => {
    open();

    fillAndSubmit();
    http.expectOne('/api/v1/people').flush(
      createdPerson('new-1', [
        { person_id: 'old-1', display_name: 'Sara A.', matched_on: 'phone' },
        { person_id: 'old-2', display_name: 'Sarah Ali', matched_on: 'social_link' },
      ]),
    );
    await settle();

    const links = Array.from(el().querySelectorAll<HTMLAnchorElement>('.duplicates a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/people/old-1', '/people/old-2']);
    expect(links[0].textContent).toContain('Sara A.');
    expect(el().querySelector('.duplicates')?.textContent).toContain('phone');
    expect(navigate).not.toHaveBeenCalled();
    expect(el().querySelector('a.open-person')?.getAttribute('href')).toBe('/people/new-1');
  });

  describe('someone already has the number typed', () => {
    const numberInput = () => el().querySelector('fieldset.contacts input.contact-value') as HTMLInputElement;

    function typeNumber(value: string): void {
      numberInput().value = value;
      numberInput().dispatchEvent(new Event('input'));
    }

    it('warns before saving, and saves only when Save is pressed again', async () => {
      open();
      typeNumber('0101 234 5678');
      fillAndSubmit();

      const check = http.expectOne('/api/v1/duplicates/check');
      expect(check.request.method).toBe('POST');
      expect(check.request.body).toEqual({
        contacts: [{ kind: 'whatsapp', value: '0101 234 5678' }],
        social_links: [],
      });
      check.flush([{ person_id: 'old-1', display_name: 'Sara A.', matched_on: 'whatsapp' }]);
      await settle();

      http.expectNone('/api/v1/people');
      const warning = el().querySelector('.precheck') as HTMLElement;
      expect(warning.querySelector('a')?.getAttribute('href')).toBe('/people/old-1');
      expect(warning.textContent).toContain('Sara A.');
      expect(warning.textContent).toContain('Save again');
      expect(navigate).not.toHaveBeenCalled();

      el().querySelector('form')?.dispatchEvent(new Event('submit'));
      http.expectNone('/api/v1/duplicates/check');
      http.expectOne('/api/v1/people').flush(createdPerson('new-1'));
      await settle();

      expect(navigate).toHaveBeenCalledWith('/people/new-1', { state: { justAdded: true } });
    });

    it('checks again when the number is changed after a warning', async () => {
      open();
      typeNumber('0101 234 5678');
      fillAndSubmit();
      http.expectOne('/api/v1/duplicates/check').flush([
        { person_id: 'old-1', display_name: 'Sara A.', matched_on: 'whatsapp' },
      ]);
      await settle();

      typeNumber('0109 999 9999');
      el().querySelector('form')?.dispatchEvent(new Event('submit'));

      http.expectOne('/api/v1/duplicates/check').flush([]);
      http.expectOne('/api/v1/people').flush(createdPerson('new-1'));
      await settle();
    });

    it('does not block the save when the check itself fails', async () => {
      open();
      typeNumber('0101 234 5678');
      fillAndSubmit();

      http.expectOne('/api/v1/duplicates/check').flush({ code: 'internal_error' }, { status: 500, statusText: 'x' });
      http.expectOne('/api/v1/people').flush(createdPerson('new-1'));
      await settle();

      expect(navigate).toHaveBeenCalledWith('/people/new-1', { state: { justAdded: true } });
    });

    it('forgets the warning and its confirmation when another person is started', async () => {
      open();
      typeNumber('0101 234 5678');
      fillAndSubmit();
      http.expectOne('/api/v1/duplicates/check').flush([
        { person_id: 'old-1', display_name: 'Sara A.', matched_on: 'whatsapp' },
      ]);
      await settle();
      el().querySelector('form')?.dispatchEvent(new Event('submit'));
      http
        .expectOne('/api/v1/people')
        .flush(createdPerson('new-1', [{ person_id: 'old-1', display_name: 'Sara A.', matched_on: 'whatsapp' }]));
      await settle();

      (el().querySelector('button.add-another') as HTMLButtonElement).click();
      await settle();
      expect(el().querySelector('.precheck')).toBeNull();

      typeNumber('0101 234 5678');
      fillAndSubmit();
      http.expectOne('/api/v1/duplicates/check').flush([
        { person_id: 'old-1', display_name: 'Sara A.', matched_on: 'whatsapp' },
      ]);
      await settle();
      http.expectNone('/api/v1/people');
    });

    it('is skipped for a retry of a create that may already have gone through', async () => {
      open();
      typeNumber('0101 234 5678');
      fillAndSubmit();
      http.expectOne('/api/v1/duplicates/check').flush([]);
      const first = http.expectOne('/api/v1/people');
      const key = first.request.headers.get('Idempotency-Key');
      first.error(new ProgressEvent('error'));
      await settle();

      (el().querySelector('button.retry') as HTMLButtonElement).click();

      http.expectNone('/api/v1/duplicates/check');
      const retry = http.expectOne('/api/v1/people');
      expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
      retry.flush(createdPerson('new-1'));
      await settle();
    });

    for (const [what, status, body] of [
      ['the session ended', 401, { code: 'auth.unauthenticated', message: 'x' }],
      ['the MFA step lapsed', 403, { code: 'mfa_required', message: 'x' }],
    ] as const) {
      it(`keeps the entry and saves nothing when ${what} during the check`, async () => {
        open();
        typeNumber('0101 234 5678');
        fillAndSubmit();

        http.expectOne('/api/v1/duplicates/check').flush(body, { status, statusText: 'x' });
        await settle();

        http.expectNone('/api/v1/people');
        expect((drafts.load('add-person') as { nameLatin: string }).nameLatin).toBe('Sara Ali');
      });
    }

    it('is not asked when no number or link was typed', async () => {
      open();
      fillAndSubmit();

      http.expectNone('/api/v1/duplicates/check');
      http.expectOne('/api/v1/people').flush(createdPerson('new-1'));
      await settle();
    });
  });

  it('connects to the person picked in "Connected to"', async () => {
    open();
    fixture.debugElement.query((d) => d.name === 'app-person-picker').componentInstance.value.set({
      id: 'p-9',
      name: 'Omar',
    });

    fillAndSubmit();
    const req = http.expectOne('/api/v1/people');
    expect((req.request.body as NewPersonRequest).connect_to_person_id).toBe('p-9');
    req.flush(createdPerson('new-1'));
    await settle();
  });
});
