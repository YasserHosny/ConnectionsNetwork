import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { PersonInput, PersonOut } from '@connections/domain-types';

import { AuthService } from '../../core/auth.service';
import { DraftStore } from '../../core/draft.store';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { EditPersonPage } from './edit-person.page';

const PERSON = {
  id: 'p-7',
  name_ar: null,
  name_latin: 'Omar Said',
  headline: 'Engineer',
  organization: null,
  profession: null,
  seniority: 'manager',
  available_for: ['freelance'],
  city: 'Cairo',
  country: null,
  admin_notes: 'met at a wedding',
  skills: [{ tag_id: 't1', label: 'Python', category: 'technical', level: 'good' }],
  industries: [{ tag_id: 't2', label: 'Banking' }],
  social_links: [{ id: 's1', kind: 'github', url: 'https://github.com/omar' }],
  contacts: [{ id: 'c1', kind: 'phone', value: '01012345678', added_by_person_id: null }],
} as unknown as PersonOut;

describe('EditPersonPage', () => {
  let fixture: ComponentFixture<EditPersonPage>;
  let http: HttpTestingController;
  let navigate: jasmine.Spy;
  let routeId = 'p-7';

  const el = () => fixture.nativeElement as HTMLElement;

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function open(id = 'p-7'): Promise<void> {
    routeId = id;
    fixture = TestBed.createComponent(EditPersonPage);
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
        {
          provide: ActivatedRoute,
          useFactory: () => ({ snapshot: { paramMap: convertToParamMap({ id: routeId }) } }),
        },
        { provide: AuthService, useValue: fakeAuthService(fakeSession('aal2')) },
      ],
    });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    http = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('loads the person into the form and saves every field back with PUT', async () => {
    await open();
    http.expectOne('/api/v1/people/p-7').flush(PERSON);
    await settle();

    const nameLatin = el().querySelector('[formcontrolname="nameLatin"]') as HTMLInputElement;
    expect(nameLatin.value).toBe('Omar Said');
    expect(el().textContent).toContain('Python');

    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/v1/people/p-7');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body as PersonInput).toEqual({
      name_ar: null,
      name_latin: 'Omar Said',
      headline: 'Engineer',
      organization: null,
      profession: null,
      seniority: 'manager',
      available_for: ['freelance'],
      city: 'Cairo',
      country: null,
      admin_notes: 'met at a wedding',
      skills: [{ label: 'Python', category: 'technical', level: 'good' }],
      industries: ['Banking'],
      social_links: [{ kind: 'github', url: 'https://github.com/omar' }],
      contacts: [{ kind: 'phone', value: '01012345678' }],
    });
    req.flush(PERSON);
    await settle();

    expect(navigate).toHaveBeenCalledWith('/people/p-7');
  });

  it('uses its own draft key per person', async () => {
    TestBed.inject(DraftStore).save('edit-person:p-7', { nameLatin: 'Omar Draft' });
    await open();
    http.expectOne('/api/v1/people/p-7').flush(PERSON);
    await settle();

    const nameLatin = el().querySelector('[formcontrolname="nameLatin"]') as HTMLInputElement;
    expect(nameLatin.value).toBe('Omar Draft');
  });

  it('says so when the person does not exist', async () => {
    await open('nope');
    http
      .expectOne('/api/v1/people/nope')
      .flush(
        { code: 'not_found', message: 'Resource was not found.', details: null, trace_id: 't' },
        { status: 404, statusText: 'Not Found' },
      );
    await settle();

    expect(el().querySelector('form')).toBeNull();
    expect(el().querySelector('[role=alert]')?.textContent).toContain('was not found');
  });

  it('offers a retry when the person cannot be loaded', async () => {
    await open();
    http.expectOne('/api/v1/people/p-7').error(new ProgressEvent('error'));
    await settle();

    (el().querySelector('button.retry') as HTMLButtonElement).click();
    http.expectOne('/api/v1/people/p-7').flush(PERSON);
    await settle();

    expect(el().querySelector('form')).not.toBeNull();
  });
});
