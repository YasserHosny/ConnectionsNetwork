const HTTP_URL = /^https?:\/\//i;
/** Starts with a scheme (`javascript:`, `mailto:`), as opposed to a host with a port (`x.com:8080`). */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

/**
 * Where a stored social link opens: always a web address, never a path inside this app.
 *
 * An `href` without a scheme ("linkedin.com/in/sara") would resolve against our own origin, so
 * it gets `https://`. Anything with another scheme (`javascript:`, `data:`, `mailto:`) or a
 * scheme-relative `//host` gets no link at all: null, and the text is shown as it is. The API
 * stores new links as http(s) already; this also covers what was saved before that rule.
 */
export function webHref(url: string): string | null {
  const value = url.trim();
  if (!value) return null;
  if (HTTP_URL.test(value)) return value;
  if (value.startsWith('//') || OTHER_SCHEME.test(value)) return null;
  return `https://${value}`;
}
