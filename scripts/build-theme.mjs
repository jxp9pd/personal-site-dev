import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const banner = 'Generated from site/theme.json by scripts/build-theme.mjs. Do not edit.';

function resolveToken(tokens, name, seen = new Set()) {
  if (!(name in tokens)) throw new Error(`Unknown theme token: ${name}`);
  if (seen.has(name)) throw new Error(`Circular theme token: ${name}`);
  return tokens[name].replace(/var\(--([\w-]+)\)/g, (_, dependency) =>
    resolveToken(tokens, dependency, new Set([...seen, name])));
}

function cssProperties(tokens) {
  return Object.entries(tokens).map(([key, value]) =>
    `  ${key === 'color-scheme' ? key : `--${key}`}: ${value};`).join('\n');
}

export async function buildTheme({ check = false } = {}) {
  const theme = JSON.parse(await readFile(resolve(root, 'site/theme.json'), 'utf8'));
  const { tokens } = theme;
  const palette = Object.fromEntries(Object.entries(theme.widgetPalette)
    .map(([key, token]) => [key, resolveToken(tokens, token)]));
  const tiles = Object.fromEntries(Object.entries(theme.boardTiles)
    .map(([code, color]) => [code, resolveToken(tokens, `board-${color}`)]));
  const tokenCSS = `/* ${banner} */\n:root {\n${cssProperties(tokens)}\n}\n` +
    Object.entries(theme.variants).map(([name, values]) =>
      `\n:root[data-theme="${name}"] {\n${cssProperties(values)}\n}\n`).join('');
  const tileCSS = `/* ${banner} */\n` + Object.entries(theme.boardTiles)
    .map(([code, color]) => `:is(.board, .app-board) .tile[data-code="${code}"], .palette .${color} { background: var(--board-${color}); }\n`).join('');
  const tokenJS = `// ${banner}\n` +
    `export const FONT_MONO = ${JSON.stringify(tokens['font-mono'])};\n` +
    `export const FONT_DISPLAY = ${JSON.stringify(tokens['font-display'])};\n` +
    `export const palette = Object.freeze(${JSON.stringify(palette, null, 2)});\n` +
    `export const BOARD_TILE_COLORS = Object.freeze(${JSON.stringify(tiles, null, 2)});\n`;
  const outputs = {
    'fe-artifacts/assets/tokens.css': tokenCSS,
    'fe-artifacts/assets/css/board-tile-colors.css': tileCSS,
    'fe-artifacts/assets/js/ui-theme-tokens.js': tokenJS,
  };
  const changed = [];
  for (const [path, contents] of Object.entries(outputs)) {
    const destination = resolve(root, path);
    const current = await readFile(destination, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current === contents) continue;
    changed.push(path);
    if (!check) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
  }
  if (check && changed.length) throw new Error(`Stale generated theme files:\n${changed.join('\n')}\nRun npm run build:site.`);
  return { changed, files: Object.keys(outputs) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildTheme({ check: process.argv.includes('--check') });
  console.log(`Theme ${process.argv.includes('--check') ? 'checked' : 'built'} (${result.changed.length} changed files).`);
}
