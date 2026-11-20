import { TestBed } from '@angular/core/testing';
import { type Session, createClient } from '@supabase/supabase-js';

import { fakeJwt, fakeSession } from '../testing/test-helpers';
import {
  AuthError,
  AuthService,
  SUPABASE_CLIENT,
  aalFromAccessToken,
  personIdFromAccessToken,
} from './auth.service';

type Callback = (event: string, session: Session | null) => void;

function createFakeClient() {
  const mfa = {
    listFactors: jasmine
      .createSpy('listFactors')
      .and.resolveTo({ data: { all: [], totp: [], phone: [] }, error: null }),
    enroll: jasmine.createSpy('enroll').and.resolveTo({
      data: { id: 'factor-new', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'SECRET' } },
      error: null,
    }),
    unenroll: jasmine.createSpy('unenroll').and.resolveTo({ data: {}, error: null }),
    challengeAndVerify: jasmine.createSpy('challengeAndVerify').and.resolveTo({ data: {}, error: null }),
  };
  let listener: Callback | null = null;
  const auth = {
    getSession: jasmine.createSpy('getSession').and.resolveTo({ data: { session: null } }),
    onAuthStateChange: jasmine.createSpy('onAuthStateChange').and.callFake((cb: Callback) => {
      listener = cb;
      return { data: { subscription: { unsubscribe: () => undefined } } };
    }),
    signInWithPassword: jasmine
      .createSpy('signInWithPassword')
      .and.resolveTo({ data: { session: fakeSession('aal1') }, error: null }),
    signOut: jasmine.createSpy('signOut').and.resolveTo({ error: null }),
    mfa,
  };
  return { client: { auth }, auth, mfa, emit: (e: string, s: Session | null) => listener?.(e, s) };
}

describe('aalFromAccessToken', () => {
  it('reads the aal claim', () => {
    expect(aalFromAccessToken(fakeJwt({ aal: 'aal2' }))).toBe('aal2');
    expect(aalFromAccessToken(fakeJwt({ aal: 'aal1' }))).toBe('aal1');
  });

  it('is null when the claim is missing, unknown or the token is unreadable', () => {
    expect(aalFromAccessToken(fakeJwt({ sub: 'x' }))).toBeNull();
    expect(aalFromAccessToken(fakeJwt({ aal: 'aal3' }))).toBeNull();
    expect(aalFromAccessToken('not-a-jwt')).toBeNull();
    expect(aalFromAccessToken('a.%%%.c')).toBeNull();
    expect(aalFromAccessToken(null)).toBeNull();
  });
});

describe('personIdFromAccessToken', () => {
  it('reads the person_id claim the access token hook stamps', () => {
    expect(personIdFromAccessToken(fakeJwt({ person_id: 'p-1' }))).toBe('p-1');
  });

  it('is null when the claim is missing, not a string or the token is unreadable', () => {
    expect(personIdFromAccessToken(fakeJwt({ sub: 'x' }))).toBeNull();
    expect(personIdFromAccessToken(fakeJwt({ person_id: 7 }))).toBeNull();
    expect(personIdFromAccessToken('not-a-jwt')).toBeNull();
    expect(personIdFromAccessToken(undefined)).toBeNull();
  });
});

describe('AuthService', () => {
  let fake: ReturnType<typeof createFakeClient>;

  function createService(client: unknown = fake.client): AuthService {
    TestBed.configureTestingModule({ providers: [{ provide: SUPABASE_CLIENT, useValue: client }] });
    return TestBed.inject(AuthService);
  }

  beforeEach(() => {
    fake = createFakeClient();
  });

  it('restores a stored session on init and follows later changes', async () => {
    fake.auth.getSession.and.resolveTo({ data: { session: fakeSession('aal2') } });
    const service = createService();

    await service.init();
    expect(service.aal()).toBe('aal2');
    expect(service.personId()).toBe('admin-person-id');

    fake.emit('SIGNED_OUT', null);
    expect(service.session()).toBeNull();
    expect(service.aal()).toBeNull();
    expect(service.personId()).toBeNull();
  });

  describe('signIn', () => {
    it('goes to enrolment when the person has no verified TOTP factor', async () => {
      const service = createService();

      expect(await service.signIn('a@b.c', 'pw')).toBe('enroll');
      expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.c', password: 'pw' });
      expect(service.aal()).toBe('aal1');
    });

    it('goes to verification when a verified factor exists', async () => {
      fake.mfa.listFactors.and.resolveTo({
        data: { all: [{ id: 'f1' }], totp: [{ id: 'f1' }], phone: [] },
        error: null,
      });

      expect(await createService().signIn('a@b.c', 'pw')).toBe('verify');
    });

    it('is done when the session is already aal2', async () => {
      fake.auth.signInWithPassword.and.resolveTo({ data: { session: fakeSession('aal2') }, error: null });

      expect(await createService().signIn('a@b.c', 'pw')).toBe('done');
    });

    it('does not read a failed factor lookup as "no factor"', async () => {
      fake.mfa.listFactors.and.resolveTo({ data: null, error: new Error('offline') });

      await expectAsync(createService().signIn('a@b.c', 'pw')).toBeRejectedWith(
        jasmine.objectContaining({ kind: 'unknown' }),
      );
    });

    it('maps wrong credentials to invalid_credentials', async () => {
      fake.auth.signInWithPassword.and.resolveTo({
        data: { session: null },
        error: { code: 'invalid_credentials' },
      });
      const service = createService();

      await expectAsync(service.signIn('a@b.c', 'bad')).toBeRejectedWith(
        jasmine.objectContaining({ kind: 'invalid_credentials' }),
      );
      expect(service.session()).toBeNull();
    });

    it('maps any other failure to unknown', async () => {
      fake.auth.signInWithPassword.and.resolveTo({ data: { session: null }, error: { code: 'x' } });

      await expectAsync(createService().signIn('a@b.c', 'pw')).toBeRejectedWith(
        jasmine.objectContaining({ kind: 'unknown' }),
      );
    });
  });

  describe('TOTP', () => {
    it('enrols a factor and returns its QR code and secret', async () => {
      const result = await createService().enrollTotp();

      expect(result).toEqual({ qrCode: 'data:image/svg+xml;utf-8,<svg/>', secret: 'SECRET' });
      expect(fake.mfa.enroll).toHaveBeenCalledWith(jasmine.objectContaining({ factorType: 'totp' }));
    });

    it('drops an abandoned unverified enrolment before enrolling again', async () => {
      fake.mfa.listFactors.and.resolveTo({
        data: {
          all: [
            { id: 'stale', factor_type: 'totp', status: 'unverified' },
            { id: 'keep', factor_type: 'totp', status: 'verified' },
          ],
          totp: [{ id: 'keep' }],
          phone: [],
        },
        error: null,
      });

      await createService().enrollTotp();

      expect(fake.mfa.unenroll).toHaveBeenCalledOnceWith({ factorId: 'stale' });
    });

    it('verifies the factor it just enrolled and reaches aal2', async () => {
      const service = createService();
      await service.enrollTotp();
      fake.auth.getSession.and.resolveTo({ data: { session: fakeSession('aal2') } });

      await service.verifyTotp('123456');

      expect(fake.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'factor-new', code: '123456' });
      expect(service.aal()).toBe('aal2');
    });

    it('verifies against the verified factor when nothing was enrolled this visit', async () => {
      fake.mfa.listFactors.and.resolveTo({
        data: { all: [{ id: 'f1' }], totp: [{ id: 'f1' }], phone: [] },
        error: null,
      });

      await createService().verifyTotp('654321');

      expect(fake.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f1', code: '654321' });
    });

    it('maps a wrong code to invalid_code and stays at aal1', async () => {
      fake.mfa.challengeAndVerify.and.resolveTo({ data: null, error: { code: 'mfa_verification_failed' } });
      const service = createService();
      fake.auth.getSession.and.resolveTo({ data: { session: fakeSession('aal1') } });
      await service.signIn('a@b.c', 'pw');
      await service.enrollTotp();

      await expectAsync(service.verifyTotp('000000')).toBeRejectedWith(
        jasmine.objectContaining({ kind: 'invalid_code' }),
      );
      expect(service.aal()).toBe('aal1');
    });
  });

  describe('signOut', () => {
    it('signs out of this device only, so the admin keeps their other devices', async () => {
      const service = createService();
      await service.signIn('a@b.c', 'pw');

      await service.signOut();

      expect(fake.auth.signOut).toHaveBeenCalledOnceWith({ scope: 'local' });
      expect(service.session()).toBeNull();
    });

    it('does not throw, and still ends the session, if the client throws', async () => {
      spyOn(console, 'error');
      fake.auth.signOut.and.rejectWith(new Error('boom'));
      const service = createService();
      await service.signIn('a@b.c', 'pw');

      await expectAsync(service.signOut()).toBeResolved();

      expect(service.session()).toBeNull();
    });

    // The real client does not throw when the revoke call fails: it returns { error } and, with
    // the default global scope, leaves the stored session in place, so a reload would restore
    // the aal2 session. This runs the real supabase-js against a network that always fails.
    it('removes the stored session even when the network is down', async () => {
      // Its own key: a second client on the app's default key triggers a supabase-js warning.
      const storageKey = 'sb-signout-test';
      const expiresAt = Math.floor(Date.now() / 1000) + 86400;
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          access_token: fakeJwt({ sub: 'u1', aal: 'aal2', exp: expiresAt }),
          refresh_token: 'refresh',
          token_type: 'bearer',
          expires_in: 86400,
          expires_at: expiresAt,
          user: { id: 'u1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
        }),
      );
      try {
        const offline = () => Promise.reject(new TypeError('Failed to fetch'));
        const real = createClient('http://127.0.0.1:54321', 'anon-key', {
          global: { fetch: offline },
          auth: { storageKey, autoRefreshToken: false, detectSessionInUrl: false },
        });
        TestBed.configureTestingModule({ providers: [{ provide: SUPABASE_CLIENT, useValue: real }] });
        const service = TestBed.inject(AuthService);
        await service.init();
        expect(service.aal()).toBe('aal2');

        await service.signOut();

        expect(service.session()).toBeNull();
        expect(localStorage.getItem(storageKey)).toBeNull();
      } finally {
        localStorage.removeItem(storageKey);
      }
    });
  });

  it('reports not_configured when there is no Supabase client', async () => {
    const service = createService(null);

    await service.init();
    await expectAsync(service.signIn('a@b.c', 'pw')).toBeRejectedWith(jasmine.any(AuthError));
    await expectAsync(service.signIn('a@b.c', 'pw')).toBeRejectedWith(
      jasmine.objectContaining({ kind: 'not_configured' }),
    );
  });
});
