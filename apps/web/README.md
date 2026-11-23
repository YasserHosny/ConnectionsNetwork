# Connections web app

Angular 22 (standalone components, signals), Angular Material, `@ngx-translate`, `@supabase/supabase-js`
and a service worker. Arabic is the default language and the whole UI mirrors in RTL.

## Run

```bash
pnpm install --ignore-workspace --config.strict-dep-builds=false   # own lockfile, as in ProcurePilot
pnpm start                                                          # http://localhost:4200, /api -> :8000
```

Sign-in needs the Supabase project's URL and public (anon) key in `public/runtime-config.json`. The
committed file is a placeholder (local Supabase URL, empty key); edit it locally and do not commit a
real project's values. Deployments overwrite the file, so one build serves any environment. The service
worker never caches it.

## Test and lint

```bash
pnpm test        # Karma + Jasmine, headless Chrome, single run (CHROME_BIN if Chrome is not on the PATH)
pnpm lint        # ESLint, then scripts/check-*.mjs: i18n keys, logical CSS, PWA config
pnpm build       # production build, including the service worker
```

From the repo root, `pnpm lint` and `pnpm test` run these through turbo.

## Structure

```text
src/app/
├── core/      API client, auth (Supabase session, TOTP), mfa guard, locale service, runtime config
├── layout/    the signed-in shell and the language switch
└── features/  auth (login, mfa), contribute (public /c page), placeholders for pages later tasks add
```

Shared code lives outside the app: `packages/i18n` (en.json, ar.json, locale constants) and
`packages/domain-types` (TypeScript mirrors of the API schemas), both reached through the
`@connections/*` path aliases in `tsconfig.json`. The catalogues are served from `/assets/i18n/`
through the `i18n -> ../../packages/i18n` symlink, because Angular only copies assets from inside
the workspace root of the app. A Docker build must therefore copy `packages/` next to `apps/web/`.

## Conventions

- Standalone components, strict TypeScript, no `any`.
- Every user-facing string comes from `packages/i18n`, in both languages (`check-i18n-keys.mjs`).
- CSS logical properties only (`margin-inline-start`, `inset-inline-end`, `text-align: start`),
  enforced by `check-logical-css.mjs`.
- Fonts: Readex Pro (Latin and Arabic) from Google Fonts, with system fallbacks that include Arabic
  (Segoe UI, Tahoma, Noto Sans Arabic). Icons are Material Symbols Outlined from Google Fonts.
- PWA: `manifest.webmanifest` uses a static bilingual name and `dir: auto`; `ngsw-config.json` caches
  the app shell and static assets only, never `/api/` (`dataGroups` stays empty, `check-pwa.mjs`).
- Contact values never go in URLs or query strings: send them in request bodies.
