import * as THREE from 'three';
import { computeBlocks, SIDEWALK_W, rng } from './layout.js';

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const STUCCO = ['#ece2cc', '#dccaa9', '#cdb693', '#e5d6b8', '#bca686', '#d9d1c4', '#c9d2c9', '#e8cdaf', '#d0d8de', '#f2eee4', '#b9ab9b', '#d9b78f', '#a9bcc6', '#e3b07a', '#c4a9a0'].map(lin);
const BRICKISH = ['#ffffff', '#f0e6dc', '#e2d4c8', '#d8d2cc'].map(lin);
const TRIM = ['#f2efe8', '#ddd7cb', '#8f877d', '#56504a', '#eae4d6'].map(lin);
const FRAMES = ['#e8e8e4', '#3b3129', '#1b1b1b', '#babdc0', '#6f6a63'].map(lin);
const AWNINGS = ['#9e1d1d', '#1f4c86', '#2a6638', '#bf5a1d', '#383838', '#cfa92c', '#73204a', '#2f6f74'].map(lin);

const WINDOW_STYLES = {
  apt: { bay: 3.3, w: 1.35, h: 1.6, sill: 0.95, recess: 0.2, mullion: true, lintel: true },
  shop: { bay: 3.6, w: 1.8, h: 1.5, sill: 1.0, recess: 0.16, mullion: true },
  office: { bay: 3.0, w: 2.35, h: 2.0, sill: 0.8, recess: 0.14, mullion: false },
  old: { bay: 2.9, w: 1.15, h: 1.95, sill: 0.85, recess: 0.24, mullion: 'cross', lintel: true },
};

let signCursor = 0;
const GENERIC_SIGNS = ['liquor', 'tires', 'laundry', 'tacos', 'pawn', 'phones', 'beauty', 'dental', 'pizza', 'insure', 'market', 'smog', 'nails', 'cash', 'donut', 'pho', 'buffet'];

export function planCity() {
  const blocks = computeBlocks();
  const specs = [];
  const extras = { parking: [], fences: [], poleSigns: [], billboards: [], plazas: [], trees: [], storefronts: [], yards: [], bushes: [] };
  for (const b of blocks) planBlock(b, specs, extras);
  return { blocks, specs, extras };
}

function makeSpec(R, base) {
  const kind = base.type;
  const wall = base.wall ?? R.pick(kind === 'industrial' ? ['corrugated', 'concrete', 'cladding'] :
    kind === 'office' ? ['tiles', 'concrete', 'beige', 'stucco'] :
      ['stucco', 'stucco', 'beige', 'plaster', 'yellowPlaster', 'brickRed', 'brickLarge', 'brickWhite', 'cladding']);
  const brick = wall.startsWith('brick');
  const spec = {
    seed: Math.floor(R() * 1e9),
    floors: 1,
    floorH: 3.3,
    groundH: 4.6,
    parapet: R.range(0.5, 1.4),
    wall,
    wallColor: brick || wall === 'corrugated' || wall === 'tiles' ? R.pick(BRICKISH) : R.pick(STUCCO),
    trimColor: R.pick(TRIM),
    frameColor: R.pick(FRAMES),
    front: 'storefront', back: 'blank', left: 'blank', right: 'blank',
    win: WINDOW_STYLES[brick ? 'old' : kind === 'office' ? 'office' : kind === 'apt' ? 'apt' : 'shop'],
    cornice: brick && R.chance(0.7),
    bands: kind === 'office' || (brick && R.chance(0.5)),
    detail: 2,
    ...base,
  };
  if (spec.front === 'storefront' && spec.sign === undefined && R.chance(0.85)) {
    spec.sign = GENERIC_SIGNS[signCursor++ % GENERIC_SIGNS.length];
  }
  if (spec.front === 'storefront' && spec.awning === undefined && R.chance(0.45)) spec.awning = R.pick(AWNINGS);
  return spec;
}

function typeFor(R, dist, outer) {
  if (outer) return R.pick(['apt', 'apt', 'office', 'shop2', 'office']);
  if (dist < 130) return R.pick(['shop1', 'shop1', 'shop1', 'shop2', 'industrial', 'shop2']);
  return R.pick(['shop2', 'apt', 'shop1', 'apt', 'industrial']);
}

function floorsFor(R, t, dist, outer) {
  if (t === 'shop1' || t === 'industrial') return 1;
  if (t === 'shop2') return 2;
  if (t === 'office') return outer ? R.int(5, 12) : R.int(3, 6);
  return outer ? R.int(3, 7) : R.int(3, 4);
}

/** Strip of lots along a street frontage. dir: +1 front faces +z (south street), -1 faces -z. */
function strip(R, b, specs, extras, { x0, x1, zFront, depth, faces, outer, chunk, skip = [] }) {
  // Blocks north of Grand sit in front of the skyline: keep them low like the reference.
  const low = b.j <= 1;
  if (low) outer = false;
  let x = x0;
  const lots = [];
  while (x < x1 - 6) {
    let w = R.range(11, 24);
    if (x1 - (x + w) < 9) w = x1 - x;
    lots.push([x, x + w]);
    x += w;
  }
  lots.forEach(([a, c], k) => {
    const cx = (a + c) / 2;
    if (skip.some(([s0, s1]) => cx > s0 && cx < s1)) return;
    const dist = Math.hypot(cx, zFront);
    const t = typeFor(R, dist, outer);
    const floors = floorsFor(R, t, dist, outer);
    const backSet = R.chance(0.4) ? R.range(2, 9) : 0;
    const d = Math.max(9, depth - backSet);
    const w = c - a - (R.chance(0.25) ? R.range(0.5, 3) : 0.05);
    const zc = zFront - faces * (d / 2);
    const first = k === 0, last = k === lots.length - 1;
    const kind = t === 'industrial' ? 'industrial' : t.startsWith('shop') ? 'storefront' : (R.chance(0.6) ? 'storefront' : 'windows');
    const type = t === 'shop1' || t === 'shop2' ? 'shop' : t;
    const spec = makeSpec(R, {
      type, x: a + w / 2, z: zc, w, d, rot: faces > 0 ? 0 : Math.PI,
      floors, floorH: type === 'office' ? 3.7 : 3.25,
      groundH: t === 'industrial' ? R.range(5.5, 7) : R.range(4.4, 5.4),
      front: kind,
      back: floors > 1 ? 'windows' : R.pick(['industrial', 'blank', 'blank']),
      chunk,
      detail: outer ? 1 : 2,
    });
    // corner lots expose a side to the cross street; local right = +x when facing south (+z)
    const sideKind = floors > 1 || R.chance(0.5) ? 'windows' : 'storefront';
    if (first) spec[faces > 0 ? 'left' : 'right'] = b.streets.w || R.chance(0.3) ? sideKind : 'blank';
    if (last) spec[faces > 0 ? 'right' : 'left'] = b.streets.e || R.chance(0.3) ? sideKind : 'blank';
    if (floors >= 3 && R.chance(0.5)) { spec.left = spec.left === 'blank' ? 'windows' : spec.left; spec.right = spec.right === 'blank' ? 'windows' : spec.right; }
    specs.push(spec);
    if (kind === 'storefront') extras.storefronts.push({ x: spec.x, z: zFront, faces, w });
  });
}

function planBlock(b, specs, extras) {
  const R = rng(b.i * 97 + b.j * 31 + 5);
  const outer = b.i === 0 || b.i === 3 || b.j === 0 || b.j === 3;
  const lot = { x0: b.x0 + SIDEWALK_W, x1: b.x1 - SIDEWALK_W, z0: b.z0 + SIDEWALK_W, z1: b.z1 - SIDEWALK_W };
  const chunk = b.id;
  const alley = 6;
  const D = lot.z1 - lot.z0;
  const half = (D - alley) / 2;

  // Outer blocks only need the frontage that faces the playable streets.
  const hero = HERO[b.id];
  if (hero) { hero(R, b, lot, specs, extras, chunk, half); return; }

  if (b.streets.n) strip(R, b, specs, extras, { x0: lot.x0, x1: lot.x1, zFront: lot.z0, depth: Math.min(half, 32), faces: -1, outer, chunk });
  if (b.streets.s) strip(R, b, specs, extras, { x0: lot.x0, x1: lot.x1, zFront: lot.z1, depth: Math.min(half, 32), faces: 1, outer, chunk });
  // Fill the far side of outer blocks with tall backdrop buildings so the map edge reads as city.
  if (outer) {
    if (!b.streets.n) backdropRow(R, specs, lot.x0, lot.x1, lot.z0 + 14, chunk, b.j === 0);
    if (!b.streets.s) backdropRow(R, specs, lot.x0, lot.x1, lot.z1 - 14, chunk, true);
    // east/west-facing frontage on outer columns
    if (!b.streets.w || !b.streets.e) {
      const xEdge = !b.streets.w ? lot.x0 + 14 : lot.x1 - 14;
      backdropColumn(R, specs, xEdge, lot.z0 + 34, lot.z1 - 34, chunk, b.j <= 1);
    }
  }
}

function backdropRow(R, specs, x0, x1, zc, chunk, low) {
  let x = x0;
  while (x < x1 - 8) {
    const w = Math.min(R.range(16, 30), x1 - x);
    specs.push(makeSpec(R, {
      type: 'office', x: x + w / 2, z: zc, w: w - 0.5, d: 26, rot: 0, floors: low ? R.int(2, 4) : R.int(4, 11), floorH: 3.6,
      groundH: 4.6, front: 'windows', back: 'windows', left: 'windows', right: 'windows', chunk, detail: 1,
    }));
    x += w;
  }
}

function backdropColumn(R, specs, xc, z0, z1, chunk, low) {
  let z = z0;
  while (z < z1 - 8) {
    const d = Math.min(R.range(16, 28), z1 - z);
    specs.push(makeSpec(R, {
      type: 'apt', x: xc, z: z + d / 2, w: 26, d: d - 0.5, rot: Math.PI / 2, floors: low ? R.int(1, 3) : R.int(3, 8), floorH: 3.3,
      groundH: 4.4, front: 'windows', back: 'windows', left: 'windows', right: 'windows', chunk, detail: 1,
    }));
    z += d;
  }
}

/** Hand-placed lots around the main intersection, mirroring the reference image. */
const HERO = {
  // North-west of the main intersection (left of frame): big shade tree on a corner lot, low shops.
  '1-1': (R, b, lot, specs, extras, chunk, half) => {
    extras.plazas.push({ x0: -34, x1: lot.x1, z0: lot.z1 - 20, z1: lot.z1, kind: 'lot' });
    extras.trees.push({ x: -17.5, z: -21.0, scale: 3.3, rot: 1.2, big: true, hero: true });
    extras.trees.push({ x: -31, z: -38, scale: 2.4, rot: 2.8, big: true });
    specs.push(makeSpec(R, {
      type: 'shop', x: -45, z: lot.z1 - 6 - 9, w: 20, d: 18, rot: 0, floors: 1, groundH: 4.6, parapet: 1.1,
      wall: 'brickWhite', front: 'storefront', left: 'windows', right: 'windows', back: 'blank', sign: 'smog', awning: lin('#1f4c86'), chunk,
    }));
    extras.parking.push({ x0: -55, x1: -35, z0: lot.z1 - 6, z1: lot.z1 });
    extras.billboards.push({ x: -52, z: lot.z1 - 34, rot: 0.25, h: 15, id: 'bb-air' });
    strip(R, b, specs, extras, { x0: lot.x0, x1: -56, zFront: lot.z1, depth: Math.min(half, 30), faces: 1, chunk });
    strip(R, b, specs, extras, { x0: lot.x0, x1: lot.x1, zFront: lot.z0, depth: Math.min(half, 30), faces: -1, chunk });
  },
  // North-east (centre-right of frame): auto-repair shop behind a fenced forecourt, billboard behind it,
  // fast-food restaurant further east with its pole signs at the right edge of the shot.
  '2-1': (R, b, lot, specs, extras, chunk, half) => {
    specs.push(makeSpec(R, {
      type: 'industrial', x: 40, z: lot.z1 - 12.5 - 9, w: 36, d: 18, rot: 0, floors: 1, groundH: 6.2, parapet: 1.5,
      wall: 'stucco', wallColor: lin('#efe6cf'), trimColor: lin('#b8352b'), front: 'industrial', back: 'blank',
      left: 'windows', right: 'blank', sign: 'tires', roofSign: 'auto', chunk,
    }));
    extras.fences.push({ x0: 16.5, x1: 57, z: lot.z1 - 0.7, gate: [33, 41] });
    extras.yards.push({ x0: 17.5, x1: 56, z0: lot.z1 - 12, z1: lot.z1 - 1.6 });
    extras.parking.push({ x0: 15.5, x1: 58, z0: lot.z1 - 12.5, z1: lot.z1, stalls: false });
    extras.billboards.push({ x: 30, z: lot.z1 - 36, rot: -0.12, h: 16, id: 'bb-cola' });
    specs.push(makeSpec(R, {
      type: 'shop', x: 74, z: lot.z1 - 15 - 7, w: 20, d: 14, rot: 0, floors: 1, groundH: 4.8, parapet: 1.7,
      wall: 'stucco', wallColor: lin('#f1d27a'), trimColor: lin('#d9481c'), frameColor: lin('#2a2a2a'),
      front: 'storefront', left: 'storefront', right: 'windows', back: 'industrial', sign: 'chicken', lightbox: true, awning: lin('#d9481c'), chunk,
    }));
    extras.parking.push({ x0: 59, x1: 92, z0: lot.z1 - 15, z1: lot.z1 });
    extras.poleSigns.push({ x: 61.5, z: lot.z1 - 1.2, h: 10.5, panels: ['pho-pole', 'buffet-pole', 'donut-pole'] });
    extras.poleSigns.push({ x: 90, z: lot.z1 - 1.0, h: 7.5, panels: ['chicken-pole'] });
    extras.trees.push({ x: 59.5, z: -40, scale: 2.2, rot: 0.4, big: true });
    strip(R, b, specs, extras, { x0: 93, x1: lot.x1, zFront: lot.z1, depth: Math.min(half, 30), faces: 1, chunk });
    strip(R, b, specs, extras, { x0: lot.x0, x1: lot.x1, zFront: lot.z0, depth: Math.min(half, 30), faces: -1, chunk });
  },
  // South-east (right of the car): small corner plaza with planters, then shops.
  '2-2': (R, b, lot, specs, extras, chunk, half) => {
    extras.plazas.push({ x0: lot.x0, x1: lot.x0 + 15, z0: lot.z0, z1: lot.z0 + 16 });
    specs.push(makeSpec(R, {
      type: 'shop', x: lot.x0 + 15 + 11, z: lot.z0 + 12, w: 22, d: 24, rot: Math.PI, floors: 2, groundH: 4.8,
      wall: 'brickRed', front: 'storefront', left: 'windows', right: 'blank', back: 'windows', sign: 'tacos', awning: lin('#2a6638'), chunk,
    }));
    specs.push(makeSpec(R, {
      type: 'shop', x: lot.x0 + 8.5, z: lot.z0 + 16 + 14, w: 17, d: 26, rot: -Math.PI / 2, floors: 2, groundH: 4.6,
      front: 'storefront', left: 'windows', right: 'blank', back: 'blank', sign: 'phones', chunk,
    }));
    strip(R, b, specs, extras, { x0: lot.x0 + 38, x1: lot.x1, zFront: lot.z0, depth: Math.min(half, 30), faces: -1, chunk });
    strip(R, b, specs, extras, { x0: lot.x0, x1: lot.x1, zFront: lot.z1, depth: Math.min(half, 30), faces: 1, chunk });
  },
};
