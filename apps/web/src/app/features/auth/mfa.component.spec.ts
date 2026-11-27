import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';

import { AuthError, AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues } from '../../testing/test-helpers';
import { MfaComponent } from './mfa.component';

describe('MfaComponent', () => {
  let auth: ReturnType<typeof fakeAuthService>;
  let navigate: jasmine.Spy;

  const QR = 'data:image/svg+xml;utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';

  async function create(): Promise<ComponentFixture<MfaComponent>> {
    const fixture = TestBed.createComponent(MfaComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  async function submitCode(fixture: ComponentFixture<MfaComponent>, code: string): Promise<void> {
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('input') as HTMLInputElement;
    input.value = code;
    input.dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    auth = fakeAuthService(fakeSession('aal1'));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideTranslateService(), { provide: AuthService, useValue: auth }],
    });
    loadCatalogues();
    navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    TestBed.inject(LocaleService).setLocale('en');
  });

  afterEach(() => localStorage.clear());

  it('goes back to /login when there is no session', async () => {
    auth.current.set(null);

    await create();

    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('shows the QR code and secret when the person has no verified factor', async () => {
    auth.nextStep.and.resolveTo('enroll');
    auth.enrollTotp.and.resolveTo({ qrCode: QR, secret: 'JBSWY3DPEHPK3PXP' });

    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('h1')?.textContent).toContain('Set up two-step verification');
    expect(el.querySelector('img.qr')?.getAttribute('src')).toBe(QR);
    expect(el.querySelector('.secret')?.textContent).toBe('JBSWY3DPEHPK3PXP');
  });

  it('asks only for a code when a verified factor exists', async () => {
    auth.nextStep.and.resolveTo('verify');

    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('h1')?.textContent).toContain('Two-step verification');
    expect(el.querySelector('img.qr')).toBeNull();
    expect(auth.enrollTotp).not.toHaveBeenCalled();
  });

  it('verifies the code and continues into the app', async () => {
    auth.nextStep.and.resolveTo('verify');
    auth.verifyTotp.and.resolveTo();

    const fixture = await create();
    await submitCode(fixture, '123456');

    expect(auth.verifyTotp).toHaveBeenCalledWith('123456');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('says so when the code is wrong', async () => {
    auth.nextStep.and.resolveTo('verify');
    auth.verifyTotp.and.rejectWith(new AuthError('invalid_code'));

    const fixture = await create();
    await submitCode(fixture, '000000');

    expect((fixture.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent).toContain(
      'wrong or has expired',
    );
    expect(navigate).not.toHaveBeenCalledWith('/');
  });

  it('rejects a code that is not six digits without calling the server', async () => {
    auth.nextStep.and.resolveTo('verify');

    const fixture = await create();
    await submitCode(fixture, '12ab');

    expect(auth.verifyTotp).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent).toContain(
      'Enter the 6-digit code.',
    );
  });

  it('offers a retry when the account cannot be checked', async () => {
    auth.nextStep.and.rejectWith(new AuthError('unknown'));

    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[role=alert]')?.textContent).toContain('Verification failed');
    auth.nextStep.and.resolveTo('verify');
    (el.querySelector('button[mat-stroked-button]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('h1')?.textContent).toContain('Two-step verification');
  });

  it('signs out and returns to /login, even if sign-out throws', async () => {
    auth.nextStep.and.resolveTo('verify');
    spyOn(console, 'error');
    auth.signOut.and.rejectWith(new Error('boom'));
    const fixture = await create();
    const signOut = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Sign out'),
    ) as HTMLButtonElement;

    signOut.click();
    await fixture.whenStable();

    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login');
  });
});

describe('MfaComponent, returning to where the admin was', () => {
  it('keeps the destination when the session is gone and it sends the admin to sign in', async () => {
    const auth = fakeAuthService();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideTranslateService(),
        { provide: AuthService, useValue: auth },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ next: '/people/p-7' }) } } },
      ],
    });
    loadCatalogues();
    const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    const fixture = TestBed.createComponent(MfaComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith('/login?next=%2Fpeople%2Fp-7');
  });

  it('goes back to the page once the code is verified', async () => {
    const auth = fakeAuthService(fakeSession('aal1'));
    auth.nextStep.and.resolveTo('verify');
    auth.verifyTotp.and.resolveTo();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideTranslateService(),
        { provide: AuthService, useValue: auth },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ next: '/people/p-7' }) } } },
      ],
    });
    loadCatalogues();
    const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    const fixture = TestBed.createComponent(MfaComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('input') as HTMLInputElement;
    input.value = '123456';
    input.dispatchEvent(new Event('input'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith('/people/p-7');
  });
});
