import { InjectionToken, Injectable, computed, inject, signal } from '@angular/core';
import { type Session, type SupabaseClient, createClient } from '@supabase/supabase-js';

import { DraftStore } from './draft.store';
import { RuntimeConfig } from './runtime-config';

export type AuthLevel = 'aal1' | 'aal2';

/** Where the sign-in leaves the person: nothing more to do, or a TOTP step. */
export type SignInNext = 'done' | 'enroll' | 'verify';

export interface TotpEnrollment {
  /** SVG data URI of the QR code. */
  qrCode: string;
  /** The shared secret, for apps that cannot scan. */
  secret: string;
}

export type AuthErrorKind = 'invalid_credentials' | 'invalid_code' | 'not_configured' | 'unknown';

export class AuthError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    options?: { cause?: unknown },
  ) {
    super(`auth.${kind}`, options);
    this.name = 'AuthError';
  }
}

/** The Supabase client, or null when `runtime-config.json` has no project URL and key. */
export const SUPABASE_CLIENT = new InjectionToken<SupabaseClient | null>('SUPABASE_CLIENT', {
  providedIn: 'root',
  factory: () => {
    const config = inject(RuntimeConfig).supabase;
    if (!config) return null;
    return createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // No OAuth or magic links here, and a contributor token lives in the URL fragment.
        detectSessionInUrl: false,
      },
    });
  },
});

/** The payload of an access token, or null when it is absent or unreadable. */
function claimsOf(token: string | null | undefined): Record<string, unknown> | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `aal` claim of a Supabase access token, or null when it is absent or unreadable. */
export function aalFromAccessToken(token: string | null | undefined): AuthLevel | null {
  const aal = claimsOf(token)?.['aal'];
  return aal === 'aal1' || aal === 'aal2' ? aal : null;
}

/** The `person_id` claim (the admin's own person, stamped by the access token hook), or null. */
export function personIdFromAccessToken(token: string | null | undefined): string | null {
  const personId = claimsOf(token)?.['person_id'];
  return typeof personId === 'string' && personId ? personId : null;
}

/**
 * Sign-in with email and password, then TOTP: every screen behind the shell needs `aal2`.
 *
 * `session` and `aal` are signals the router guard reads synchronously, so `init()` must have
 * resolved (it runs as an app initializer) before the first navigation.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly client = inject(SUPABASE_CLIENT);
  private readonly drafts = inject(DraftStore);
  private readonly current = signal<Session | null>(null);
  /** The factor being enrolled in this visit, until its first code is verified. */
  private pendingFactorId: string | null = null;

  readonly session = this.current.asReadonly();
  /** Authenticator assurance level of the current access token: aal2 once TOTP is verified. */
  readonly aal = computed<AuthLevel | null>(() => aalFromAccessToken(this.current()?.access_token));
  /** The signed-in admin's own person: who "connected to" defaults to when adding someone. */
  readonly personId = computed(() => personIdFromAccessToken(this.current()?.access_token));

  /** Restores a stored session and follows the client's later changes (refresh, sign-out). */
  async init(): Promise<void> {
    if (!this.client) return;
    const { data } = await this.client.auth.getSession();
    this.current.set(data.session);
    // Only sets a signal: calling back into the client from this callback can deadlock it.
    this.client.auth.onAuthStateChange((_event, session) => this.current.set(session));
  }

  async signIn(email: string, password: string): Promise<SignInNext> {
    const client = this.requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      throw new AuthError(error.code === 'invalid_credentials' ? 'invalid_credentials' : 'unknown', {
        cause: error,
      });
    }
    this.current.set(data.session);
    return this.nextStep();
  }

  /** What the signed-in person must do next to reach aal2. */
  async nextStep(): Promise<SignInNext> {
    if (this.aal() === 'aal2') return 'done';
    return (await this.verifiedTotpFactorId()) ? 'verify' : 'enroll';
  }

  async enrollTotp(): Promise<TotpEnrollment> {
    const client = this.requireClient();
    // An enrolment abandoned after scanning the QR code lingers unverified and makes the next
    // one fail on its name; drop those first.
    const { data: factors, error: listError } = await client.auth.mfa.listFactors();
    if (listError) throw new AuthError('unknown', { cause: listError });
    for (const factor of factors.all) {
      if (factor.factor_type === 'totp' && factor.status === 'unverified') {
        await client.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Connections',
    });
    if (error || !data) throw new AuthError('unknown', { cause: error });
    this.pendingFactorId = data.id;
    return { qrCode: data.totp.qr_code, secret: data.totp.secret };
  }

  /** Verifies a code for the factor just enrolled, or else for the person's verified factor. */
  async verifyTotp(code: string): Promise<void> {
    const client = this.requireClient();
    const factorId = this.pendingFactorId ?? (await this.verifiedTotpFactorId());
    if (!factorId) throw new AuthError('unknown');
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      throw new AuthError(error.code === 'mfa_verification_failed' ? 'invalid_code' : 'unknown', {
        cause: error,
      });
    }
    this.pendingFactorId = null;
    // The verified session carries aal2; take it now rather than waiting for the event.
    const { data } = await client.auth.getSession();
    this.current.set(data.session);
  }

  /**
   * Ends the session on this device and never throws. The local scope removes the stored session
   * before any network call, so an offline or failing server cannot leave a session that a reload
   * would restore (with the default global scope the client returns `{ error }` and keeps it),
   * and it does not revoke the admin's sessions on their other devices.
   *
   * Signing out also removes every draft on this device: they can hold contact values, and the
   * next person at this browser must not find them. `keepDrafts` is for a session that ENDED
   * (the API answered 401): the admin signs back in and finds what they were typing.
   */
  async signOut(options: { keepDrafts?: boolean } = {}): Promise<void> {
    this.pendingFactorId = null;
    if (!options.keepDrafts) this.drafts.clearAll();
    try {
      await this.client?.auth.signOut({ scope: 'local' });
    } catch (error) {
      console.error('[auth] sign-out reported an error', error);
    } finally {
      this.current.set(null);
    }
  }

  private async verifiedTotpFactorId(): Promise<string | null> {
    const { data, error } = await this.requireClient().auth.mfa.listFactors();
    // A failed lookup must not read as "no factor": that would send an enrolled admin to enrol.
    if (error) throw new AuthError('unknown', { cause: error });
    return data.totp[0]?.id ?? null;
  }

  private requireClient(): SupabaseClient {
    if (!this.client) throw new AuthError('not_configured');
    return this.client;
  }
}
