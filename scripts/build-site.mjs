#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildTheme } from './build-theme.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(root, 'site');
const outputRoot = path.join(root, 'fe-artifacts');
const readSource = (file) => readFile(path.join(sourceRoot, file), 'utf8');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function attributes(values = {}) {
  return Object.entries(values).map(([name, value]) => {
    if (!/^[a-z][a-z0-9-]*$/i.test(name)) throw new Error(`Invalid attribute: ${name}`);
    if (value === false || value == null) return '';
    return value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`;
  }).join('');
}

function render(template, values) {
  return template.replace(/{{([a-zA-Z]+)}}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing template value: ${key}`);
    return values[key];
  }).trimEnd();
}

function safePath(directory, file) {
  const resolved = path.resolve(directory, file);
  if (!resolved.startsWith(`${directory}${path.sep}`)) throw new Error(`Invalid path: ${file}`);
  return resolved;
}

async function filesWithExtension(directory, extension, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) return filesWithExtension(path.join(directory, entry.name), extension, relative);
    return entry.name.endsWith(extension) ? [relative] : [];
  }));
  return files.flat();
}

export async function buildSite({ check = false } = {}) {
  await buildTheme({ check });
  const [config, pages, theme, templateNames] = await Promise.all([
    readSource('config.json').then(JSON.parse),
    readSource('pages.json').then(JSON.parse),
    readSource('theme.json').then(JSON.parse),
    readdir(path.join(sourceRoot, 'templates')),
  ]);
  const templates = Object.fromEntries(await Promise.all(templateNames.map(async (name) => [
    name.replace(/\.html$/, ''), await readSource(`templates/${name}`),
  ])));
  const hashes = new Map();
  async function versionedAsset(href, output) {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) return href;
    const url = new URL(href, `https://site.local/${output}`);
    const file = safePath(outputRoot, decodeURIComponent(url.pathname.slice(1)));
    if (!hashes.has(file)) hashes.set(file, createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 12));
    return `${href.split(/[?#]/)[0]}?v=${hashes.get(file)}${url.hash}`;
  }
  const modulePaths = await filesWithExtension(path.join(outputRoot, 'assets/js'), '.js');
  const imports = {};
  for (const modulePath of modulePaths.sort()) {
    const href = `/assets/js/${modulePath}`;
    imports[href] = await versionedAsset(href, 'index.html');
    const code = await readFile(path.join(outputRoot, href.slice(1)), 'utf8');
    for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])([^'"]+)\1/g)) {
      if (!match[2].startsWith('.')) continue;
      const dependency = new URL(match[2], `https://site.local${href}`);
      const key = `${dependency.pathname}${dependency.search}`;
      imports[key] = await versionedAsset(key, 'index.html');
    }
  }
  const importMap = JSON.stringify({ imports: Object.fromEntries(Object.entries(imports).sort(([a], [b]) => a.localeCompare(b))) });
  const outputs = new Set();
  const stale = [];

  for (const page of pages) {
    if (outputs.has(page.output)) throw new Error(`Duplicate output: ${page.output}`);
    outputs.add(page.output);
    const bundle = config.assetBundles[page.assets];
    if (!bundle) throw new Error(`Unknown asset bundle: ${page.assets}`);
    const head = [
      '  <meta charset="utf-8" />',
      `  <meta name="viewport" content="${escapeHtml(page.viewport || 'width=device-width, initial-scale=1')}" />`,
      `  <title>${escapeHtml(page.title)}</title>`,
    ];
    if (page.description) head.push(`  <meta name="description" content="${escapeHtml(page.description)}" />`);
    if (page.canonical) head.push(`  <link rel="canonical" href="${escapeHtml(page.canonical)}" />`);
    for (const meta of page.meta || []) head.push(`  <meta${attributes(meta)} />`);
    if (bundle.fonts) {
      const fontUrl = theme.fonts.imports[bundle.fonts];
      if (!fontUrl) throw new Error(`Unknown font import: ${bundle.fonts}`);
      head.push(
        '  <link rel="preconnect" href="https://fonts.googleapis.com" />',
        '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
        `  <link href="${escapeHtml(fontUrl)}" rel="stylesheet" />`,
      );
    }
    const styles = [...bundle.styles, ...(page.styles || [])];
    for (const href of styles) {
      head.push(`  <link rel="stylesheet" href="${escapeHtml(await versionedAsset(href, page.output))}" />`);
    }
    if (page.inlineStyles) head.push(`<style>\n${await readSource(page.inlineStyles)}</style>`);
    let source = await readSource(page.source);
    if (page.scripts?.some((script) => script.type === 'module') || /<script\b[^>]*type=["']module["']/.test(source)) {
      head.push(`  <script type="importmap">${importMap}</script>`);
    }
    for (const script of page.scripts || []) {
      head.push(`  <script${attributes({ ...script, src: await versionedAsset(script.src, page.output) })}></script>`);
    }
    const bodyScriptSources = [...source.matchAll(/(<script\b[^>]*\bsrc=")([^"]+)(")/g)];
    for (const [, before, href, after] of bodyScriptSources) {
      source = source.replace(`${before}${href}${after}`, `${before}${escapeHtml(await versionedAsset(href, page.output))}${after}`);
    }

    const shared = { home: escapeHtml(config.brand.href), brand: escapeHtml(config.brand.name) };
    let header = '';
    if (page.header) {
      const variant = page.header.variant || 'header';
      if (!['header', 'hub', 'profile'].includes(variant)) throw new Error(`Unknown header: ${variant}`);
      header = render(templates[variant === 'header' ? 'header' : `${variant}-header`], {
        ...shared,
        class: page.header.class ? ` ${escapeHtml(page.header.class)}` : '',
        navigation: config.navigation.map((entry) => render(templates['navigation-link'], {
          href: escapeHtml(entry.href),
          label: escapeHtml(entry.label),
          current: entry.id === page.section ? ' aria-current="page"' : '',
          arrow: page.header.arrows ? ' <span class="arrow" aria-hidden="true">&rarr;</span>' : '',
        })).join('\n'),
        profileMount: page.header.profileMount ? `    <div id="${escapeHtml(page.header.profileMount)}"></div>` : '',
      });
    }
    let listing = '';
    if (page.listing) {
      listing = render(templates.listing, {
        class: escapeHtml(page.listing.class || 'content'),
        title: escapeHtml(page.listing.title),
        description: page.listing.description ? `  <p class="page-sub reveal d1">${escapeHtml(page.listing.description)}</p>` : '',
        entries: page.listing.entries.map((entry) => render(templates.entry, {
          href: escapeHtml(entry.href), title: escapeHtml(entry.title), description: escapeHtml(entry.description),
          date: entry.date ? `          <span class="entry-desc"><time datetime="${escapeHtml(entry.date.iso)}">${escapeHtml(entry.date.label)}</time></span>` : '',
        })).join('\n'),
      });
    }
    const body = render(source, { header, listing });
    const html = `${render(templates.document, {
      htmlAttributes: attributes(page.htmlAttributes), bodyAttributes: attributes(page.bodyAttributes),
      head: head.join('\n'), body,
    })}\n`;
    const destination = safePath(outputRoot, page.output);
    const previous = await readFile(destination, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous === html) continue;
    if (check) stale.push(page.output);
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, html);
    }
  }

  const unmanaged = (await filesWithExtension(outputRoot, '.html')).filter((file) => !outputs.has(file));
  if (unmanaged.length) throw new Error(`HTML pages missing from site/pages.json: ${unmanaged.join(', ')}`);
  if (stale.length) throw new Error(`Generated pages are stale: ${stale.join(', ')}. Run npm run build:site.`);
  console.log(`${check ? 'Verified' : 'Built'} ${pages.length} static pages.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) {
    console.error('Usage: node scripts/build-site.mjs [--check]');
    process.exitCode = 1;
  } else {
    buildSite({ check: args.includes('--check') }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
