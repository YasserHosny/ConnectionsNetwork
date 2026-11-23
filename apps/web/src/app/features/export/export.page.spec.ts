import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';

import { AuthService } from '../../core/auth.service';
import { LocaleService } from '../../core/locale.service';
import { fakeAuthService, fakeSession, loadCatalogues, waitFor } from '../../testing/test-helpers';
import { ExportPage } from './export.page';

describe('ExportPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;
  let saved: { href: string; download: string }[];

  const el = () => harness.routeNativeElement as HTMLElement;
  const fixture = () => harness.fixture as ComponentFixture<unknown>;
  const button = (cls: string) => el().querySelector(`button.${cls}`) as HTMLButtonElement;

  async function settle(): Promise<void> {
    await fixture().whenStable();
    fixture().detectChanges();
  }

  const file = (name: string) => ({
    headers: { 'Content-Disposition': `attachment; filename="${name}"` },
  });

  beforeEach(async () => {
    localStorage.clear();
    saved = [];
    spyOn(URL, 'createObjectURL').and.returnValue('blob:http://localhost/export');
    spyOn(URL, 'revokeObjectURL');
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
      saved.push({ href: this.href, download: this.download });
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'export', component: ExportPage },
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
    await harness.navigateByUrl('/export', ExportPage);
    fixture().detectChanges();
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('explains that JSON is the full backup and that CSV neutralises formulas', () => {
    const text = el().textContent ?? '';

    expect(text).toContain('The full backup');
    expect(text).toContain('does not run it as a formula');
  });

  it('downloads the JSON export under the name the server gives it', async () => {
    button('download-json').click();

    const req = http.expectOne((r) => r.url === '/api/v1/export');
    expect(req.request.params.get('format')).toBe('json');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['{}']), file('connections-export-2026-11-20.json'));
    await settle();

    await waitFor(fixture(), () => saved.length);
    expect(saved).toEqual([{ href: 'blob:http://localhost/export', download: 'connections-export-2026-11-20.json' }]);
    expect(el().querySelector('.status')?.textContent).toContain('connections-export-2026-11-20.json');
  });

  it('downloads the CSV export as a zip', async () => {
    button('download-csv').click();

    const req = http.expectOne((r) => r.url === '/api/v1/export');
    expect(req.request.params.get('format')).toBe('csv');
    req.flush(new Blob(['zip']), file('connections-export-2026-11-20.zip'));
    await settle();

    await waitFor(fixture(), () => saved.length);
    expect(saved[0].download).toBe('connections-export-2026-11-20.zip');
  });

  it('keeps both buttons off while a file is being prepared', async () => {
    button('download-json').click();
    fixture().detectChanges();

    expect(button('download-json').disabled).toBeTrue();
    expect(button('download-csv').disabled).toBeTrue();

    http.expectOne((r) => r.url === '/api/v1/export').flush(new Blob(['{}']), file('a.json'));
    await settle();
    await waitFor(fixture(), () => !button('download-json').disabled);
  });

  it('shows a translated message, not the API text, when the export fails', async () => {
    button('download-csv').click();
    http.expectOne((r) => r.url === '/api/v1/export').flush(
      new Blob([JSON.stringify({ code: 'internal_error', message: 'English API text', details: null, trace_id: 't' })]),
      { status: 500, statusText: 'Server Error' },
    );
    await settle();

    const text = await waitFor(fixture(), () => el().querySelector('.error')?.textContent);
    expect(text).toContain('Could not reach the server');
    expect(text).not.toContain('English API text');
    expect(saved).toEqual([]);
  });

  it('sends the admin to /mfa when the second step has lapsed', async () => {
    button('download-json').click();
    http.expectOne((r) => r.url === '/api/v1/export').flush(
      new Blob([JSON.stringify({ code: 'mfa_required', message: 'x', details: null, trace_id: 't' })]),
      { status: 403, statusText: 'Forbidden' },
    );

    await waitFor(fixture(), () => router.url === '/mfa');
  });
});
