import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { ErrorEnvelope } from '@connections/domain-types';
import { Observable, catchError, firstValueFrom, throwError } from 'rxjs';

import { environment } from '../../environments/environment';
import { returnFrom, withReturn } from './return-to';
import { AuthService } from './auth.service';
import { containsContactValue } from './contact-value';

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

/** A file the API sent as an attachment. */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

const FALLBACK_FILENAME = 'download';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The file name in a `Content-Disposition` header (`filename*=UTF-8''…` first, else `filename=`).
 * Only the last path segment is kept: the server's name must never choose where a file is saved.
 */
export function filenameFromDisposition(header: string | null): string {
  if (!header) return FALLBACK_FILENAME;
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header)?.[1];
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const raw = encoded ? safeDecode(encoded.trim()) : (plain?.[1] ?? plain?.[2] ?? '').trim();
  return raw.split(/[\\/]/).pop() || FALLBACK_FILENAME;
}

/** With `responseType: 'blob'` an error body is a Blob too: read it to find our envelope. */
async function toDownloadError(error: unknown): Promise<ApiError> {
  if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
    try {
      const body: unknown = JSON.parse(await error.error.text());
      return toApiError(
        new HttpErrorResponse({
          error: body,
          status: error.status,
          statusText: error.statusText,
          url: error.url ?? undefined,
        }),
      );
    } catch {
      // Not JSON (a proxy's error page): fall through to the generic mapping.
    }
  }
  return toApiError(error);
}

/** The code of a request refused before it was sent: a parameter looked like a contact value. */
export const CONTACT_IN_QUERY = 'contact_in_query';

/**
 * The query string for `params`, or the names of the parameters that contain a contact value
 * (an email address or a phone number: `containsContactValue`). Such a request is never sent.
 */
function toHttpParams(params: QueryParams | undefined): { params: HttpParams; refused: string[] } {
  let result = new HttpParams();
  const refused: string[] = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values as readonly QueryValue[]) {
      if (item === null || item === undefined || item === '') continue;
      const text = String(item);
      if (containsContactValue(text)) {
        if (!refused.includes(key)) refused.push(key);
      } else {
        result = result.append(key, text);
      }
    }
  }
  return { params: result, refused };
}

function contactInQuery(fields: string[]): ApiError {
  return new ApiError(
    CONTACT_IN_QUERY,
    'A query parameter contained a contact value, so the request was not sent.',
    400,
    { fields },
  );
}

/** Options of a write. */
export interface WriteOptions {
  /** Sent as `Idempotency-Key`: the same key on every retry of one submission (spec 11.1). */
  idempotencyKey?: string;
}

/**
 * Typed client for `/api/v1`. It sends the Supabase access token as a bearer token and turns the
 * error envelope into an `ApiError(code, message)`.
 *
 * Contact values (phone, WhatsApp, email) belong in request bodies, never in `path` or `params`:
 * URLs end up in proxy and server logs. A parameter that contains one is refused here, before
 * anything is sent: the call fails with `ApiError(CONTACT_IN_QUERY)`, details `{ fields }`.
 *
 * An ended session is handled here, for every page: a 401 signs out on this device (keeping any
 * draft, so the admin finds it after signing back in) and goes to /login; `mfa_required` goes to
 * /mfa. The error is still passed on, so the page can stop what it was doing (or keep a draft).
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  get<T>(path: string, params?: QueryParams): Observable<T> {
    return this.request<T>('GET', path, undefined, params);
  }

  post<T>(path: string, body?: unknown, options: WriteOptions = {}): Observable<T> {
    return this.request<T>('POST', path, body, undefined, options);
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

  /**
   * GET a file (an export) as a blob, named by the response's `Content-Disposition`. Rejects with
   * an `ApiError` like the other calls. Query parameters only: no contact values (see above).
   */
  async download(path: string, params?: QueryParams): Promise<DownloadedFile> {
    const query = toHttpParams(params);
    if (query.refused.length) throw contactInQuery(query.refused);
    try {
      const response = await firstValueFrom(
        this.http.get(`${environment.apiBaseUrl}${path}`, {
          params: query.params,
          headers: this.headers(),
          observe: 'response',
          responseType: 'blob',
        }),
      );
      return {
        blob: response.body ?? new Blob(),
        filename: filenameFromDisposition(response.headers.get('Content-Disposition')),
      };
    } catch (error) {
      throw this.handled(await toDownloadError(error));
    }
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: QueryParams,
    options: WriteOptions = {},
  ): Observable<T> {
    const query = toHttpParams(params);
    if (query.refused.length) return throwError(() => contactInQuery(query.refused));
    const headers = this.headers();
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    return this.http
      .request<T>(method, `${environment.apiBaseUrl}${path}`, { body, params: query.params, headers })
      .pipe(catchError((error: unknown) => throwError(() => this.handled(toApiError(error)))));
  }

  /** Sends the admin where an ended session or a lapsed MFA step must go; returns the error. */
  private handled(error: ApiError): ApiError {
    // Back to the same page afterwards (`?next=`, in-app paths only).
    const from = returnFrom(this.router.url);
    if (error.code === 'mfa_required') {
      void this.router.navigateByUrl(withReturn('/mfa', from));
    } else if (error.status === 401) {
      void this.auth.signOut({ keepDrafts: true }).then(() => this.router.navigateByUrl(withReturn('/login', from)));
    }
    return error;
  }

  private headers(): Record<string, string> {
    const token = this.auth.session()?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
