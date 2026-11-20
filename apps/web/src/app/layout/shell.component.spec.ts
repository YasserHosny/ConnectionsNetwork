import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';

import { AuthService } from '../core/auth.service';
import { LocaleService } from '../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../testing/test-helpers';
import { ShellComponent } from './shell.component';

describe('ShellComponent', () => {
  let fixture: ComponentFixture<ShellComponent>;
  let auth: ReturnType<typeof fakeAuthService>;
  let locale: LocaleService;

  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    auth = fakeAuthService(fakeSession('aal2'));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideTranslateService(), { provide: AuthService, useValue: auth }],
    });
    loadCatalogues();
    locale = TestBed.inject(LocaleService);
    fixture = TestBed.createComponent(ShellComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('dir');
    document.documentElement.removeAttribute('lang');
  });

  it('shows the app name, in Arabic by default', () => {
    expect(el().querySelector('.app-name')?.textContent).toBe('شبكة المعارف');
  });

  it('has a navigation entry for each section', () => {
    const links = Array.from(el().querySelectorAll('nav a')).map((a) => a.getAttribute('href'));

    expect(links).toEqual(['/search', '/add', '/review', '/links', '/export']);
  });

  it('switches the language from the top bar', () => {
    const button = el().querySelector('app-language-switch button') as HTMLButtonElement;
    expect(button.textContent).toContain('English');

    button.click();
    fixture.detectChanges();

    expect(locale.locale()).toBe('en');
    expect(el().querySelector('.app-name')?.textContent).toBe('Connections');
    expect(button.textContent).toContain('العربية');
  });

  it('signs out and returns to /login', async () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    const signOut = Array.from(el().querySelectorAll('mat-toolbar button')).find((b) =>
      b.textContent?.includes('تسجيل الخروج'),
    ) as HTMLButtonElement;

    signOut.click();
    await fixture.whenStable();

    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login');
  });
});
