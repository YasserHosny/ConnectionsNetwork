import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { ErrorEnvelope } from '@connections/domain-types';
import { Observable, catchError, throwError } from 'rxjs';

import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

/** A failed API call: the envelope's `code` and `message`, plus what the caller may want to show. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly details: ErrorEnvelope['details'] = null,
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isEnvelope(body: unknown): body is ErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const { code, message } = body as Record<string, unknown>;
  return typeof code === 'string' && typeof message === 'string';
}

/** Maps a failed request onto `ApiError`; anything that is not our envelope is a generic error. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof HttpErrorResponse) {
    if (isEnvelope(error.error)) {
      const { code, message, details, trace_id } = error.error;
      return new ApiError(code, message, error.status, details ?? null, trace_id ?? null);
    }
    // status 0: the request never got an answer (offline, proxy down, CORS).
    return error.status === 0
      ? new ApiError('network_error', 'The server could not be reached.', 0)
      : new ApiError('http_error', 'Request failed.', error.status);
  }
  return new ApiError('unknown_error', 'Request failed.');
}

function toHttpParams(params: QueryParams | undefined): HttpParams {
  let result = new HttpParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values as readonly QueryValue[]) {
      if (item !== null && item !== undefined && item !== '') result = result.append(key, String(item));
    }
  }
  return result;
}

/**
 * Typed client for `/api/v1`. It sends the Supabase access token as a bearer token and turns the
 * error envelope into an `ApiError(code, message)`.
 *
 * Contact values (phone, WhatsApp, email) belong in request bodies, never in `path` or `params`:
 * URLs end up in proxy and server logs.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  get<T>(path: string, params?: QueryParams): Observable<T> {
    return this.request<T>('GET', path, undefined, params);
  }

  post<T>(path: string, body?: unknown): Observable<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Observable<T> {
    return this.request<T>('PUT', path, body);
  }

  patch<T>(path: string, body?: unknown): Observable<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T = void>(path: string): Observable<T> {
    return this.request<T>('DELETE', path);
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: QueryParams,
  ): Observable<T> {
    const token = this.auth.session()?.access_token;
    return this.http
      .request<T>(method, `${environment.apiBaseUrl}${path}`, {
        body,
        params: toHttpParams(params),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      .pipe(catchError((error: unknown) => throwError(() => toApiError(error))));
  }
}
