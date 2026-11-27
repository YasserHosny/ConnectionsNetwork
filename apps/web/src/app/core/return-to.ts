/**
 * Where to go back to after signing in again (a session that ended, an MFA step that lapsed):
 * carried as `?next=` through /login and /mfa.
 *
 * Only a path inside this app is followed: anything that could leave it (`//host`, a scheme, a
 * backslash) or loop back into sign-in becomes `/`. A fragment is dropped, since the contributor
 * token rides in one. Search queries are fine here: contact values never reach a URL (ApiClient
 * and the search page refuse them).
 */
const SIGN_IN_PATHS = ['/login', '/mfa', '/c'];

export function safeReturn(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  const url = value.split('#')[0];
  const path = url.split('?')[0];
  if (SIGN_IN_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return '/';
  return url;
}

/** `/login` or `/mfa`, with `?next=` when there is somewhere other than the start to return to. */
export function withReturn(target: '/login' | '/mfa', from: string | null | undefined): string {
  const next = safeReturn(from);
  return next === '/' ? target : `${target}?next=${encodeURIComponent(next)}`;
}
