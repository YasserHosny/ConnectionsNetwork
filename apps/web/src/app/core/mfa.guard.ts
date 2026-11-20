import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';

/** Reachable without a session or without MFA: the sign-in screens and the contributor page. */
const OPEN_PATHS = ['/login', '/mfa', '/c'];

function pathOf(url: string): string {
  // The contributor token travels in the fragment (/c#token): compare the path alone.
  return url.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
}

function isOpen(path: string): boolean {
  return OPEN_PATHS.some((open) => path === open || path.startsWith(`${open}/`));
}

/**
 * Everything except /login, /mfa and /c needs a session that completed TOTP (aal2).
 * No session goes to /login; a password-only session (aal1) goes to /mfa.
 *
 * This is a navigation convenience. The API enforces aal2 itself on every admin endpoint.
 */
export const mfaGuard: CanActivateFn = (_route, state) => {
  if (isOpen(pathOf(state.url))) return true;

  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.session()) return router.parseUrl('/login');
  return auth.aal() === 'aal2' ? true : router.parseUrl('/mfa');
};
