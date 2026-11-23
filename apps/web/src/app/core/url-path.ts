/** The path of a URL or router state URL, without query, fragment or a trailing slash. */
export function pathOf(url: string): string {
  // The contributor token travels in the fragment (/c#token): compare the path alone.
  return url.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
}

/** The public contributor page (`/c`, `/c/...`): it never uses the sign-in session. */
export function isContributorPath(url: string): boolean {
  const path = pathOf(url);
  return path === '/c' || path.startsWith('/c/');
}
