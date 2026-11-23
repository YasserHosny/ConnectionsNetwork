export const environment = {
  /** Same origin behind Nginx in production; `proxy.conf.json` forwards it to :8000 in dev. */
  apiBaseUrl: '/api/v1',
} as const;
