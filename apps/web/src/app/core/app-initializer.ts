import { Location } from '@angular/common';
import { Injector, inject } from '@angular/core';

import { AuthService } from './auth.service';
import { LocaleService } from './locale.service';
import { RuntimeConfig } from './runtime-config';
import { isContributorPath } from './url-path';

/**
 * Runs before the first navigation: the guard reads the restored session synchronously, and the
 * first paint needs the language catalogue.
 *
 * Order matters. The Supabase client is built from `runtime-config.json` the first time
 * AuthService is created, so the config must load first. `inject()` only works before the first
 * `await`, hence the Injector: AuthService is resolved after the config is in.
 *
 * The contributor page (/c) skips the sign-in session altogether.
 */
export async function initializeApp(): Promise<void> {
  const injector = inject(Injector);
  // Read before the first `await`: `inject()` stops working after it.
  const contributorPage = isContributorPath(inject(Location).path());
  await injector.get(RuntimeConfig).load();
  if (contributorPage) {
    // /c is public and runs without an account: AuthService is not even created, because
    // creating it builds the Supabase client, which restores and may refresh a stored session.
    await injector.get(LocaleService).ready();
    return;
  }
  await Promise.all([injector.get(AuthService).init(), injector.get(LocaleService).ready()]);
}
