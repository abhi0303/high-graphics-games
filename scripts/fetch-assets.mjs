#!/usr/bin/env node
// Downloads every third-party asset the game uses into public/assets (and raw
// sources that need preprocessing into asset-src/). Re-running skips files that
// already exist. All Poly Haven assets are CC0; the Ferrari model is CC-BY 4.0
// (see ASSETS.md).
import { mkdir, writeFile, access, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public', 'assets');
const SRC = join(ROOT, 'asset-src');

// [polyhaven id, resolution]
const TEXTURES = [
  ['asphalt_02', '2k'],
  ['asphalt_01', '2k'],
  ['concrete_floor_worn_001', '2k'],
  ['brushed_concrete', '1k'],
  ['concrete_wall_008', '1k'],
  ['beige_wall_001', '1k'],
  ['painted_plaster_wall', '1k'],
  ['white_stucco', '1k'],
  ['yellow_plaster', '1k'],
  ['red_brick_03', '1k'],
  ['large_red_bricks', '1k'],
  ['whitewashed_brick', '1k'],
  ['exterior_wall_cladding', '1k'],
  ['corrugated_iron_02', '1k'],
  ['painted_metal_shutter', '1k'],
  ['rectangular_facade_tiles', '1k'],
  ['concrete_tile_facade', '1k'],
  ['bitumen', '1k'],
];

const HDRIS = [
  ['kloofendal_43d_clear_puresky', '4k'],
  ['kloofendal_48d_partly_cloudy_puresky', '4k'],
];

// Poly Haven models. These are dense photogrammetry scans, so they are downloaded
// to asset-src/ and turned into lightweight runtime GLBs by
// `npm run process-assets` (Blender), which writes public/assets/models/{props,trees}.
const RAW_MODELS = [
  ['island_tree_01', '1k'],
  ['utility_box_01', '1k'],
  ['utility_box_02', '1k'],
  ['exterior_aircon_unit', '1k'],
  ['modular_electricity_poles', '1k'], // only its wood texture is used (utility poles)
  ['water_manhole_cover', '1k'],
  ['shrub_01', '1k'],
  ['shrub_04', '1k'],
  ['trashbag', '1k'],
  ['fire_hydrant', '1k'],
  ['concrete_road_barrier', '1k'],
  ['old_tyre', '1k'],
  ['barrel_03', '1k'],
  ['wooden_crate_02', '1k'],
  ['plastic_crate_01', '1k'],
  ['cardboard_box_01', '1k'],
];

const EXTRA = [
  // Ferrari 458 Italia by vicent091036 (CC-BY 4.0), as redistributed in the three.js examples.
  ['https://raw.githubusercontent.com/mrdoob/three.js/r176/examples/models/gltf/ferrari.glb', join(PUB, 'models', 'ferrari', 'ferrari.glb')],
  ['https://raw.githubusercontent.com/mrdoob/three.js/r176/examples/models/gltf/ferrari_ao.png', join(PUB, 'models', 'ferrari', 'ferrari_ao.png')],
];

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, dest) {
  if (await exists(dest)) return false;
  await mkdir(dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      console.log('  ✓', dest.replace(ROOT + '/', ''));
      return true;
    } catch (err) {
      if (attempt === 2) throw new Error(`Failed ${url}: ${err.message}`);
    }
  }
}

async function pool(jobs, size = 6) {
  const queue = [...jobs];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await queue.shift()();
  }));
}

const api = (id) => fetch(`https://api.polyhaven.com/files/${id}`).then((r) => r.json());

async function main() {
  const jobs = [];

  for (const [id, res] of TEXTURES) {
    const files = await api(id);
    for (const map of ['Diffuse', 'nor_gl', 'arm']) {
      const f = files[map]?.[res]?.jpg;
      if (!f) throw new Error(`${id} has no ${map} ${res}`);
      jobs.push(() => download(f.url, join(PUB, 'textures', id, `${id}_${map === 'Diffuse' ? 'diff' : map}_${res}.jpg`)));
    }
  }

  for (const [id, res] of HDRIS) {
    const files = await api(id);
    jobs.push(() => download(files.hdri[res].hdr.url, join(PUB, 'hdri', `${id}_${res}.hdr`)));
  }

  const addModel = async (id, res, baseDir) => {
    const files = await api(id);
    const g = files.gltf[res].gltf;
    const dir = join(baseDir, id);
    jobs.push(() => download(g.url, join(dir, `${id}.gltf`)));
    for (const [rel, f] of Object.entries(g.include)) jobs.push(() => download(f.url, join(dir, rel)));
  };
  for (const [id, res] of RAW_MODELS) await addModel(id, res, SRC);

  for (const [url, dest] of EXTRA) jobs.push(() => download(url, dest));

  console.log(`Fetching ${jobs.length} files (existing files are skipped)…`);
  await pool(jobs);

  // Draco decoder (served from public/draco) for the compressed car / tree / prop meshes.
  const dracoSrc = join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
  for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) {
    const dest = join(ROOT, 'public', 'draco', f);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(dracoSrc, f), dest);
  }

  // Weathered wood for the procedural utility poles.
  const wood = join(SRC, 'modular_electricity_poles', 'textures', 'modular_electricity_poles_');
  for (const [from, to] of [['diff_1k.jpg', 'pole_wood_diff_1k.jpg'], ['nor_gl_1k.jpg', 'pole_wood_nor_gl_1k.jpg']]) {
    const dest = join(PUB, 'textures', 'pole_wood', to);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(wood + from, dest);
  }
  console.log('Done. If public/assets/models/props or /trees are missing, run `npm run process-assets` (needs Blender).');
}

main().catch((e) => { console.error(e); process.exit(1); });
