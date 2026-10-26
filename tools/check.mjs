// Repo checks: required files, no install prompt, relative paths, side-effect-free entries, no brand names.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const problems = [];
const fail = (m) => problems.push(m);
const read = (p) => readFileSync(p, 'utf8');

for (const f of ['DESIGN.md', 'STATUS.md', 'NOTES.md', 'AGENTS.md', 'wrangler.jsonc', 'index.html', 'm/index.html', 'c/index.html', 'manifest.webmanifest', 'sw.js']) {
  if (!existsSync(f)) fail(`missing ${f}`);
}

// every page linking a manifest cancels the install prompt; pages use relative paths
for (const f of ['index.html', 'm/index.html', 'c/index.html']) {
  if (!existsSync(f)) continue;
  const html = read(f);
  if (html.includes('rel="manifest"') && !/beforeinstallprompt['"],\s*e\s*=>\s*e\.preventDefault\(\)/.test(html)) fail(`${f}: must cancel beforeinstallprompt`);
  if (/(?:href|src)="\/[^/]/.test(html)) fail(`${f}: use relative paths`);
  if (/from '\/[^/]/.test(html)) fail(`${f}: use relative import paths`);
}

// no brand names in app files (the word is built from parts so this file does not contain it)
const banned = new RegExp('phil' + 'ips', 'i');
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', '.wrangler', 'vendor'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const textExt = new Set(['.js', '.mjs', '.html', '.json', '.css', '.svg', '.webmanifest']);
for (const p of walk('.')) {
  if (p.startsWith('tools') || p === 'package-lock.json') continue;
  if (textExt.has(extname(p)) && banned.test(read(p))) fail(`${p}: brand name`);
}

// entries are side-effect free: importing adds no globals and does not touch the DOM or network
const pkg = JSON.parse(read('package.json'));
const before = new Set(Object.getOwnPropertyNames(globalThis));
for (const [name, path] of Object.entries(pkg.exports)) {
  try { await import(new URL(path, `file://${process.cwd()}/`).href); } catch (e) { fail(`entry ${name}: import threw ${e.message}`); }
}
const added = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
if (added.length) fail(`entries added globals: ${added.join(', ')}`);

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('checks ok');
