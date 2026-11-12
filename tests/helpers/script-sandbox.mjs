// Builds a throwaway copy of a checkout's admin scripts plus synthetic seed
// data (data/packs, data/quizzes and data/pack-images are git-ignored), then
// runs scripts there with fetch replaced by capture-fetch.mjs.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAPTURE = fileURLToPath(new URL('./capture-fetch.mjs', import.meta.url));
const PACKS = ['wearables', 'groceries', 'starter-pack', 'costco'];
const QUIZZES = ['sf', 'seattle', 'dc', 'fairfax', 'manhattan'].map(city => `${city}-neighborhoods`);

export async function createScriptSandbox(checkout) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supabase-scripts-'));
  await cp(path.join(checkout, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'fe-artifacts/assets/js'), { recursive: true });
  await cp(
    path.join(checkout, 'fe-artifacts/assets/js/config.js'),
    path.join(root, 'fe-artifacts/assets/js/config.js'),
  );
  await cp(path.join(checkout, 'tests/fixtures/atlas/publish'), path.join(root, 'atlas-fixture'), {
    recursive: true,
  });

  await mkdir(path.join(root, 'data/packs/art'), { recursive: true });
  for (const [index, slug] of PACKS.entries()) {
    const pack = {
      slug,
      name: `Pack ${slug}`,
      description: `About ${slug}`,
      ...(index === 0 ? { sort_order: 9 } : {}),
      items: [
        { name: `${slug} one`, price: 1.5, image_url: `https://example.test/${slug}.png` },
        { name: `${slug} two`, price: 20 },
      ],
    };
    await writeFile(path.join(root, `data/packs/${slug}.data.json`), JSON.stringify(pack));
  }
  await writeFile(path.join(root, 'data/packs/art/wearables.svg'), '<svg id="wearables"/>\n');

  await mkdir(path.join(root, 'data/quizzes/art'), { recursive: true });
  for (const slug of QUIZZES) {
    const geo = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: slug }, geometry: null }],
    };
    await writeFile(path.join(root, `data/quizzes/${slug}.data.json`), JSON.stringify({ geo }));
  }
  await writeFile(path.join(root, 'data/quizzes/art/sf-neighborhoods.svg'), '<svg id="sf"/>');

  for (const [pack, files] of [['costco', ['b.jpg', 'a.png', 'notes.txt']], ['wearables', ['c.webp']]]) {
    await mkdir(path.join(root, `data/pack-images/${pack}`), { recursive: true });
    for (const file of files) {
      await writeFile(path.join(root, `data/pack-images/${pack}/${file}`), `bytes of ${pack}/${file}`);
    }
  }

  return {
    root,
    async run(script, args = [], env = {}) {
      const captureFile = path.join(root, 'capture.json');
      await rm(captureFile, { force: true });
      const result = spawnSync(process.execPath, ['--import', CAPTURE, `scripts/${script}`, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, CAPTURE_FILE: captureFile, ...env },
      });
      let requests = [];
      try {
        requests = JSON.parse(await readFile(captureFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const clean = text => text.split(root).join('<sandbox>');
      return { status: result.status, stdout: clean(result.stdout), stderr: clean(result.stderr), requests };
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
