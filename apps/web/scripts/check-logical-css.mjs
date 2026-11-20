#!/usr/bin/env node
// "CSS logical properties only": the app must mirror in RTL, so styles in apps/web/src use
// inline/block properties (margin-inline-start, inset-inline-end, text-align: start) and never
// their physical left/right forms. Checks .scss files and inline `styles` in components.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

const PHYSICAL = [
  [/\b(?:margin|padding|border)-(?:left|right)\b/, 'use the -inline-start/-inline-end form'],
  [/\bborder-(?:top|bottom)-(?:left|right)-radius\b/, 'use border-start-start-radius etc.'],
  [/(?<![\w-])(?:left|right)\s*:/, 'use inset-inline-start / inset-inline-end'],
  [/\btext-align\s*:\s*(?:left|right)\b/, 'use text-align: start / end'],
  [/\bfloat\s*:\s*(?:left|right)\b/, 'use float: inline-start / inline-end'],
  [/\bclear\s*:\s*(?:left|right)\b/, 'use clear: inline-start / inline-end'],
  [/\bscroll-(?:margin|padding)-(?:left|right)\b/, 'use the -inline form'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(scss|css|ts|html)$/.test(name) && !/\.spec\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(src)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [pattern, hint] of PHYSICAL) {
      if (pattern.test(line)) {
        problems.push(`${relative(join(here, '..'), file)}:${i + 1}: ${line.trim()}  (${hint})`);
      }
    }
  });
}

if (problems.length) {
  console.error(`Physical CSS properties found (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('css: logical properties only in apps/web/src.');
