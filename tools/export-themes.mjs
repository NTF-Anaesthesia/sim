// Rewrites themes/*.json from the built-in themes (run after changing src/theme/default.js or builtin.js).
import { writeFileSync, mkdirSync } from 'node:fs';
import { BUILTIN_THEMES } from '../src/theme/builtin.js';
import { exportTheme, validateTheme } from '../src/theme/validate.js';

const names = { default: 'generic-dark', light: 'generic-light' };
mkdirSync('themes', { recursive: true });
for (const b of BUILTIN_THEMES) writeFileSync(`themes/${names[b.id]}.json`, exportTheme(validateTheme(b.theme).theme));
console.log('themes written');
