import * as THREE from 'three';
import { GeoBuilder } from './geo.js';
import { rng } from './layout.js';

const M4 = () => new THREE.Matrix4();
const _rot = new THREE.Matrix4();

/**
 * Procedural building generator.
 *
 * A building spec describes a footprint (x, z, w, d, rot), floors and a
 * style; each of the four faces is generated in a face-local frame
 * (x along the face, y up, wall plane at z = 0, +z outward) with real window
 * openings: reveals, sills, frames, mullions and interior-mapped glass.
 */
export class BuildingFactory {
  constructor(materials, signs) {
    this.mat = materials;
    this.signs = signs;
  }

  /** Materials for each geometry group key. */
  materialFor(key) {
    const m = this.mat;
    if (key === 'glass') return m.windowGlass;
    if (key === 'sign') return this.signs.material;
    if (key === 'lightbox') return this.signs.lightbox;
    if (key === 'frame') return m.trim;
    if (key === 'trim') return m.concreteSmooth;
    if (key === 'fabric') return m.fabric;
    if (key === 'metal') return m.paintedMetal;
    if (key === 'galv') return m.galvanized;
    if (key === 'dark') return m.darkMetal;
    if (key.startsWith('wall:')) return m.walls[key.slice(5)];
    throw new Error(`no material for ${key}`);
  }

  /** Emit one building into a GeoBuilder. Returns collider info. */
  build(B, s) {
    const R = rng(s.seed ?? Math.floor(s.x * 73 + s.z * 131));
    const H = s.groundH + (s.floors - 1) * s.floorH;   // roof deck height
    const top = H + s.parapet;
    const base = M4().makeTranslation(s.x, s.baseY ?? 0.15, s.z).multiply(_rot.clone().makeRotationY(s.rot));
    const faces = [
      { kind: s.front, W: s.w, m: M4().makeTranslation(-s.w / 2, 0, s.d / 2) },
      { kind: s.right, W: s.d, m: M4().makeTranslation(s.w / 2, 0, s.d / 2).multiply(M4().makeRotationY(Math.PI / 2)) },
      { kind: s.back, W: s.w, m: M4().makeTranslation(s.w / 2, 0, -s.d / 2).multiply(M4().makeRotationY(Math.PI)) },
      { kind: s.left, W: s.d, m: M4().makeTranslation(-s.w / 2, 0, -s.d / 2).multiply(M4().makeRotationY(-Math.PI / 2)) },
    ];
    faces.forEach((f, i) => {
      B.setTransform(base.clone().multiply(f.m));
      this.#face(B, s, f.W, H, top, f.kind, i === 0, R);
    });

    // Roof deck, parapet inner faces, coping
    B.setTransform(base);
    B.setColor([1, 1, 1]);
    const t = 0.28;
    const hw = s.w / 2, hd = s.d / 2;
    B.floorY('wall:roof', -hw + t, hw - t, -hd + t, hd - t, H);
    if (s.parapet > 0.05) {
      B.setColor(s.wallColor);
      B.wallZ(`wall:${s.wall}`, -hw + t, hw - t, H, top, -hd + t);          // north inner face (faces +z)
      B.wallZ(`wall:${s.wall}`, -hw + t, hw - t, H, top, hd - t, true);     // south inner face
      B.wallX(`wall:${s.wall}`, -hd + t, hd - t, H, top, -hw + t);          // faces +x
      B.wallX(`wall:${s.wall}`, -hd + t, hd - t, H, top, hw - t, true);
    }
    B.setColor(s.trimColor);
    const c = 0.05;
    B.box('trim', [-hw - c, top, -hd - c], [hw + c, top + 0.1, -hd + t], 'xXyYzZ');
    B.box('trim', [-hw - c, top, hd - t], [hw + c, top + 0.1, hd + c], 'xXyYzZ');
    B.box('trim', [-hw - c, top, -hd + t], [-hw + t, top + 0.1, hd - t], 'xXY');
    B.box('trim', [hw - t, top, -hd + t], [hw + c, top + 0.1, hd - t], 'xXY');
    if (s.cornice) {
      const cy = top - 0.75;
      B.setColor(s.trimColor);
      B.box('trim', [-hw - 0.32, cy, -hd - 0.32], [hw + 0.32, cy + 0.38, hd + 0.32], 'xXyYzZ');
      B.box('trim', [-hw - 0.16, cy - 0.22, -hd - 0.16], [hw + 0.16, cy, hd + 0.16], 'xXyzZ');
    }

    if (s.roofSign) this.#roofSign(B, s, top);
    if (s.detail >= 1 && s.roofProps !== false) this.#roof(B, s, H, R);
    return { H: top, base };
  }

  #face(B, s, W, H, top, kind, isFront, R) {
    const wall = `wall:${s.wall}`;
    B.setColor(s.wallColor);
    if (kind === 'blank' || W < 2) {
      B.wallZ(wall, 0, W, 0, top, 0);
      return;
    }
    const g = s.groundH;
    // ---------- ground floor ----------
    if (kind === 'storefront') this.#storefront(B, s, W, g, R, isFront);
    else if (kind === 'industrial') this.#industrial(B, s, W, g, R);
    else if (kind === 'windows' && s.floors === 1) this.#windowRow(B, s, W, 0, g, R, { sill: 1.0, h: Math.min(2.2, g - 1.6) });
    else if (kind === 'windows') this.#windowRow(B, s, W, 0, g, R, { sill: 1.1, h: Math.min(2.0, g - 1.7) });
    else B.wallZ(wall, 0, W, 0, g, 0);

    // ---------- upper floors ----------
    const upperKind = kind === 'industrial' ? 'blank' : 'windows';
    for (let f = 1; f < s.floors; f++) {
      const y0 = g + (f - 1) * s.floorH;
      if (upperKind === 'windows' && s.upper !== 'blank') this.#windowRow(B, s, W, y0, y0 + s.floorH, R, {});
      else { B.setColor(s.wallColor); B.wallZ(wall, 0, W, y0, y0 + s.floorH, 0); }
      if (s.bands && s.detail >= 1) {
        B.setColor(s.trimColor);
        B.box('trim', [-0.02, y0 - 0.12, 0], [W + 0.02, y0 + 0.1, 0.06], 'yYzZ');
      }
    }
    // parapet strip
    B.setColor(s.wallColor);
    B.wallZ(wall, 0, W, H, top, 0);
    if (s.bands && s.detail >= 1 && s.floors > 1) {
      B.setColor(s.trimColor);
      B.box('trim', [-0.02, g - 0.14, 0], [W + 0.02, g + 0.08, 0.08], 'yYzZ');
    }
  }

  /** A row of punched windows between y0 and y1. */
  #windowRow(B, s, W, y0, y1, R, o) {
    const ws = s.win;
    const wall = `wall:${s.wall}`;
    const n = Math.max(1, Math.round(W / ws.bay));
    const bay = W / n;
    const ww = Math.min(ws.w, bay - 0.5);
    const sill = o.sill ?? ws.sill;
    const wh = Math.min(o.h ?? ws.h, y1 - y0 - sill - 0.35);
    const wy0 = y0 + sill, wy1 = wy0 + wh;
    const rec = ws.recess;
    B.setColor(s.wallColor);
    B.wallZ(wall, 0, W, y0, wy0, 0);
    B.wallZ(wall, 0, W, wy1, y1, 0);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const cx = (i + 0.5) * bay;
      const x0 = cx - ww / 2, x1 = cx + ww / 2;
      B.setColor(s.wallColor);
      B.wallZ(wall, prev, x0, wy0, wy1, 0);
      prev = x1;
      // reveals
      B.wallX(wall, -rec, 0, wy0, wy1, x0);                 // left jamb faces +x
      B.wallX(wall, -rec, 0, wy0, wy1, x1, true);           // right jamb faces -x
      B.floorY(wall, x0, x1, -rec, 0, wy1, true);           // head faces down
      B.floorY(wall, x0, x1, -rec, 0, wy0);                 // sill top inside
      this.#pane(B, x0, x1, wy0, wy1, -rec, R, s, ws.mullion);
      if (s.detail >= 2) {
        // projecting sill
        B.setColor(s.trimColor);
        B.box('trim', [x0 - 0.06, wy0 - 0.07, -0.02], [x1 + 0.06, wy0, 0.07], 'xXyYZ');
        if (ws.lintel) B.box('trim', [x0 - 0.08, wy1, -0.01], [x1 + 0.08, wy1 + 0.22, 0.04], 'xXYZ');
      }
    }
    B.setColor(s.wallColor);
    B.wallZ(wall, prev, W, wy0, wy1, 0);
  }

  /** Glass + frame inside an opening (opening spans x0..x1, y0..y1 at depth z). */
  #pane(B, x0, x1, y0, y1, z, R, s, mullion, shop = false) {
    const seed = (shop ? 2 : 0) + R() * 0.999;
    const depth = shop ? 6 + R() * 6 : 3.5 + R() * 3;
    B.setColor([1, 1, 1]);
    B.quad('glass', [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1],
      [[0, 0], [1, 0], [1, 1], [0, 1]], [seed, depth, x1 - x0, y1 - y0]);
    if (s.detail < 2) return;
    const f = 0.055, d = 0.05;
    B.setColor(s.frameColor);
    B.box('frame', [x0, y0, z], [x0 + f, y1, z + d], 'XZ');
    B.box('frame', [x1 - f, y0, z], [x1, y1, z + d], 'xZ');
    B.box('frame', [x0 + f, y1 - f, z], [x1 - f, y1, z + d], 'yZ');
    B.box('frame', [x0 + f, y0, z], [x1 - f, y0 + f, z + d], 'YZ');
    if (mullion && x1 - x0 > 1.2) {
      const mx = (x0 + x1) / 2;
      B.box('frame', [mx - f / 2, y0, z], [mx + f / 2, y1, z + d], 'xXZ');
    }
    if (mullion === 'cross' && y1 - y0 > 1.4) {
      const my = y0 + (y1 - y0) * 0.62;
      B.box('frame', [x0, my - f / 2, z], [x1, my + f / 2, z + d], 'yYZ');
    }
  }

  #storefront(B, s, W, g, R, isFront) {
    const wall = `wall:${s.wall}`;
    const pier = 0.45;
    const openTop = Math.min(3.4, g - 1.0);
    const rec = 0.32;
    const x0 = pier, x1 = W - pier;
    B.setColor(s.wallColor);
    B.wallZ(wall, 0, x0, 0, openTop, 0);
    B.wallZ(wall, x1, W, 0, openTop, 0);
    B.wallZ(wall, 0, W, openTop, g, 0);
    // reveals
    B.wallX(wall, -rec, 0, 0, openTop, x0);
    B.wallX(wall, -rec, 0, 0, openTop, x1, true);
    B.floorY(wall, x0, x1, -rec, 0, openTop, true);
    // bulkhead
    const bh = 0.5;
    B.setColor(s.bulkColor ?? s.trimColor);
    B.box('trim', [x0, 0, -rec], [x1, bh, -rec + 0.12], 'YZ');
    // bays
    const n = Math.max(1, Math.round((x1 - x0) / 2.1));
    const bw = (x1 - x0) / n;
    const doorBay = isFront ? Math.min(n - 1, Math.floor(R() * n)) : -1;
    const z = -rec + 0.04;
    for (let i = 0; i < n; i++) {
      const a = x0 + i * bw, b = a + bw;
      const isDoor = i === doorBay;
      const gy0 = isDoor ? 0.02 : bh;
      const gy1 = openTop - 0.08;
      this.#pane(B, a, b, gy0, gy1, z, R, s, false, true);
      if (s.detail >= 1) {
        B.setColor(s.mullionColor ?? [0.75, 0.76, 0.78]);
        B.box('frame', [a - 0.04, 0, z], [a + 0.04, openTop, z + 0.12], 'xXZ');
        if (isDoor) {
          // transom bar + door frame + push bar
          B.box('frame', [a, 2.2, z], [b, 2.3, z + 0.12], 'yYZ');
          B.box('frame', [a + 0.05, 0, z], [b - 0.05, 0.08, z + 0.08], 'YZ');
          B.setColor([0.12, 0.12, 0.12]);
          B.box('frame', [a + 0.15, 1.0, z + 0.08], [b - 0.15, 1.06, z + 0.13], 'yYZ');
        }
      }
    }
    if (s.detail >= 1) {
      B.setColor(s.mullionColor ?? [0.75, 0.76, 0.78]);
      B.box('frame', [x1 - 0.04, 0, z], [x1 + 0.04, openTop, z + 0.12], 'xXZ');
      B.box('frame', [x0, openTop - 0.1, z], [x1, openTop, z + 0.12], 'yZ');
    }
    // fascia sign
    if (s.sign && isFront) this.#sign(B, s, W, openTop, g);
    // awning
    if (s.awning && isFront && s.detail >= 1) this.#awning(B, s, x0 - 0.1, x1 + 0.1, openTop);
  }

  #sign(B, s, W, y0, g) {
    const uv = this.signs.uv(s.sign);
    if (!uv) return;
    const sh = Math.min(1.0, g - y0 - 0.25);
    const sw = Math.min(W * 0.84, sh * uv.aspect * 1.25);
    const cx = W / 2;
    const a = cx - sw / 2, b = cx + sw / 2;
    const y = y0 + (g - y0 - sh) / 2 + 0.05;
    const z = 0.14;
    const key = s.lightbox ? 'lightbox' : 'sign';
    B.setColor([1, 1, 1]);
    B.quad(key, [a, y, z], [b, y, z], [b, y + sh, z], [a, y + sh, z], [0, 0, 1],
      [[uv.u0, uv.v0], [uv.u1, uv.v0], [uv.u1, uv.v1], [uv.u0, uv.v1]]);
    B.setColor([0.15, 0.15, 0.16]);
    B.box('frame', [a - 0.04, y - 0.04, 0], [b + 0.04, y + sh + 0.04, z - 0.005], 'xXyY');
  }

  #awning(B, s, x0, x1, y) {
    const out = 1.25, drop = 0.7, val = 0.28;
    B.setColor(s.awning);
    const yTop = y + 0.05, yLow = yTop - drop;
    // sloped canopy (double-sided material)
    B.quad('fabric', [x0, yLow, out], [x1, yLow, out], [x1, yTop, 0], [x0, yTop, 0], [0, 0.87, 0.5],
      [[x0, 0], [x1, 0], [x1, 1.4], [x0, 1.4]]);
    // valance
    B.quad('fabric', [x0, yLow - val, out], [x1, yLow - val, out], [x1, yLow, out], [x0, yLow, out], [0, 0, 1],
      [[x0, 0], [x1, 0], [x1, val], [x0, val]]);
    // side cheeks
    B.quad('fabric', [x0, yLow - val, out], [x0, yLow, out], [x0, yTop, 0], [x0, yTop - 0.02, 0], [-1, 0, 0], [[0, 0], [0, 0.3], [1, 1], [1, 0.9]]);
    B.quad('fabric', [x1, yTop - 0.02, 0], [x1, yTop, 0], [x1, yLow, out], [x1, yLow - val, out], [1, 0, 0], [[0, 0], [0, 0.3], [1, 1], [1, 0.9]]);
  }

  #industrial(B, s, W, g, R) {
    const wall = `wall:${s.wall}`;
    const doors = Math.max(1, Math.floor((W - 3) / 5.5));
    const dw = Math.min(4.2, (W - 2) / doors - 1.2);
    const dh = Math.min(4.2, g - 1.0);
    const spacing = W / doors;
    const rec = 0.18;
    let prev = 0;
    B.setColor(s.wallColor);
    B.wallZ(wall, 0, W, dh, g, 0);
    for (let i = 0; i < doors; i++) {
      const cx = (i + 0.5) * spacing;
      const x0 = cx - dw / 2, x1 = cx + dw / 2;
      B.setColor(s.wallColor);
      B.wallZ(wall, prev, x0, 0, dh, 0);
      prev = x1;
      B.wallX(wall, -rec, 0, 0, dh, x0);
      B.wallX(wall, -rec, 0, 0, dh, x1, true);
      B.floorY(wall, x0, x1, -rec, 0, dh, true);
      // roll-up shutter (metric uv; the texture's slats run along u, i.e. horizontally)
      B.setColor(s.shutterColor ?? [0.82, 0.83, 0.84]);
      B.quad('wall:shutter', [x0, 0, -rec], [x1, 0, -rec], [x1, dh, -rec], [x0, dh, -rec], [0, 0, 1],
        [[x0, 0], [x1, 0], [x1, dh], [x0, dh]]);
      if (s.detail >= 1) {
        B.setColor([0.3, 0.31, 0.32]);
        B.box('dark', [x0 - 0.12, 0, -0.02], [x0, dh + 0.12, 0.08], 'xXZ');
        B.box('dark', [x1, 0, -0.02], [x1 + 0.12, dh + 0.12, 0.08], 'xXZ');
        B.box('dark', [x0 - 0.12, dh, -0.02], [x1 + 0.12, dh + 0.12, 0.08], 'yYZ');
        // shutter housing box
        B.box('galv', [x0 - 0.05, dh + 0.12, -0.05], [x1 + 0.05, dh + 0.6, 0.3], 'xXyYZ');
      }
    }
    B.setColor(s.wallColor);
    B.wallZ(wall, prev, W, 0, dh, 0);
    if (s.sign) this.#sign(B, { ...s, lightbox: false }, W, dh + 0.6, g + 0.2);
  }

  /** Big double-faced sign standing on the front parapet (classic LA auto-shop look). */
  #roofSign(B, s, top) {
    const uv = this.signs.uv(s.roofSign);
    if (!uv) return;
    const w = Math.min(s.w * 0.86, 26), h = Math.min(2.6, w / uv.aspect * 1.15);
    const z = s.d / 2 - 0.6, y0 = top + 0.5;
    B.setColor([0.16, 0.16, 0.17]);
    for (let x = -w / 2 + 0.6; x <= w / 2 - 0.5; x += w / 5) {
      B.box('dark', [x - 0.06, top, z - 0.06], [x + 0.06, y0 + h * 0.6, z + 0.06]);
      B.box('dark', [x - 0.04, top, z - 1.2], [x + 0.04, y0 + 0.2, z - 1.1]);
    }
    B.box('dark', [-w / 2 - 0.08, y0 - 0.08, z - 0.12], [w / 2 + 0.08, y0 + h + 0.08, z + 0.04], 'xXyYz');
    B.setColor([1, 1, 1]);
    B.quad('sign', [-w / 2, y0, z + 0.05], [w / 2, y0, z + 0.05], [w / 2, y0 + h, z + 0.05], [-w / 2, y0 + h, z + 0.05], [0, 0, 1],
      [[uv.u0, uv.v0], [uv.u1, uv.v0], [uv.u1, uv.v1], [uv.u0, uv.v1]]);
  }

  #roof(B, s, H, R) {
    const hw = s.w / 2 - 1.5, hd = s.d / 2 - 1.5;
    if (hw < 1 || hd < 1) return;
    const units = Math.max(1, Math.floor((s.w * s.d) / 160));
    for (let i = 0; i < Math.min(units, 6); i++) {
      const x = R.range(-hw + 1, hw - 1), z = R.range(-hd + 1, hd - 1);
      const sx = R.range(0.9, 1.6), sz = R.range(1.4, 2.6), sy = R.range(0.9, 1.3);
      B.setColor([0.78, 0.78, 0.76]);
      B.box('galv', [x - sx / 2, H, z - sz / 2], [x + sx / 2, H + sy, z + sz / 2], 'xXYzZ');
      // fan housing on top
      B.setColor([0.18, 0.18, 0.18]);
      B.box('dark', [x - sx * 0.35, H + sy, z - sx * 0.35], [x + sx * 0.35, H + sy + 0.12, z + sx * 0.35], 'xXYzZ');
      // curb / duct
      if (R.chance(0.6)) {
        B.setColor([0.7, 0.7, 0.68]);
        B.box('galv', [x - 0.25, H, z + sz / 2], [x + 0.25, H + 0.45, z + sz / 2 + R.range(1, 3)], 'xXYZ');
      }
    }
    // vent pipes & roof hatch
    for (let i = 0; i < R.int(1, 4); i++) {
      const x = R.range(-hw, hw), z = R.range(-hd, hd);
      B.setColor([0.25, 0.25, 0.25]);
      B.box('dark', [x - 0.06, H, z - 0.06], [x + 0.06, H + R.range(0.4, 1.0), z + 0.06], 'xXYzZ');
    }
    if (R.chance(0.6)) {
      const x = R.range(-hw, hw - 1), z = R.range(-hd, hd - 1);
      B.setColor(s.wallColor);
      B.box(`wall:${s.wall}`, [x, H, z], [x + 2.2, H + 2.5, z + 2.6], 'xXzZ');
      B.setColor(s.trimColor);
      B.box('trim', [x - 0.05, H + 2.5, z - 0.05], [x + 2.25, H + 2.6, z + 2.65], 'xXYzZ');
    }
  }
}

/** Turn a set of building specs into meshes, chunked by group id for culling. */
export function buildMeshes(factory, specs, scene, physics, { shadows = true } = {}) {
  const chunks = new Map();
  for (const s of specs) {
    const key = s.chunk ?? 'default';
    if (!chunks.has(key)) chunks.set(key, new GeoBuilder());
    const info = factory.build(chunks.get(key), s);
    if (physics && s.collide !== false) {
      physics.box(s.x, (s.baseY ?? 0.15) + info.H / 2, s.z, s.w / 2, info.H / 2, s.d / 2, s.rot);
    }
  }
  const group = new THREE.Group();
  group.name = 'buildings';
  for (const [, B] of chunks) {
    for (const [key, geom] of B.build()) {
      const mesh = new THREE.Mesh(geom, factory.materialFor(key));
      mesh.castShadow = shadows && key !== 'glass' && key !== 'sign' && key !== 'lightbox';
      mesh.receiveShadow = true;
      mesh.name = key;
      group.add(mesh);
    }
  }
  scene.add(group);
  return group;
}
