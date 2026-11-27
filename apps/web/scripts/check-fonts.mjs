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
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log('fonts: all self-hosted; the CSP allows no font host.');
