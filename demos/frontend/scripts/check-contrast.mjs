// Asserts WCAG AA (4.5:1) for every documented text/background token pair,
// in each theme block of src/styles/tokens.css. Run: npm run check:contrast
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'styles', 'tokens.css'), 'utf8');

function block(selector) {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return {};
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  const vars = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[m[1]] = m[2];
  return vars;
}

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background] pairs used for text in the UI (token names as in tokens.css, the ozgurkarahan.com roles).
const PAIRS = [
  ['c-ink', 'c-canvas'], ['c-ink', 'c-surface'], ['c-ink', 'c-brand-soft'], ['c-ink', 'c-tint'],
  ['c-muted', 'c-canvas'], ['c-muted', 'c-surface'], ['c-muted', 'c-tint'],
  ['c-brand', 'c-canvas'], ['c-brand', 'c-surface'], ['c-brand', 'c-brand-soft'],
  ['c-on-brand', 'c-brand'], ['c-brand-mid', 'c-canvas'], ['c-brand-mid', 'c-brand-soft'],
  ['c-accent-text', 'c-canvas'], ['c-accent-text', 'c-surface'], ['c-accent-text', 'c-accent-soft'],
  ['c-danger', 'c-danger-50'], ['c-danger', 'c-canvas'], ['c-canvas', 'c-ink'],
  ['c-on-deep', 'c-deep'], ['c-on-deep-muted', 'c-deep'], ['c-brand-on-deep', 'c-deep'], ['c-on-cta', 'c-cta'],
];

const base = block(':root');
const themes = {
  light: base,
  'teams-dark': { ...base, ...block("[data-theme='teams-dark']") },
  'teams-contrast': { ...base, ...block("[data-theme='teams-contrast']") },
};

let failures = 0;
for (const [name, vars] of Object.entries(themes)) {
  for (const [fg, bg] of PAIRS) {
    if (!vars[fg] || !vars[bg]) continue;
    const r = ratio(vars[fg], vars[bg]);
    const ok = r >= 4.5;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(15)} ${fg.padEnd(11)} on ${bg.padEnd(11)} ${r.toFixed(2)}`);
  }
}
if (failures) {
  console.error(`\n${failures} pair(s) below 4.5:1`);
  process.exit(1);
}
console.log('\nAll text token pairs meet WCAG AA.');
