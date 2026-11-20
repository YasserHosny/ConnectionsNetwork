import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { ContributeResponse, ContributorInfo, ContributorTag, TagKind } from '@connections/domain-types';
import { type Observable, catchError, map, of, throwError } from 'rxjs';

import { environment } from '../../../environments/environment';
import { ApiError, toApiError } from '../../core/api.client';
import { containsContactValue } from '../../core/contact-value';
import { type PersonFormValue, type TagSuggestion, toPersonInput } from '../people/person-form.model';

export const CONTRIBUTOR_TOKEN_HEADER = 'X-Contributor-Token';

/** What the API issues: `secrets.token_urlsafe`. Anything else cannot be a valid link. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Where the token is kept for this tab: sessionStorage (never localStorage, never a URL). */
const TOKEN_STORAGE_KEY = 'connections.contributeToken';

/** The token, or why there is none: no link at all, or text that cannot be a token. */
export type TokenLookup = { token: string } | { token: null; reason: 'missing' | 'malformed' };

function session(action: (storage: Storage) => string | null | void): string | null {
  try {
    return action(window.sessionStorage) ?? null;
  } catch {
    return null; // Blocked storage: the token lives in memory only, and a reload loses it.
  }
}

/**
 * The contributor token, taken out of the address bar.
 *
 * From the URL fragment (`/c#<token>`) when there is one: the fragment is removed at once, so it
 * is not left to be copied, bookmarked or shared from the address bar, and the token is kept in
 * sessionStorage, so a reload of this tab still works. Scoped to the tab: closing it forgets the
 * token, and other tabs and later visits never see it. Without a fragment, the kept token.
 */
export function takeToken(): TokenLookup {
  const { hash, pathname, search } = window.location;
  if (hash) {
    // Keep `history.state`: the router keeps its navigation id there.
    window.history.replaceState(window.history.state, '', `${pathname}${search}`);
    const token = hash.slice(1);
    if (!TOKEN_PATTERN.test(token)) {
      forgetToken();
      return { token: null, reason: 'malformed' };
    }
    session((storage) => storage.setItem(TOKEN_STORAGE_KEY, token));
    return { token };
  }
  const kept = session((storage) => storage.getItem(TOKEN_STORAGE_KEY));
  return kept && TOKEN_PATTERN.test(kept) ? { token: kept } : { token: null, reason: 'missing' };
}

/** Forgets the kept token: the link is dead (expired, revoked, unknown). */
export function forgetToken(): void {
  session((storage) => storage.removeItem(TOKEN_STORAGE_KEY));
}

/** The link is expired, revoked, unknown or malformed: the API answers all of these with 404. */
export function isLinkInvalid(error: ApiError): boolean {
  return error.code === 'link_not_found' || error.status === 404;
}

export function isRateLimited(error: ApiError): boolean {
  return error.status === 429;
}

/**
 * The three contributor endpoints. Provided by the page, so the token lives only as long as it.
 *
 * It uses `HttpClient` directly, not `ApiClient`: `ApiClient` adds the admin's bearer token when a
 * session exists (an admin trying out a link in their own browser), and a contributor request must
 * carry the link token and nothing else. The token goes in a header only: never in a URL, a query
 * string or a log.
 */
@Injectable()
export class ContributeApi {
  private readonly http = inject(HttpClient);
  private token: string | null = null;

  setToken(token: string | null): void {
    this.token = token;
  }

  info(): Observable<ContributorInfo> {
    return this.send((headers) =>
      this.http.get<ContributorInfo>(`${environment.apiBaseUrl}/contribute/info`, { headers }),
    );
  }

  tags(kind: TagKind, q: string): Observable<TagSuggestion[]> {
    // A phone number or an email typed into a tag field never goes into the query string.
    if (containsContactValue(q)) return of([]);
    const params = q ? new HttpParams().set('kind', kind).set('q', q) : new HttpParams().set('kind', kind);
    return this.send((headers) =>
      this.http.get<ContributorTag[]>(`${environment.apiBaseUrl}/contribute/tags`, { headers, params }),
    ).pipe(map((tags) => tags.map((t) => ({ label: t.label, category: t.category }))));
  }

  /**
   * Adds the person, connected to the contributor with `value.strength`. `idempotencyKey` is the
   * same on every retry of one submission, so a retry never adds the person twice.
   */
  addPerson(value: PersonFormValue, idempotencyKey: string): Observable<ContributeResponse> {
    if (!value.strength) return throwError(() => new Error('strength is required'));
    // Only `person` and `strength`: the API rejects `admin_notes` and any other key.
    const person = toPersonInput(value);
    delete person.admin_notes;
    return this.send((headers) =>
      this.http.post<ContributeResponse>(
        `${environment.apiBaseUrl}/contribute/people`,
        { person, strength: value.strength },
        { headers: { ...headers, 'Idempotency-Key': idempotencyKey } },
      ),
    );
  }

  private send<T>(request: (headers: Record<string, string>) => Observable<T>): Observable<T> {
    // Without a token there is nothing to ask: say what the server would say.
    if (!this.token) {
      return throwError(() => new ApiError('link_not_found', 'Link not found.', 404));
    }
    return request({ [CONTRIBUTOR_TOKEN_HEADER]: this.token }).pipe(
      catchError((error: unknown) => throwError(() => toApiError(error))),
    );
  }
}
