import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { fakeAuthService, fakeSession } from '../testing/test-helpers';
import { ApiClient, ApiError } from './api.client';
import { AuthService } from './auth.service';

describe('ApiClient', () => {
  let api: ApiClient;
  let http: HttpTestingController;
  let auth: ReturnType<typeof fakeAuthService>;

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
