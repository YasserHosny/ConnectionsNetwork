import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';

import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import { ContributePage } from './features/contribute/contribute.page';
import { fakeAuthService, fakeSession, loadCatalogues } from './testing/test-helpers';

describe('app routes', () => {
  let auth: ReturnType<typeof fakeAuthService>;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    auth = fakeAuthService();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: AuthService, useValue: auth },
      ],
    });
    loadCatalogues();
    harness = await RouterTestingHarness.create();
  });

  const url = () => TestBed.inject(Router).url;

  it('serves the contributor page at /c with no session', async () => {
    const component = await harness.navigateByUrl('/c');

    expect(component).toBeInstanceOf(ContributePage);
    expect(url()).toBe('/c');
  });

  it('keeps the contributor token fragment on /c', async () => {
    await harness.navigateByUrl('/c#abc123');

    expect(url()).toBe('/c#abc123');
  });

  it('sends a signed-out visitor from the app to /login', async () => {
    await harness.navigateByUrl('/search');

    expect(url()).toBe('/login?next=%2Fsearch');
  });

  it('sends a password-only session from the app to /mfa', async () => {
    auth.current.set(fakeSession('aal1'));
    auth.nextStep.and.resolveTo('verify');

    await harness.navigateByUrl('/review');

    expect(url()).toBe('/mfa?next=%2Freview%2Fduplicates');
  });

  it('shows the shell and the requested page at aal2', async () => {
    auth.current.set(fakeSession('aal2'));

    await harness.navigateByUrl('/links');

    expect(url()).toBe('/links');
    expect(harness.routeNativeElement?.textContent).toContain('روابط المساهمين');
  });

  it('lands on search from the root at aal2', async () => {
    auth.current.set(fakeSession('aal2'));

    await harness.navigateByUrl('/');

    expect(url()).toBe('/search');
  });
});
