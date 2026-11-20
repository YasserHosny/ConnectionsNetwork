import { TestBed } from '@angular/core/testing';
import type { Session } from '@supabase/supabase-js';

import { fakeJwt, fakeSession } from '../testing/test-helpers';
import { AuthError, AuthService, SUPABASE_CLIENT, aalFromAccessToken } from './auth.service';

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

    fake.emit('SIGNED_OUT', null);
    expect(service.session()).toBeNull();
    expect(service.aal()).toBeNull();
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

  it('signOut ends the session even if the server call fails', async () => {
    fake.auth.signOut.and.rejectWith(new Error('offline'));
    const service = createService();
    await service.signIn('a@b.c', 'pw');

    await expectAsync(service.signOut()).toBeRejected();

    expect(service.session()).toBeNull();
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
