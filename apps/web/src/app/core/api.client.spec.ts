import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { fakeAuthService, fakeSession } from '../testing/test-helpers';
import { ApiClient, ApiError } from './api.client';
import { AuthService } from './auth.service';

describe('ApiClient', () => {
  let api: ApiClient;
  let http: HttpTestingController;
  let auth: ReturnType<typeof fakeAuthService>;
  let navigate: jasmine.Spy;

  beforeEach(() => {
    auth = fakeAuthService(fakeSession('aal2'));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
      ],
    });
    api = TestBed.inject(ApiClient);
    http = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
  });

  afterEach(() => http.verify());

  it('calls /api/v1 with the bearer token', () => {
    let result: unknown;
    api.get<{ ok: boolean }>('/people/1').subscribe((r) => (result = r));

    const req = http.expectOne('/api/v1/people/1');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${auth.session()?.access_token}`);
    req.flush({ ok: true });

    expect(result).toEqual({ ok: true });
  });

  it('sends no Authorization header without a session', () => {
    auth.current.set(null);
    api.get('/tags').subscribe();

    expect(http.expectOne('/api/v1/tags').request.headers.has('Authorization')).toBeFalse();
  });

  it('sends bodies on post, put and patch, and uses delete without one', () => {
    api.post('/people', { a: 1 }).subscribe();
    api.put('/people/1', { b: 2 }).subscribe();
    api.patch('/connections/1', { c: 3 }).subscribe();
    api.delete('/people/1').subscribe();

    const post = http.expectOne((r) => r.method === 'POST');
    const put = http.expectOne((r) => r.method === 'PUT');
    const patch = http.expectOne((r) => r.method === 'PATCH');
    const del = http.expectOne((r) => r.method === 'DELETE');
    expect(post.request.body).toEqual({ a: 1 });
    expect(put.request.body).toEqual({ b: 2 });
    expect(patch.request.body).toEqual({ c: 3 });
    expect(del.request.url).toBe('/api/v1/people/1');
    [post, put, patch].forEach((r) => r.flush({}));
    del.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('builds the query string: repeated keys, no empty or missing values', () => {
    api
      .get('/search', { q: 'ahmed', skill: ['python', 'sql'], city: '', industry: undefined, limit: 20 })
      .subscribe();

    const req = http.expectOne((r) => r.url === '/api/v1/search');
    expect(req.request.params.getAll('skill')).toEqual(['python', 'sql']);
    expect(req.request.params.get('q')).toBe('ahmed');
    expect(req.request.params.get('limit')).toBe('20');
    expect(req.request.params.has('city')).toBeFalse();
    expect(req.request.params.has('industry')).toBeFalse();
    req.flush([]);
  });

  describe('contact values never reach a URL', () => {
    it('refuses a request whose parameter contains a phone number, and says why', () => {
      let error: unknown;
      api.get('/search', { q: 'Sara 01012345678', limit: 8 }).subscribe({ error: (e) => (error = e) });

      http.expectNone(() => true);
      expect(error).toEqual(
        jasmine.objectContaining({ code: 'contact_in_query', details: { fields: ['q'] } }),
      );
    });

    it('refuses an email address in any parameter, repeated ones included', () => {
      let error: unknown;
      api.get('/search', { q: 'marketing', city: ['Cairo', 'sara@example.com'] }).subscribe({
        error: (e) => (error = e),
      });

      http.expectNone(() => true);
      expect(error).toEqual(jasmine.objectContaining({ code: 'contact_in_query', details: { fields: ['city'] } }));
    });

    it('refuses a download the same way', async () => {
      await expectAsync(api.download('/export', { format: '٠١٠١٢٣٤٥٦٧٨' })).toBeRejectedWith(
        jasmine.objectContaining({ code: 'contact_in_query' }),
      );
      http.expectNone(() => true);
    });

    it('sends ordinary text, short numbers included', () => {
      api.get('/search', { q: 'marketing 2024', limit: 50 }).subscribe();

      expect(http.expectOne((r) => r.url === '/api/v1/search').request.params.get('q')).toBe('marketing 2024');
    });
  });

  it('sends an Idempotency-Key when asked to', () => {
    api.post('/people', { a: 1 }, { idempotencyKey: 'key-1' }).subscribe();
    api.post('/people', { a: 2 }).subscribe();

    const [withKey, without] = http.match((r) => r.method === 'POST');
    expect(withKey.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(without.request.headers.has('Idempotency-Key')).toBeFalse();
    [withKey, without].forEach((r) => r.flush({}));
  });

  describe('an ended session, handled in one place', () => {
    const envelope = (code: string) => ({ code, message: 'x', details: null, trace_id: 't' });

    it('signs out locally and goes to /login on a 401, and still reports the error', async () => {
      let error: unknown;
      api.get('/people/1').subscribe({ error: (e) => (error = e) });

      http.expectOne('/api/v1/people/1').flush(envelope('auth.unauthenticated'), { status: 401, statusText: 'x' });
      await Promise.resolve();

      expect(error).toEqual(jasmine.objectContaining({ status: 401 }));
      expect(auth.signOut).toHaveBeenCalledWith({ keepDrafts: true });
      await auth.signOut.calls.mostRecent().returnValue;
      expect(navigate).toHaveBeenCalledWith('/login');
    });

    it('goes to /mfa when the second step has lapsed, without signing out', () => {
      let error: unknown;
      api.post('/connections', {}).subscribe({ error: (e) => (error = e) });

      http.expectOne('/api/v1/connections').flush(envelope('mfa_required'), { status: 403, statusText: 'x' });

      expect(error).toEqual(jasmine.objectContaining({ code: 'mfa_required' }));
      expect(navigate).toHaveBeenCalledWith('/mfa');
      expect(auth.signOut).not.toHaveBeenCalled();
    });

    it('does the same for a download', async () => {
      const result = api.download('/export');

      http
        .expectOne('/api/v1/export')
        .flush(new Blob([JSON.stringify(envelope('mfa_required'))]), { status: 403, statusText: 'x' });

      await expectAsync(result).toBeRejected();
      expect(navigate).toHaveBeenCalledWith('/mfa');
    });

    it('leaves any other failure to the page', () => {
      api.get('/x').subscribe({ error: () => undefined });

      http.expectOne('/api/v1/x').flush(envelope('not_found'), { status: 404, statusText: 'x' });

      expect(navigate).not.toHaveBeenCalled();
      expect(auth.signOut).not.toHaveBeenCalled();
    });
  });

  describe('download', () => {
    const DISPOSITION = 'attachment; filename="connections-export-2026-11-20.zip"';

    it('fetches the file as a blob with the bearer token and takes its name from the header', async () => {
      const result = api.download('/export', { format: 'csv' });

      const req = http.expectOne((r) => r.url === '/api/v1/export');
      expect(req.request.method).toBe('GET');
      expect(req.request.responseType).toBe('blob');
      expect(req.request.params.get('format')).toBe('csv');
      expect(req.request.headers.get('Authorization')).toBe(`Bearer ${auth.session()?.access_token}`);
      req.flush(new Blob(['zip']), { headers: { 'Content-Disposition': DISPOSITION } });

      const file = await result;
      expect(file.filename).toBe('connections-export-2026-11-20.zip');
      expect(file.blob.size).toBe(3);
    });

    it('reads an RFC 5987 filename and drops any path in it', async () => {
      const result = api.download('/export');

      http.expectOne('/api/v1/export').flush(new Blob(['x']), {
        headers: { 'Content-Disposition': "attachment; filename*=UTF-8''..%2F..%2Fnetwork%20backup.json" },
      });

      expect((await result).filename).toBe('network backup.json');
    });

    it('uses a plain name when the header is missing', async () => {
      const result = api.download('/export');

      http.expectOne('/api/v1/export').flush(new Blob(['x']));

      expect((await result).filename).toBe('download');
    });

    it('rejects with the error envelope even though the body arrives as a blob', async () => {
      const result = api.download('/export');

      const envelope = { code: 'mfa_required', message: 'MFA', details: null, trace_id: 't-1' };
      http
        .expectOne('/api/v1/export')
        .flush(new Blob([JSON.stringify(envelope)], { type: 'application/json' }), {
          status: 403,
          statusText: 'Forbidden',
        });

      await expectAsync(result).toBeRejectedWith(
        jasmine.objectContaining({ code: 'mfa_required', status: 403, traceId: 't-1' }),
      );
    });

    it('rejects with a generic error when the failure body is not our envelope', async () => {
      const result = api.download('/export');

      http
        .expectOne('/api/v1/export')
        .flush(new Blob(['<html>bad gateway</html>']), { status: 502, statusText: 'Bad Gateway' });

      await expectAsync(result).toBeRejectedWith(
        jasmine.objectContaining({ code: 'http_error', status: 502 }),
      );
    });

    it('rejects with a network error when the server cannot be reached', async () => {
      const result = api.download('/export');

      http.expectOne('/api/v1/export').error(new ProgressEvent('error'));

      await expectAsync(result).toBeRejectedWith(
        jasmine.objectContaining({ code: 'network_error', status: 0 }),
      );
    });
  });

  describe('errors', () => {
    function failWith(body: string | object, status: number): ApiError {
      let error: unknown;
      api.get('/x').subscribe({ error: (e) => (error = e) });
      http.expectOne('/api/v1/x').flush(body, { status, statusText: 'Error' });
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    }

    it('maps the error envelope to ApiError(code, message)', () => {
      const error = failWith(
        { code: 'mfa_required', message: 'Multi-factor authentication is required.', details: null, trace_id: 't-1' },
        403,
      );

      expect(error.code).toBe('mfa_required');
      expect(error.message).toBe('Multi-factor authentication is required.');
      expect(error.status).toBe(403);
      expect(error.traceId).toBe('t-1');
    });

    it('keeps validation details', () => {
      const details = [{ field: 'name_ar', reason: 'missing' }];
      const error = failWith(
        { code: 'validation.invalid_request', message: 'Request validation failed.', details, trace_id: 't' },
        422,
      );

      expect(error.details).toEqual(details);
    });

    it('treats a body that is not our envelope as a generic http_error', () => {
      const error = failWith('<html>Bad gateway</html>', 502);

      expect(error.code).toBe('http_error');
      expect(error.status).toBe(502);
    });

    it('reports an unreachable server as network_error', () => {
      let error: unknown;
      api.get('/x').subscribe({ error: (e) => (error = e) });
      http.expectOne('/api/v1/x').error(new ProgressEvent('error'));

      expect(error).toEqual(jasmine.objectContaining({ code: 'network_error', status: 0 }));
    });
  });
});
