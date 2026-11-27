import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';

import { fakeAuthService, fakeSession } from '../testing/test-helpers';
import { AuthService } from './auth.service';
import { mfaGuard } from './mfa.guard';

describe('mfaGuard', () => {
  let auth: ReturnType<typeof fakeAuthService>;

  beforeEach(() => {
    auth = fakeAuthService();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
  });

  function run(url: string): boolean | UrlTree {
    return TestBed.runInInjectionContext(
      () =>
        mfaGuard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot) as boolean | UrlTree,
    );
  }

  function redirectTarget(result: boolean | UrlTree): string {
    expect(result instanceof UrlTree).toBeTrue();
    return TestBed.inject(Router).serializeUrl(result as UrlTree);
  }

  it('redirects aal1 to /mfa', () => {
    auth.current.set(fakeSession('aal1'));

    expect(redirectTarget(run('/search'))).toBe('/mfa?next=%2Fsearch');
  });

  it('redirects no session to /login', () => {
    expect(redirectTarget(run('/search'))).toBe('/login?next=%2Fsearch');
  });

  it('remembers where the admin was going, for after signing in', () => {
    expect(redirectTarget(run('/people/p-7'))).toBe('/login?next=%2Fpeople%2Fp-7');
    auth.current.set(fakeSession('aal1'));
    expect(redirectTarget(run('/people/p-7'))).toBe('/mfa?next=%2Fpeople%2Fp-7');
  });

  it('allows aal2', () => {
    auth.current.set(fakeSession('aal2'));

    expect(run('/search')).toBeTrue();
  });

  it('allows /c without session', () => {
    expect(run('/c')).toBeTrue();
  });

  it('allows /c when the contributor token rides in the fragment', () => {
    expect(run('/c#0123456789abcdef')).toBeTrue();
  });

  it('allows /login and /mfa without MFA', () => {
    expect(run('/login')).toBeTrue();
    expect(run('/mfa')).toBeTrue();
    auth.current.set(fakeSession('aal1'));
    expect(run('/login?next=1')).toBeTrue();
    expect(run('/mfa')).toBeTrue();
  });

  it('does not treat a path that merely starts with /c as the contributor page', () => {
    expect(redirectTarget(run('/contacts'))).toBe('/login?next=%2Fcontacts');
    expect(redirectTarget(run('/login-help'))).toBe('/login?next=%2Flogin-help');
  });
});
