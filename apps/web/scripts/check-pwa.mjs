#!/usr/bin/env node
// Guards the PWA's privacy properties: the service worker caches the app shell and static assets
// only, never an API response (contact details must not outlive a sign-out in a cache), and the
// manifest keeps its bilingual name and automatic direction.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

const problems = [];
const ngsw = read('ngsw-config.json');
const manifest = read('public/manifest.webmanifest');

if (!Array.isArray(ngsw.dataGroups) || ngsw.dataGroups.length !== 0) {
  problems.push('ngsw-config.json: dataGroups must be empty (no runtime caching of API responses)');
}
const everyPattern = (ngsw.assetGroups ?? []).flatMap((g) => g.resources?.files ?? []);
for (const pattern of [...everyPattern, ...(ngsw.assetGroups ?? []).flatMap((g) => g.resources?.urls ?? [])]) {
  if (pattern.includes('/api') || pattern.includes('runtime-config')) {
    problems.push(`ngsw-config.json: '${pattern}' would cache an API response or the runtime config`);
  }
}
if (!(ngsw.navigationUrls ?? []).includes('!/api/**')) {
  problems.push("ngsw-config.json: navigationUrls must exclude '!/api/**'");
}
if (manifest.dir !== 'auto') problems.push("manifest.webmanifest: dir must be 'auto'");
if (!/[؀-ۿ]/.test(manifest.name) || !/Connections/.test(manifest.name)) {
  problems.push('manifest.webmanifest: name must be bilingual (Arabic and "Connections")');
}

if (problems.length) {
  console.error(`PWA config problems:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('pwa: service worker caches the app shell only; manifest is bilingual with dir=auto.');
