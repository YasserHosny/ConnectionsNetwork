import { containsContactValue } from './contact-value';

/**
 * Where to go back to after signing in again (a session that ended, an MFA step that lapsed):
 * carried as `?next=` through /login and /mfa.
 *
 * Only a path inside this app is followed: anything that could leave it (`//host`, a scheme, a
 * backslash) or loop back into sign-in becomes `/`. A fragment is dropped, since the contributor
 * token rides in one. A query value holding a contact value (a link someone opened with an email
 * in it) is dropped too: contact values never go into a URL; the other filters are kept.
 */
const SIGN_IN_PATHS = ['/login', '/mfa', '/c'];

export function safeReturn(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  const [path, query = ''] = value.split('#')[0].split('?');
  if (SIGN_IN_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return '/';
  const kept = query.split('&').filter((pair) => pair && !holdsContactValue(pair.slice(pair.indexOf('=') + 1)));
  return kept.length ? `${path}?${kept.join('&')}` : path;
}

function holdsContactValue(encoded: string): boolean {
  try {
    return containsContactValue(decodeURIComponent(encoded.replace(/\+/g, ' ')));
  } catch {
    return true; // malformed escapes: not worth keeping
  }
}

/** `/login` or `/mfa`, with `?next=` when there is somewhere other than the start to return to. */
export function withReturn(target: '/login' | '/mfa', from: string | null | undefined): string {
  const next = safeReturn(from);
  return next === '/' ? target : `${target}?next=${encodeURIComponent(next)}`;
}
