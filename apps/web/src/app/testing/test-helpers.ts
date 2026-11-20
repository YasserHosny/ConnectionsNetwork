import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { arCatalog, enCatalog } from '@connections/i18n';
import type { Session } from '@supabase/supabase-js';

import type { AuthLevel } from '../core/auth.service';

/** An unsigned JWT carrying the given claims: enough for code that only reads the payload. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.signature`;
}

/** The person the fake admin session belongs to (the `person_id` claim). */
export const ADMIN_PERSON_ID = 'admin-person-id';

export function fakeSession(aal: AuthLevel = 'aal1'): Session {
  return {
    access_token: fakeJwt({ sub: 'user-1', aal, person_id: ADMIN_PERSON_ID }),
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id: 'user-1' },
  } as Session;
}

/** A stand-in for AuthService whose session and level the test sets directly. */
export function fakeAuthService(session: Session | null = null) {
  const current = signal<Session | null>(session);
  return {
    current,
    session: current.asReadonly(),
    aal: () => {
      const token = current()?.access_token;
      const claim = token ? JSON.parse(atob(token.split('.')[1])).aal : null;
      return (claim ?? null) as AuthLevel | null;
    },
    personId: () => {
      const token = current()?.access_token;
      const claim = token ? JSON.parse(atob(token.split('.')[1])).person_id : null;
      return (claim ?? null) as string | null;
    },
    signIn: jasmine.createSpy('signIn'),
    nextStep: jasmine.createSpy('nextStep'),
    enrollTotp: jasmine.createSpy('enrollTotp'),
    verifyTotp: jasmine.createSpy('verifyTotp'),
    signOut: jasmine.createSpy('signOut').and.resolveTo(),
  };
}

/** Loads the real catalogues so a rendered template shows real text, not keys. */
export function loadCatalogues(): void {
  const translate = TestBed.inject(TranslateService);
  translate.setTranslation('en', enCatalog);
  translate.setTranslation('ar', arCatalog);
}
