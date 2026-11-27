#!/usr/bin/env node
// Fails when the app loads a font from a third party. Fonts are self-hosted (Readex Pro from
// @fontsource, the icons from public/fonts): a blocked or failing font CDN must not change how the
// app looks, and the CSP must not allow one either (infra/nginx/security-headers.inc).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const THIRD_PARTY = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net/;
const files = ['src/index.html', 'src/styles.scss', '../../infra/nginx/security-headers.inc'];

const problems = files.flatMap((file) =>
  readFileSync(join(root, file), 'utf8')
    .split('\n')
    .map((line, i) => [line, i + 1])
    .filter(([line]) => THIRD_PARTY.test(line) && !line.trim().startsWith('#'))
    .map(([, n]) => `${file}:${n} loads or allows a third-party font host`),
);
// The policy itself: fonts only from this origin, and no external stylesheet that could pull a font
// in some other way, whatever the host is called.
const csp = readFileSync(join(root, '../../infra/nginx/security-headers.inc'), 'utf8').match(/Content-Security-Policy "([^"]*)"/)?.[1];
const sources = (name) => csp?.split(';').map((d) => d.trim().split(/\s+/)).find(([d]) => d === name)?.slice(1);
if (!csp) {
  problems.push('infra/nginx/security-headers.inc: no Content-Security-Policy found');
} else {
  if (sources('font-src')?.join(' ') !== "'self'") problems.push(`CSP font-src must be exactly 'self' (is: ${sources('font-src')?.join(' ') ?? 'missing'})`);
  const extraStyles = (sources('style-src') ?? []).filter((s) => !["'self'", "'unsafe-inline'"].includes(s));
  if (extraStyles.length) problems.push(`CSP style-src allows ${extraStyles.join(' ')}: stylesheets come from this origin only`);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log('fonts: all self-hosted; the CSP allows no font host.');
