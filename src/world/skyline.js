import * as THREE from 'three';
import { GeoBuilder } from './geo.js';
import { MAP_HALF, rng } from './layout.js';

/**
 * Everything beyond the playable streets: a dense downtown tower cluster to
 * the north-north-west (where the reference skyline sits), a ring of mid-rise
 * filler that hides the map edge, an elevated freeway, and hazy hills.
 *
 * Tower facades are canvas-painted texture sets (albedo + roughness/metalness)
 * so glass panels reflect the HDRI sky while mullions/spandrels stay matte,
 * with per-floor/per-panel variation baked in and mip-mapped (no aliasing).
 */

const STYLES = {
  glassBlue: { bay: 1.5, floor: 3.9, glass: ['#28465e', '#2f5470', '#223d52', '#36607c'], frame: '#9aa3ab', spandrel: '#1f3446', spandrelH: 0.22, gloss: 0.06, metal: 0.85 },
  glassTeal: { bay: 1.6, floor: 4.0, glass: ['#2d5c5c', '#326866', '#274f50', '#3a7270'], frame: '#c2c8c8', spandrel: '#2a4646', spandrelH: 0.25, gloss: 0.08, metal: 0.8 },
  glassDark: { bay: 1.5, floor: 3.8, glass: ['#1d2329', '#232b33', '#192026', '#2a333c'], frame: '#3c434a', spandrel: '#14181c', spandrelH: 0.3, gloss: 0.05, metal: 0.85 },
  goldGlass: { bay: 1.6, floor: 3.9, glass: ['#6b5a3a', '#76643f', '#5f4f33', '#806c45'], frame: '#8a7a5c', spandrel: '#4c3f2a', spandrelH: 0.28, gloss: 0.08, metal: 0.9 },
  stone: { bay: 3.0, floor: 3.8, wall: '#cfc3ad', window: ['#2b3238', '#323a42', '#3a434b', '#262c31'], winW: 0.42, winH: 0.58, gloss: 0.12, metal: 0.4 },
  concreteGrid: { bay: 3.2, floor: 3.6, wall: '#bdbab2', window: ['#2c343c', '#36404a', '#28303a', '#404a54'], winW: 0.7, winH: 0.55, gloss: 0.1, metal: 0.45 },
  whiteBands: { bay: 2.0, floor: 3.7, wall: '#e2e0d9', window: ['#33414f', '#3b4b5a', '#2d3a46'], winW: 0.96, winH: 0.5, gloss: 0.08, metal: 0.55 },
  brick: { bay: 2.6, floor: 3.3, wall: '#9b6a52', window: ['#2a2f33', '#333a40', '#3c444b'], winW: 0.45, winH: 0.55, gloss: 0.14, metal: 0.35 },
};

const BAYS_PER_TEX = 8;
const FLOORS_PER_TEX = 16;

function facadeTextures(name, s, R) {
  const W = 512, H = 1024;
  const cw = W / BAYS_PER_TEX, ch = H / FLOORS_PER_TEX;
  const alb = document.createElement('canvas');
  alb.width = W; alb.height = H;
  const a = alb.getContext('2d');
  const prop = document.createElement('canvas');
  prop.width = W; prop.height = H;
  const p = prop.getContext('2d');
  // roughness in G, metalness in B
  const rgb = (rough, metal) => `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
  if (s.glass) {
    a.fillStyle = s.frame; a.fillRect(0, 0, W, H);
    p.fillStyle = rgb(0.5, 0.6); p.fillRect(0, 0, W, H);
    for (let fy = 0; fy < FLOORS_PER_TEX; fy++) {
      const y0 = fy * ch;
      const sp = ch * s.spandrelH;
      // spandrel band
      a.fillStyle = s.spandrel; a.fillRect(0, y0, W, sp);
      p.fillStyle = rgb(0.35, 0.7); p.fillRect(0, y0, W, sp);
      for (let bx = 0; bx < BAYS_PER_TEX; bx++) {
        const x0 = bx * cw;
        const g = R.pick(s.glass);
        a.fillStyle = g;
        a.fillRect(x0 + 2, y0 + sp + 1, cw - 4, ch - sp - 3);
        // occasional blinds / lit interiors behind the glass
        const r = R();
        if (r < 0.18) { a.fillStyle = 'rgba(210,205,190,0.35)'; a.fillRect(x0 + 2, y0 + sp + 1, cw - 4, (ch - sp) * R.range(0.2, 0.7)); }
        else if (r < 0.24) { a.fillStyle = 'rgba(255,240,200,0.18)'; a.fillRect(x0 + 2, y0 + sp + 1, cw - 4, ch - sp - 3); }
        p.fillStyle = rgb(s.gloss + R.range(-0.03, 0.06), s.metal);
        p.fillRect(x0 + 2, y0 + sp + 1, cw - 4, ch - sp - 3);
      }
    }
  } else {
    a.fillStyle = s.wall; a.fillRect(0, 0, W, H);
    p.fillStyle = rgb(0.85, 0.0); p.fillRect(0, 0, W, H);
    // subtle stone / panel variation
    for (let i = 0; i < 900; i++) {
      a.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '255,255,255'},${R.range(0.02, 0.06)})`;
      a.fillRect(R.range(0, W), R.range(0, H), R.range(4, 40), R.range(4, 40));
    }
    for (let fy = 0; fy < FLOORS_PER_TEX; fy++) {
      for (let bx = 0; bx < BAYS_PER_TEX; bx++) {
        const w = cw * s.winW, h = ch * s.winH;
        const n = s.winW < 0.5 && name !== 'brick' ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const x = bx * cw + (cw / n) * (k + 0.5) - w / (n === 2 ? 2.2 : 2) / (n === 2 ? 1 : 1);
          const ww = n === 2 ? w * 0.9 : w;
          const y = fy * ch + ch * 0.22;
          // reveal shadow
          a.fillStyle = 'rgba(0,0,0,0.35)'; a.fillRect(x - 2, y - 2, ww + 4, h + 5);
          a.fillStyle = R.pick(s.window); a.fillRect(x, y, ww, h);
          if (R() < 0.2) { a.fillStyle = 'rgba(220,215,200,0.3)'; a.fillRect(x, y, ww, h * R.range(0.2, 0.8)); }
          p.fillStyle = rgb(s.gloss + R.range(0, 0.06), s.metal); p.fillRect(x, y, ww, h);
        }
      }
      if (name === 'whiteBands' || name === 'concreteGrid') {
        a.fillStyle = 'rgba(0,0,0,0.08)'; a.fillRect(0, fy * ch + ch * 0.9, W, ch * 0.1);
      }
    }
  }
  // grime streaks
  for (let i = 0; i < 160; i++) {
    a.fillStyle = `rgba(40,35,30,${R.range(0.02, 0.07)})`;
    a.fillRect(R.range(0, W), R.range(0, H), R.range(2, 8), R.range(30, 200));
  }
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const pt = tex(prop, false);
  return new THREE.MeshStandardMaterial({ map: tex(alb, true), roughnessMap: pt, metalnessMap: pt, roughness: 1, metalness: 1, vertexColors: true, envMapIntensity: 1.1 });
}

export class Skyline {
  constructor(scene, materials) {
    this.scene = scene;
    this.mat = materials;
    this.R = rng(2024);
  }

  build() {
    const R = this.R;
    this.styles = {};
    for (const [name, s] of Object.entries(STYLES)) this.styles[name] = { s, mat: facadeTextures(name, s, R) };
    this.roofMat = this.mat.walls.roof;
    this.B = new GeoBuilder();
    this.#downtown();
    this.#filler();
    this.#freeway();
    this.#emit();
    this.#hills();
  }

  /** Extruded prism from a footprint polygon (CCW, local xz) with facade uv in metres. */
  #prism(style, pts, y0, y1, uOff) {
    const B = this.B;
    const s = this.styles[style].s;
    const su = 1 / (s.bay * BAYS_PER_TEX), sv = 1 / (s.floor * FLOORS_PER_TEX);
    let u = uOff;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = [-(b[1] - a[1]), 0, b[0] - a[0]].map((v) => v / len); // outward for this winding
      B.quad(style, [a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [n[0], 0, n[2]],
        [[u * su, y0 * sv], [(u + len) * su, y0 * sv], [(u + len) * su, y1 * sv], [u * su, y1 * sv]]);
      u += len;
    }
  }

  #roof(pts, y) {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    this.B.geometry('roof', g);
  }

  #tower(x, z, opts) {
    const R = this.R;
    const B = this.B;
    const style = opts.style;
    B.setTransform(new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeRotationY(opts.rot ?? 0)));
    B.setColor(opts.tint ?? [1, 1, 1]);
    const shapeFn = {
      box: (w, d) => [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]],
      chamfer: (w, d) => { const c = Math.min(w, d) * 0.18; return [[-w / 2 + c, d / 2], [w / 2 - c, d / 2], [w / 2, d / 2 - c], [w / 2, -d / 2 + c], [w / 2 - c, -d / 2], [-w / 2 + c, -d / 2], [-w / 2, -d / 2 + c], [-w / 2, d / 2 - c]]; },
      round: (w) => Array.from({ length: 28 }, (_, i) => { const a = -(i / 28) * Math.PI * 2; return [Math.cos(a) * w / 2, Math.sin(a) * w / 2]; }),
      octa: (w) => Array.from({ length: 8 }, (_, i) => { const a = -(i / 8) * Math.PI * 2 + Math.PI / 8; return [Math.cos(a) * w / 2, Math.sin(a) * w / 2]; }),
    }[opts.shape];
    let y = 0;
    let w = opts.w, d = opts.d;
    const tiers = opts.tiers;
    const uOff = R.range(0, 40);
    for (let t = 0; t < tiers; t++) {
      const h = (opts.h * (t === 0 ? 0.62 : 0.38 / (tiers - 1))) ;
      const pts = shapeFn(w, d);
      this.#prism(style, pts, y, y + h, uOff);
      // thin parapet band
      B.setColor([0.75, 0.76, 0.77]);
      this.#prism('concreteGrid', pts.map(([px, pz]) => [px * 1.01, pz * 1.01]), y + h - 0.01, y + h + 1.2, 0);
      B.setColor(opts.tint ?? [1, 1, 1]);
      this.#roof(pts, y + h + 0.6);
      y += h;
      w *= R.range(0.68, 0.84);
      d *= R.range(0.68, 0.84);
    }
    // mechanical penthouse + antennas
    B.setColor([0.7, 0.7, 0.7]);
    const pw = Math.min(w, d) * 0.45;
    B.box('roofBox', [-pw / 2, y, -pw / 2], [pw / 2, y + R.range(4, 8), pw / 2], 'xXYzZ');
    if (opts.crown === 'spire') {
      const g = new THREE.ConeGeometry(Math.min(w, d) * 0.3, opts.h * 0.12, 8);
      g.translate(0, y + opts.h * 0.06, 0);
      B.geometry('roofBox', g);
    } else if (opts.crown === 'antenna') {
      const g = new THREE.CylinderGeometry(0.4, 0.6, 30, 6);
      g.translate(pw * 0.2, y + 15, 0);
      B.geometry('roofBox', g);
    }
  }

  #downtown() {
    const R = this.R;
    // Cluster centred NNW of the hero intersection (see reference skyline).
    const center = new THREE.Vector2(-210, -880);
    const placed = [];
    const styles = ['glassBlue', 'glassBlue', 'glassTeal', 'glassDark', 'goldGlass', 'stone', 'concreteGrid', 'whiteBands', 'glassDark', 'stone'];
    // a few signature towers first
    const sig = [
      { x: -330, z: -760, w: 46, d: 46, h: 265, shape: 'round', style: 'glassDark', tiers: 2, crown: 'flat' },
      { x: -170, z: -840, w: 42, d: 42, h: 230, shape: 'chamfer', style: 'glassBlue', tiers: 3, crown: 'antenna' },
      { x: -40, z: -700, w: 34, d: 34, h: 205, shape: 'box', style: 'stone', tiers: 3, crown: 'spire' },
      { x: -250, z: -620, w: 30, d: 30, h: 180, shape: 'box', style: 'glassTeal', tiers: 2, crown: 'flat' },
      { x: 60, z: -930, w: 40, d: 40, h: 240, shape: 'octa', style: 'goldGlass', tiers: 2, crown: 'antenna' },
      { x: -460, z: -900, w: 38, d: 50, h: 200, shape: 'box', style: 'whiteBands', tiers: 1, crown: 'flat' },
    ];
    for (const t of sig) { this.#tower(t.x, t.z, { ...t, rot: R.range(-0.2, 0.2) }); placed.push([t.x, t.z, Math.max(t.w, t.d)]); }
    for (let i = 0; i < 70; i++) {
      const a = R.range(0, Math.PI * 2);
      const r = Math.sqrt(R()) * 420;
      const x = center.x + Math.cos(a) * r * 1.25, z = center.y + Math.sin(a) * r * 0.8;
      const w = R.range(24, 48), d = R.range(24, 48);
      if (placed.some(([px, pz, pw]) => Math.hypot(px - x, pz - z) < (pw + Math.max(w, d)) * 0.62)) continue;
      const falloff = 1 - r / 470;
      const h = R.range(45, 120) + falloff * R.range(40, 150);
      this.#tower(x, z, {
        w, d, h, shape: R.pick(['box', 'box', 'chamfer', 'box', 'octa', 'round']), style: R.pick(styles),
        tiers: h > 120 ? R.int(1, 3) : 1, crown: R.pick(['flat', 'flat', 'antenna']), rot: R.pick([0, 0, R.range(-0.4, 0.4)]),
        tint: [R.range(0.88, 1.05), R.range(0.88, 1.03), R.range(0.88, 1.05)],
      });
      placed.push([x, z, Math.max(w, d)]);
    }
  }

  /** Mid-rise ring between the map edge and the horizon. */
  #filler() {
    const R = this.R;
    const styles = ['stone', 'concreteGrid', 'whiteBands', 'brick', 'brick', 'concreteGrid'];
    const inner = MAP_HALF + 55;
    for (let i = 0; i < 520; i++) {
      const x = R.range(-1400, 1400), z = R.range(-1400, 900);
      if (Math.abs(x) < inner && Math.abs(z) < inner) continue;
      if (Math.abs(z + 268) < 25) continue; // freeway corridor
      const d = Math.max(Math.abs(x), Math.abs(z));
      if (d > 1450) continue;
      const nearDowntown = Math.hypot(x + 210, z + 880) < 520;
      if (nearDowntown && R.chance(0.6)) continue;
      const w = R.range(14, 40), dd = R.range(14, 36);
      const h = R.range(6, 14) + (d > 600 ? R.range(0, 22) : R.range(0, 10));
      this.#tower(x, z, { w, d: dd, h, shape: 'box', style: R.pick(styles), tiers: 1, crown: 'flat', rot: R.pick([0, 0, 0, Math.PI / 2]),
        tint: [R.range(0.85, 1.08), R.range(0.85, 1.04), R.range(0.82, 1.0)] });
    }
  }

  #freeway() {
    const B = this.B;
    B.setTransform(new THREE.Matrix4());
    B.setColor([0.78, 0.76, 0.72]);
    const z = -268, y = 9.5, half = 17;
    const x0 = -2200, x1 = 2200;
    B.box('concrete', [x0, y - 1.6, z - half], [x1, y, z + half], 'yYzZ');
    // jersey barriers
    for (const zz of [z - half, z + half - 0.5]) B.box('concrete', [x0, y, zz], [x1, y + 1.1, zz + 0.5], 'yYzZ');
    // columns (hammerhead piers)
    for (let x = x0; x <= x1; x += 42) {
      B.box('concrete', [x - 1.1, 0, z - 1.4], [x + 1.1, y - 1.6, z + 1.4], 'xXzZ');
      B.box('concrete', [x - 1.4, y - 3.2, z - half + 2], [x + 1.4, y - 1.6, z + half - 2], 'xXyzZ');
    }
    // overhead sign gantry with green panels
    for (const gx of [-160, 120]) {
      B.setColor([0.55, 0.56, 0.57]);
      B.box('roofBox', [gx - 0.3, y, z + half - 1], [gx + 0.3, y + 7.5, z + half - 0.4], 'xXyYzZ');
      B.box('roofBox', [gx - 0.3, y, z - half + 0.4], [gx + 0.3, y + 7.5, z - half + 1], 'xXyYzZ');
      B.box('roofBox', [gx - 0.35, y + 7.0, z - half + 0.4], [gx + 0.35, y + 7.6, z + half - 0.4], 'xXyYzZ');
      B.setColor([0.08, 0.36, 0.2]);
      B.box('roofBox', [gx + 0.4, y + 4.4, z - 9], [gx + 0.5, y + 7.0, z + 1], 'X');
      B.box('roofBox', [gx + 0.4, y + 4.4, z + 3], [gx + 0.5, y + 7.0, z + 12], 'X');
    }
  }

  #emit() {
    const group = new THREE.Group();
    group.name = 'skyline';
    const mats = {
      roof: this.roofMat,
      roofBox: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.3 }),
      concrete: this.mat.concreteSmooth,
    };
    for (const [key, geom] of this.B.build()) {
      const mat = mats[key] ?? this.styles[key].mat;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.scene.add(group);
    this.group = group;
  }

  /** Hazy mountains on the northern horizon: unlit gradient silhouettes tinted toward the sky. */
  #hills() {
    const R = this.R;
    const geom = new THREE.BufferGeometry();
    const pos = [], col = [];
    const ridge = (dist, a0, a1, hMax, tone) => {
      const N = 120;
      let prev = null;
      const ph = R.range(0, 10);
      for (let i = 0; i <= N; i++) {
        const a = THREE.MathUtils.lerp(a0, a1, i / N);
        const n = Math.sin(a * 7 + ph) * 0.35 + Math.sin(a * 17 + ph * 2) * 0.18 + Math.sin(a * 41 + ph) * 0.07 + 0.6;
        const h = Math.max(0, hMax * n * Math.sin((i / N) * Math.PI) ** 0.6);
        const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
        const cur = [x, h, z];
        if (prev) {
          const [px, ph2, pz] = prev;
          pos.push(px, -30, pz, x, -30, z, x, h, z, px, -30, pz, x, h, z, px, ph2, pz);
          const top = tone, bot = tone.map((c) => c * 1.03);
          col.push(...bot, ...bot, ...top, ...bot, ...top, ...top);
        }
        prev = cur;
      }
    };
    // azimuths: -PI/2 is north (-z)
    ridge(6800, -Math.PI * 0.86, -Math.PI * 0.38, 620, [0.52, 0.6, 0.7]);
    ridge(4300, -Math.PI * 0.47, -Math.PI * 0.18, 720, [0.3, 0.37, 0.46]);
    ridge(7500, -Math.PI * 1.2, -Math.PI * 0.75, 380, [0.55, 0.63, 0.72]);
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, m);
    mesh.name = 'hills';
    mesh.renderOrder = -1;
    this.scene.add(mesh);
  }
}
