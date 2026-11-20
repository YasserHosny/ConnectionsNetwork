import { Injector, inject } from '@angular/core';

import { AuthService } from './auth.service';
import { LocaleService } from './locale.service';
import { RuntimeConfig } from './runtime-config';

/**
 * Runs before the first navigation: the guard reads the restored session synchronously, and the
 * first paint needs the language catalogue.
 *
 * Order matters. The Supabase client is built from `runtime-config.json` the first time
 * AuthService is created, so the config must load first. `inject()` only works before the first
 * `await`, hence the Injector: AuthService is resolved after the config is in.
 */
export async function initializeApp(): Promise<void> {
  const injector = inject(Injector);
  await injector.get(RuntimeConfig).load();
  await Promise.all([injector.get(AuthService).init(), injector.get(LocaleService).ready()]);
}
