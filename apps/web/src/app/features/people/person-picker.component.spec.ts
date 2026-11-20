import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { PersonPickerComponent } from './person-picker.component';

describe('PersonPickerComponent', () => {
  let fixture: ComponentFixture<PersonPickerComponent>;
  let http: HttpTestingController;

  const el = () => fixture.nativeElement as HTMLElement;

  function typeQuery(text: string): void {
    const input = el().querySelector('input') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: AuthService, useValue: fakeAuthService(fakeSession('aal2')) },
      ],
    });
    loadCatalogues();
    TestBed.inject(LocaleService).setLocale('en');
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PersonPickerComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('defaults to the admin', () => {
    expect(fixture.componentInstance.value()).toBeNull();
    expect(el().querySelector('.selected')?.textContent).toContain('Me');
  });

  it('searches existing people by name after a pause and picks one', fakeAsync(() => {
    typeQuery('Sa');
    typeQuery('Sara');
    tick(299);
    http.expectNone(() => true);
    tick(1);

    const req = http.expectOne((r) => r.url === '/api/v1/search');
    expect(req.request.params.get('q')).toBe('Sara');
    req.flush([
      { person_id: 'p-1', display_name: 'Sara Ali', profession: 'Designer', city: 'Cairo' },
    ]);
    fixture.detectChanges();

    (el().querySelector('.results button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toEqual({ id: 'p-1', name: 'Sara Ali' });
    expect(el().querySelector('.selected')?.textContent).toContain('Sara Ali');
    expect(el().querySelector('.results')).toBeNull();
  }));

  it('does not search for a single character', fakeAsync(() => {
    typeQuery('S');
    tick(400);

    http.expectNone(() => true);
    expect(fixture.componentInstance.value()).toBeNull();
  }));

  it('goes back to the admin', () => {
    fixture.componentInstance.value.set({ id: 'p-1', name: 'Sara Ali' });
    fixture.detectChanges();

    (el().querySelector('button.reset') as HTMLButtonElement).click();

    expect(fixture.componentInstance.value()).toBeNull();
  });

  it('says so when the search fails', fakeAsync(() => {
    typeQuery('Sara');
    tick(300);
    http.expectOne((r) => r.url === '/api/v1/search').flush(null, { status: 500, statusText: 'x' });
    fixture.detectChanges();

    expect(el().querySelector('[role=alert]')?.textContent).toContain('Search is unavailable');
  }));
});
