import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const layouts = new Set(['narrow', 'default', 'wide', 'app']);
const titleSuffix = ' — Penta Projects';
const sharedStyles = new Set([
  'fe-artifacts/assets/tokens.css',
  'fe-artifacts/assets/base.css',
  'fe-artifacts/assets/layout.css',
  'fe-artifacts/assets/components.css',
]);
const exempt = new Set([
  'fe-artifacts/assets/css/board-tile-colors.css',
  'fe-artifacts/assets/css/vestaboard-hub.css',
]);
const colorLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi;
const resetSelector = /(?:^|[},])\s*(\*|html|body|:root)\s*(?=[,{])/g;

async function cssFiles(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : cssFiles(relative);
    return entry.name.endsWith('.css') ? [relative] : [];
  }));
  return nested.flat();
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

export function findStyleIssues(file, css) {
  if (sharedStyles.has(file) || exempt.has(file)) return [];
  const source = stripComments(css);
  const issues = [];
  const colors = source.match(colorLiteral) || [];
  if (colors.length) issues.push(`${file}: ${colors.length} hard-coded color(s); use theme tokens`);
  const resets = new Set([...source.matchAll(resetSelector)].map((match) => match[1]));
  if (resets.size) issues.push(`${file}: restyles ${[...resets].join(', ')}; base.css owns document styles`);
  return issues;
}

export function findPageIssues(pages) {
  const issues = [];
  for (const page of pages) {
    if (page.styleException) continue;
    if (page.assets !== 'site') issues.push(`${page.output}: uses "${page.assets}" assets; pages share the "site" bundle`);
    if (!layouts.has(page.layout)) issues.push(`${page.output}: layout must be one of ${[...layouts].join(', ')}`);
    if (page.inlineStyles) issues.push(`${page.output}: inlineStyles; move page CSS to a stylesheet in "styles"`);
    if (page.output !== 'index.html' && !page.title.endsWith(titleSuffix)) issues.push(`${page.output}: title should end with "${titleSuffix}"`);
  }
  return issues;
}

export async function checkStyles({ strict = false, verbose = false } = {}) {
  const pages = JSON.parse(await readFile(path.join(root, 'site/pages.json'), 'utf8'));
  const files = [...await cssFiles('fe-artifacts/assets'), ...await cssFiles('fe-artifacts/reports'), ...await cssFiles('site/styles')];
  const styleIssues = (await Promise.all(files.map(async (file) => findStyleIssues(file, await readFile(path.join(root, file), 'utf8'))))).flat();
  const issues = [...findPageIssues(pages), ...styleIssues];
  if (!issues.length) {
    console.log('Style guard: no issues.');
    return issues;
  }
  if (strict) throw new Error(`Style guard found ${issues.length} issue(s):\n  ${issues.join('\n  ')}`);
  console.warn(`Style guard: ${issues.length} issue(s)${verbose ? '' : ' (npm run check:styles for details)'}.`);
  if (verbose) for (const issue of issues) console.warn(`  ${issue}`);
  return issues;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkStyles({ strict: process.argv.includes('--strict'), verbose: true }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
