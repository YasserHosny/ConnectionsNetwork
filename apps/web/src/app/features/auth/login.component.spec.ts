import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';

import { AuthError, AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, loadCatalogues } from '../../testing/test-helpers';
import { LoginComponent } from './login.component';

describe('LoginComponent', () => {
  let fixture: ComponentFixture<LoginComponent>;
  let auth: ReturnType<typeof fakeAuthService>;
  let navigate: jasmine.Spy;

  const el = () => fixture.nativeElement as HTMLElement;

  async function submit(email = 'me@example.com', password = 'secret'): Promise<void> {
    const inputs = el().querySelectorAll('input');
    inputs[0].value = email;
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = password;
    inputs[1].dispatchEvent(new Event('input'));
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    auth = fakeAuthService();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideTranslateService(), { provide: AuthService, useValue: auth }],
    });
    loadCatalogues();
    navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    TestBed.inject(LocaleService).setLocale('en');
    fixture = TestBed.createComponent(LoginComponent);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('shows the sign-in form in the chosen language', () => {
    expect(el().querySelector('h1')?.textContent).toContain('Sign in');
  });

  it('goes to /mfa when TOTP is still to do', async () => {
    auth.signIn.and.resolveTo('enroll');

    await submit();

    expect(auth.signIn).toHaveBeenCalledWith('me@example.com', 'secret');
    expect(navigate).toHaveBeenCalledWith('/mfa');
  });

  it('goes straight in when the session is already aal2', async () => {
    auth.signIn.and.resolveTo('done');

    await submit();

    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('says so when the credentials are wrong', async () => {
    auth.signIn.and.rejectWith(new AuthError('invalid_credentials'));

    await submit();

    expect(el().querySelector('[role=alert]')?.textContent).toContain('The email or password is wrong.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not call the server with an empty form', async () => {
    await submit('', '');

    expect(auth.signIn).not.toHaveBeenCalled();
    expect(el().querySelector('[role=alert]')?.textContent).toContain('Enter your email and password.');
  });
});

describe('LoginComponent, returning to where the admin was', () => {
  function signInWith(next: string | null, step: 'done' | 'enroll'): Promise<jasmine.Spy> {
    const auth = fakeAuthService();
    auth.signIn.and.resolveTo(step);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideTranslateService(),
        { provide: AuthService, useValue: auth },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(next ? { next } : {}) } } },
      ],
    });
    loadCatalogues();
    const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    const fixture = TestBed.createComponent(LoginComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const inputs = el.querySelectorAll('input');
    inputs[0].value = 'me@example.com';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = 'secret';
    inputs[1].dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    return fixture.whenStable().then(() => navigate);
  }

  it('goes back to the page after signing in', async () => {
    expect(await signInWith('/people/p-7', 'done')).toHaveBeenCalledWith('/people/p-7');
  });

  it('carries it through the MFA step', async () => {
    expect(await signInWith('/people/p-7', 'enroll')).toHaveBeenCalledWith('/mfa?next=%2Fpeople%2Fp-7');
  });

  it('never follows a next that leaves the app', async () => {
    expect(await signInWith('//evil.example/x', 'done')).toHaveBeenCalledWith('/');
  });
});
