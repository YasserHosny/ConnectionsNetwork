#!/usr/bin/env node
// Fails when the app uses a Material Symbols icon that the self-hosted subset font lacks
// (public/fonts/material-symbols-outlined.woff2, built by subset-icons.sh from material-icons.txt).
// Without this check a new icon would render as its name ("search", "link_off") in production.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const subset = new Set(
  readFileSync(join(root, 'scripts', 'material-icons.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean),
);

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) yield path;
  }
}

const used = new Map();
for (const file of sources(join(root, 'src', 'app'))) {
  const text = readFileSync(file, 'utf8');
  // <mat-icon ...>name</mat-icon>, and icon: 'name' in data that a template renders as an icon.
  for (const m of text.matchAll(/<mat-icon\b[^>]*>\s*([a-z0-9_]+)\s*<\/mat-icon>/g)) used.set(m[1], file);
  for (const m of text.matchAll(/\bicon:\s*'([a-z0-9_]+)'/g)) used.set(m[1], file);
}

const missing = [...used].filter(([name]) => !subset.has(name));
if (missing.length) {
  for (const [name, file] of missing) console.error(`icon "${name}" (${file.slice(root.length + 1)}) is not in scripts/material-icons.txt`);
  console.error('Add it there and run scripts/subset-icons.sh.');
  process.exit(1);
}
console.log(`icons: all ${used.size} used icons are in the subset font.`);
