#!/usr/bin/env node
// Rebuilds the runtime GLBs from the raw Poly Haven downloads in asset-src/
// using Blender in background mode (tools/*.py). The outputs are committed in
// public/assets/models, so this is only needed to regenerate or retune them.
//   BLENDER=/path/to/blender npm run process-assets
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLENDER = [process.env.BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].find((p) => p && (p === 'blender' || existsSync(p)));
const SRC = join(ROOT, 'asset-src');
const OUT = join(ROOT, 'public', 'assets', 'models');
mkdirSync(join(OUT, 'props'), { recursive: true });
mkdirSync(join(OUT, 'trees'), { recursive: true });

const run = (script, args) => {
  const r = spawnSync(BLENDER, ['-b', '--python', join(ROOT, 'tools', script), '--', ...args], { encoding: 'utf8' });
  const lines = (r.stdout + r.stderr).split('\n').filter((l) => /faces|kept|wrote|Error/.test(l));
  console.log(lines.join('\n'));
  if (r.status !== 0) throw new Error(`Blender failed on ${args[0]}`);
};

// Scanned tree -> three LODs: [leaf keep fraction, leaf scale, twig keep fraction, decimate ratio]
const tree = join(SRC, 'island_tree_01', 'island_tree_01.gltf');
for (const [name, p] of [['hero', [0.42, 1.62, 0.32, 0.35]], ['lod0', [0.2, 1.6, 0.25, 0.3]], ['lod1', [0.06, 2.6, 0.08, 0.2]]]) {
  run('process_tree.py', [tree, join(OUT, 'trees', `island_tree_${name}.glb`), ...p.map(String)]);
}

// Props: [source id, output name, decimate ratio, optional variant filter]
const PROPS = [
  ['fire_hydrant', 'fire_hydrant', 0.12, 'aged'],
  ['shrub_01', 'shrub_01', 0.1],
  ['shrub_04', 'shrub_04', 0.6],
  ['concrete_road_barrier', 'road_barrier', 0.06],
  ['utility_box_01', 'utility_box_01', 0.5],
  ['utility_box_02', 'utility_box_02', 0.5],
  ['trashbag', 'trashbag', 0.35],
  ['exterior_aircon_unit', 'aircon', 0.3, 'rusted'],
  ['water_manhole_cover', 'manhole', 0.25],
  ['old_tyre', 'old_tyre', 0.5],
  ['barrel_03', 'barrel_03', 1.0],
  ['wooden_crate_02', 'wooden_crate_02', 0.4],
  ['plastic_crate_01', 'plastic_crate_01', 0.15],
  ['cardboard_box_01', 'cardboard_box_01', 0.1],
];
for (const [id, out, ratio, filter] of PROPS) {
  run('decimate_prop.py', [join(SRC, id, `${id}.gltf`), join(OUT, 'props', `${out}.glb`), String(ratio), ...(filter ? [filter] : [])]);
}
console.log('done');
