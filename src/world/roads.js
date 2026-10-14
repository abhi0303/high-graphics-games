import * as THREE from 'three';
import { ROADS, MAP_HALF, CURB_H, CORNER_R, INTERSECTIONS, computeBlocks, rng } from './layout.js';
import { GeoBuilder } from './geo.js';

const PAINT_Y = 0.006;
const WHITE = [0.86, 0.86, 0.84];
const YELLOW = [0.86, 0.62, 0.12];
const CROSSWALK_W = 3.8;
const CROSSWALK_GAP = 1.1; // from the intersection edge

/** Builds asphalt, sidewalks, curbs and road markings. Returns physics shapes for curbs. */
export class Roads {
  constructor(scene, materials) {
    this.scene = scene;
    this.mat = materials;
    this.blocks = computeBlocks();
    this.colliders = [];
  }

  build() {
    this.#ground();
    this.#blocks();
    this.#markings();
    this.#wearMap();
  }

  #ground() {
    const size = 12000;
    const g = new THREE.PlaneGeometry(size, size, 1, 1);
    g.rotateX(-Math.PI / 2);
    // uv = world (x, z) so the shader's tangent frame matches its world-space sampling.
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
    const mesh = new THREE.Mesh(g, this.mat.asphalt);
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    this.scene.add(mesh);
  }

  /** Raised sidewalk slabs with rounded curb returns at street corners. */
  #blocks() {
    const top = new GeoBuilder();
    const curbGeoms = [];
    for (const b of this.blocks) {
      const shape = roundedRect(b, CORNER_R);
      // curb: ring between outer and 0.32 m inset, extruded to curb height with a tiny bevel
      const ring = roundedRect(b, CORNER_R);
      ring.holes.push(roundedRect(inset(b, 0.32), Math.max(0.1, CORNER_R - 0.32)));
      const curb = new THREE.ExtrudeGeometry(ring, {
        depth: CURB_H - 0.02, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 14,
      });
      curb.rotateX(-Math.PI / 2);
      curbGeoms.push(curb);

      // walking surface
      const inner = new THREE.ShapeGeometry(roundedRect(inset(b, 0.3), Math.max(0.1, CORNER_R - 0.3)), 14);
      inner.rotateX(-Math.PI / 2);
      inner.translate(0, CURB_H, 0);
      const p = inner.attributes.position;
      const uv = inner.attributes.uv;
      for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) - (b.x0 + 0.3), p.getZ(i) - (b.z0 + 0.3));
      top.geometry('sidewalk', inner);

      // physics: solid slab
      const solid = new THREE.ExtrudeGeometry(shape, { depth: CURB_H, bevelEnabled: false, curveSegments: 8 });
      solid.rotateX(-Math.PI / 2);
      this.colliders.push(solid);
    }
    const geoms = top.build();
    const sidewalk = new THREE.Mesh(geoms.get('sidewalk'), this.mat.sidewalk);
    sidewalk.receiveShadow = true;
    sidewalk.name = 'sidewalks';

    const merged = mergeSimple(curbGeoms);
    const col = new Float32Array(merged.attributes.position.count * 3).fill(1);
    // Red "no stopping" paint on the curb returns and a stretch beyond each corner, faded and chipped.
    const P = merged.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), z = P.getZ(i);
      for (const X of INTERSECTIONS) {
        const dx = Math.abs(x - X.x) - X.ns.width / 2, dz = Math.abs(z - X.z) - X.ew.width / 2;
        if (dx > -0.5 && dz > -0.5 && dx < 16 && dz < 16 && Math.min(dx, dz) < 0.6) {
          const chip = Math.sin(x * 12.9 + z * 7.3) * 0.5 + 0.5;
          col.set([0.62 + chip * 0.1, 0.1, 0.07], i * 3);
        }
      }
    }
    merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const curbs = new THREE.Mesh(merged, this.mat.curb);
    curbs.receiveShadow = true;
    curbs.castShadow = false;
    curbs.name = 'curbs';
    this.scene.add(sidewalk, curbs);
  }

  #markings() {
    const g = new GeoBuilder();
    const stripe = (ax, az, bx, bz, w, color) => {
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) return;
      const nx = (-dz / len) * (w / 2), nz = (dx / len) * (w / 2);
      g.setColor(color);
      g.quad('paint',
        [ax + nx, PAINT_Y, az + nz], [bx + nx, PAINT_Y, bz + nz],
        [bx - nx, PAINT_Y, bz - nz], [ax - nx, PAINT_Y, az - nz],
        [0, 1, 0], [[0, 1], [len, 1], [len, 0], [0, 0]]);
    };
    const dashed = (ax, az, bx, bz, w, color, dash = 3, gap = 9) => {
      const len = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      for (let s = gap / 2; s < len - 0.5; s += dash + gap) {
        const e = Math.min(s + dash, len);
        stripe(ax + ux * s, az + uz * s, ax + ux * e, az + uz * e, w, color);
      }
    };

    // Segments of each road between intersection mouths (crosswalk + stop bar setback).
    const setback = (cross) => cross.width / 2 + CROSSWALK_GAP + CROSSWALK_W + 1.6;
    const roadSegments = (road, axis) => {
      const crosses = axis === 'ns' ? ROADS.ew.map((r) => [r.z, r]) : ROADS.ns.map((r) => [r.x, r]);
      const stops = [-MAP_HALF - 40, ...crosses.map(([c]) => c), MAP_HALF + 40];
      const segs = [];
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i] + (i > 0 ? setback(crosses[i - 1][1]) : 0);
        const b = stops[i + 1] - (i < crosses.length ? setback(crosses[i][1]) : 0);
        segs.push([a, b, i > 0, i < crosses.length]);
      }
      return segs;
    };

    const laneLines = (road, axis) => {
      const c = axis === 'ns' ? road.x : road.z;
      for (const [a, b, startsAtX, endsAtX] of roadSegments(road, axis)) {
        const P = (off, s) => (axis === 'ns' ? [c + off, s] : [s, c + off]);
        const line = (off, w, color, isDashed, solidNear = 0) => {
          let s0 = a, s1 = b;
          if (isDashed && solidNear > 0) {
            // solid near intersections, dashed in between
            const sa = startsAtX ? a + solidNear : a;
            const sb = endsAtX ? b - solidNear : b;
            if (startsAtX) stripe(...P(off, a), ...P(off, sa), w, color);
            if (endsAtX) stripe(...P(off, sb), ...P(off, b), w, color);
            s0 = sa; s1 = sb;
          }
          if (s1 <= s0) return;
          if (isDashed) dashed(...P(off, s0), ...P(off, s1), w, color);
          else stripe(...P(off, s0), ...P(off, s1), w, color);
        };
        // double yellow centre line
        line(-0.12, 0.11, YELLOW, false);
        line(0.12, 0.11, YELLOW, false);
        for (const side of [-1, 1]) {
          let off = 0.18;
          road.lanes.forEach((w, i) => {
            off += w;
            if (i < road.lanes.length - 1) line(side * off, 0.12, WHITE, true, 18);
          });
          // edge / parking line
          if (road.parking > 1) line(side * off, 0.12, WHITE, false);
        }
      }
    };
    ROADS.ns.forEach((r) => laneLines(r, 'ns'));
    ROADS.ew.forEach((r) => laneLines(r, 'ew'));

    // Crosswalks, stop bars and arrows at every intersection.
    for (const X of INTERSECTIONS) {
      const hx = X.ns.width / 2, hz = X.ew.width / 2;
      // north/south legs (cross the NS road): bars run north–south
      for (const dir of [-1, 1]) {
        const z0 = X.z + dir * (hz + CROSSWALK_GAP);
        const z1 = z0 + dir * CROSSWALK_W;
        for (let x = X.x - hx + 0.9; x < X.x + hx - 0.5; x += 1.2) stripe(x + 0.3, z0, x + 0.3, z1, 0.6, WHITE);
        // stop bar across the approaching half (traffic drives on the right)
        const zs = z1 + dir * 1.2;
        const xa = X.x + (dir > 0 ? 0.25 : -0.25);
        const xb = X.x + (dir > 0 ? hx - 0.4 : -hx + 0.4);
        stripe(xa, zs, xb, zs, 0.45, WHITE);
        // lane arrows ~8 m behind the stop bar
        const lanes = X.ns.lanes;
        let off = 0.18;
        lanes.forEach((w, i) => {
          const cx = X.x + (dir > 0 ? 1 : -1) * (off + w / 2);
          off += w;
          const kind = i === 0 ? 'left' : 'straight';
          arrow(g, cx, X.z + dir * (hz + CROSSWALK_GAP + CROSSWALK_W + 9), dir > 0 ? 0 : Math.PI, kind);
        });
      }
      // east/west legs (cross the EW road): bars run east–west
      for (const dir of [-1, 1]) {
        const x0 = X.x + dir * (hx + CROSSWALK_GAP);
        const x1 = x0 + dir * CROSSWALK_W;
        for (let z = X.z - hz + 0.9; z < X.z + hz - 0.5; z += 1.2) stripe(x0, z + 0.3, x1, z + 0.3, 0.6, WHITE);
        const xs = x1 + dir * 1.2;
        const za = X.z + (dir > 0 ? -0.25 : 0.25);
        const zb = X.z + (dir > 0 ? -hz + 0.4 : hz - 0.4);
        stripe(xs, za, xs, zb, 0.45, WHITE);
      }
    }

    const geoms = g.build();
    const paint = new THREE.Mesh(geoms.get('paint'), this.mat.paint);
    paint.receiveShadow = true;
    paint.renderOrder = 1;
    paint.name = 'road-paint';
    this.scene.add(paint);
  }

  /**
   * World-space wear map over the playable area:
   * R = oil/rubber darkening (lane centres, stop zones), G = polished wheel paths,
   * B = patch repairs, A = sealed cracks.
   */
  #wearMap() {
    const SIZE = 2048;
    const rect = { x0: -MAP_HALF - 40, z0: -MAP_HALF - 40, w: (MAP_HALF + 40) * 2, d: (MAP_HALF + 40) * 2 };
    const s = SIZE / rect.w;
    const px = (x) => (x - rect.x0) * s;
    const pz = (z) => (z - rect.z0) * s;
    const R = rng(77);
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, SIZE, SIZE);
      return [c, ctx];
    };
    const [cR, xR] = mk();
    const [cG, xG] = mk();
    const [cB, xB] = mk();
    const [cA, xA] = mk();

    const lanePaths = (road, axis, fn) => {
      const c = axis === 'ns' ? road.x : road.z;
      for (const side of [-1, 1]) {
        let off = 0.18;
        for (const w of road.lanes) {
          fn(c + side * (off + w / 2), side);
          off += w;
        }
      }
    };
    const strokeAlong = (ctx, axis, c, width, alpha) => {
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = width * s;
      ctx.beginPath();
      if (axis === 'ns') { ctx.moveTo(px(c), 0); ctx.lineTo(px(c), SIZE); }
      else { ctx.moveTo(0, pz(c)); ctx.lineTo(SIZE, pz(c)); }
      ctx.stroke();
    };
    xR.filter = `blur(${Math.round(0.35 * s)}px)`;
    xG.filter = `blur(${Math.round(0.2 * s)}px)`;
    for (const axis of ['ns', 'ew']) {
      for (const road of ROADS[axis]) {
        lanePaths(road, axis, (c) => {
          strokeAlong(xR, axis, c, 0.9, 0.45);
          strokeAlong(xG, axis, c - 0.85, 0.45, 0.55);
          strokeAlong(xG, axis, c + 0.85, 0.45, 0.55);
        });
      }
    }
    // heavier staining where cars idle at stop bars
    xR.filter = `blur(${Math.round(1.2 * s)}px)`;
    for (const X of INTERSECTIONS) {
      for (const dir of [-1, 1]) {
        lanePaths(X.ns, 'ns', (c, side) => {
          if (side !== dir) return;
          const z = X.z + dir * (X.ew.width / 2 + 8 + R.range(0, 6));
          xR.fillStyle = `rgba(255,255,255,${R.range(0.35, 0.6)})`;
          xR.beginPath();
          xR.ellipse(px(c), pz(z), 0.7 * s, R.range(2.5, 5) * s, 0, 0, Math.PI * 2);
          xR.fill();
        });
      }
    }
    // patch repairs (utility cuts), some long resurfacing strips
    xB.filter = `blur(${Math.max(1, Math.round(0.05 * s))}px)`;
    for (let i = 0; i < 70; i++) {
      const axis = R.chance(0.5) ? 'ns' : 'ew';
      const road = R.pick(ROADS[axis]);
      const c = (axis === 'ns' ? road.x : road.z) + R.range(-road.width / 2 + 1, road.width / 2 - 1);
      const along = R.range(-MAP_HALF, MAP_HALF);
      const a = R.range(0.8, 3.5), b = R.range(1.2, R.chance(0.15) ? 25 : 6);
      xB.fillStyle = `rgba(255,255,255,${R.range(0.55, 0.95)})`;
      if (axis === 'ns') xB.fillRect(px(c - a / 2), pz(along), a * s, b * s);
      else xB.fillRect(px(along), pz(c - a / 2), b * s, a * s);
    }
    // crack sealant: short meandering strokes
    xA.lineCap = 'round';
    for (let i = 0; i < 260; i++) {
      const axis = R.chance(0.5) ? 'ns' : 'ew';
      const road = R.pick(ROADS[axis]);
      let x = axis === 'ns' ? road.x + R.range(-road.width / 2, road.width / 2) : R.range(-MAP_HALF, MAP_HALF);
      let z = axis === 'ns' ? R.range(-MAP_HALF, MAP_HALF) : road.z + R.range(-road.width / 2, road.width / 2);
      xA.strokeStyle = `rgba(255,255,255,${R.range(0.25, 0.5)})`;
      xA.lineWidth = Math.max(0.6, 0.08 * s);
      xA.beginPath();
      xA.moveTo(px(x), pz(z));
      let ang = R.range(0, Math.PI * 2);
      for (let k = 0; k < 8; k++) {
        ang += R.range(-0.7, 0.7);
        x += Math.cos(ang) * R.range(0.4, 1.4);
        z += Math.sin(ang) * R.range(0.4, 1.4);
        xA.lineTo(px(x), pz(z));
      }
      xA.stroke();
    }

    const out = new Uint8Array(SIZE * SIZE * 4);
    const chans = [xR, xG, xB, xA].map((ctx) => ctx.getImageData(0, 0, SIZE, SIZE).data);
    for (let i = 0; i < SIZE * SIZE; i++) {
      out[i * 4] = chans[0][i * 4];
      out[i * 4 + 1] = chans[1][i * 4];
      out[i * 4 + 2] = chans[2][i * 4];
      out[i * 4 + 3] = chans[3][i * 4];
    }
    const tex = new THREE.DataTexture(out, SIZE, SIZE, THREE.RGBAFormat);
    // canvas y = +z, DataTexture rows go bottom-up in uv space: uv.y = (z - z0)/d matches row index
    tex.flipY = false;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    this.mat.setRoadWear(tex, rect);
    [cR, cG, cB, cA].forEach((c) => { c.width = c.height = 0; });
  }
}

function inset(b, d) {
  return { ...b, x0: b.x0 + d, x1: b.x1 - d, z0: b.z0 + d, z1: b.z1 - d };
}

/** Rounded rectangle in shape space (x, -z) so that after rotateX(-90°) it lands on world (x, z). */
function roundedRect(b, r) {
  const s = new THREE.Shape();
  const x0 = b.x0, x1 = b.x1;
  const y0 = -b.z1, y1 = -b.z0;
  // only round corners where two streets meet
  const st = b.streets ?? { w: true, e: true, n: true, s: true };
  const rSW = st.w && st.s ? r : 0;
  const rSE = st.e && st.s ? r : 0;
  const rNE = st.e && st.n ? r : 0;
  const rNW = st.w && st.n ? r : 0;
  s.moveTo(x0 + rSW, y0);
  s.lineTo(x1 - rSE, y0);
  if (rSE) s.quadraticCurveTo(x1, y0, x1, y0 + rSE);
  s.lineTo(x1, y1 - rNE);
  if (rNE) s.quadraticCurveTo(x1, y1, x1 - rNE, y1);
  s.lineTo(x0 + rNW, y1);
  if (rNW) s.quadraticCurveTo(x0, y1, x0, y1 - rNW);
  s.lineTo(x0, y0 + rSW);
  if (rSW) s.quadraticCurveTo(x0, y0, x0 + rSW, y0);
  return s;
}

/** Turn / straight arrow made from a flat shape. heading 0 = pointing -Z (north). */
function arrow(g, x, z, heading, kind) {
  const shape = new THREE.Shape();
  if (kind === 'straight') {
    shape.moveTo(-0.15, 0); shape.lineTo(0.15, 0); shape.lineTo(0.15, 3.2); shape.lineTo(0.45, 3.2);
    shape.lineTo(0, 4.8); shape.lineTo(-0.45, 3.2); shape.lineTo(-0.15, 3.2); shape.lineTo(-0.15, 0);
  } else {
    shape.moveTo(0.05, 0); shape.lineTo(0.35, 0); shape.lineTo(0.35, 2.6);
    shape.quadraticCurveTo(0.35, 3.4, -0.35, 3.45);
    shape.lineTo(-0.35, 3.85); shape.lineTo(-1.25, 3.25); shape.lineTo(-0.35, 2.65); shape.lineTo(-0.35, 3.05);
    shape.quadraticCurveTo(0.05, 3.0, 0.05, 2.6); shape.lineTo(0.05, 0);
  }
  const geom = new THREE.ShapeGeometry(shape, 6);
  geom.rotateX(-Math.PI / 2);   // shape y → world -z (forward)
  geom.rotateY(heading);
  geom.translate(x, PAINT_Y, z);
  const uv = geom.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0, 0.5);
  g.setTransform(new THREE.Matrix4());
  g.setColor(WHITE);
  g.geometry('paint', geom);
}

function mergeSimple(geoms) {
  let total = 0, idxTotal = 0;
  for (const g of geoms) { total += g.attributes.position.count; idxTotal += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const idx = new Uint32Array(idxTotal);
  let o = 0, io = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    const n = g.attributes.position.count;
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + o;
    else for (let i = 0; i < n; i++) idx[io++] = i + o;
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

export { mergeSimple };
