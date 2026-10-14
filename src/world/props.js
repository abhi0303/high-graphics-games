import * as THREE from 'three';
import { GeoBuilder } from './geo.js';
import { ROADS, INTERSECTIONS, CURB_H, CORNER_R, SIDEWALK_W, MAP_HALF, rng } from './layout.js';
import { CONFIG } from '../config.js';

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Matrix mapping a unit cylinder (r = 1, h = 1, centred, along Y) onto segment a→b with radius r. */
function segment(a, b, r) {
  const d = _v.subVectors(b, a);
  const len = d.length();
  _q.setFromUnitVectors(UP, d.clone().divideScalar(len));
  return new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), _q, new THREE.Vector3(r, len, r));
}
const T = (x, y, z, ry = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, ry), new THREE.Vector3(s, s, s));
const V = (x, y, z) => new THREE.Vector3(x, y, z);

const CYL = (segs = 10, r0 = 1, r1 = 1) => new THREE.CylinderGeometry(r1, r0, 1, segs, 1, false);

/** Street furniture, signals, poles, wires, signage structures, litter. */
export class Props {
  constructor(scene, assets, materials, signs, physics, plan) {
    this.scene = scene;
    this.assets = assets;
    this.mat = materials;
    this.signs = signs;
    this.physics = physics;
    this.plan = plan;
    this.B = new GeoBuilder();
    this.R = rng(4242);
    this.instances = new Map(); // glb path -> [matrices]
    this.cycleT = 35; // east–west green / north–south red: the reference car waits at a red light
    this.protos = this.#prototypes();
  }

  async build() {
    this.#materials();
    for (const X of INTERSECTIONS) this.#intersection(X);
    this.#streetLights();
    this.#utilityPoles();
    this.#heroDetails();
    this.#parking();
    this.#fences();
    for (const p of this.plan.extras.poleSigns) this.#poleSign(p);
    for (const b of this.plan.extras.billboards) this.#billboard(b);
    for (const p of this.plan.extras.plazas) this.#plaza(p);
    for (const y of this.plan.extras.yards) this.#autoYard(y);
    this.#streetClutter();
    this.#mapBoundary();
    this.#emit();
    await this.#emitInstances();
    this.#litter();
  }

  // ---------------------------------------------------------------- materials
  #materials() {
    const S = (p) => new THREE.MeshStandardMaterial(p);
    const lens = (color, axis) => {
      const m = S({ color: 0x050505, emissive: new THREE.Color(color), emissiveIntensity: 0, roughness: 0.15, metalness: 0 });
      m.userData.axis = axis;
      return m;
    };
    this.lens = {
      'lens:ns:r': lens(0xff1a0a, 'ns'), 'lens:ns:y': lens(0xffa200, 'ns'), 'lens:ns:g': lens(0x10ff9a, 'ns'),
      'lens:ew:r': lens(0xff1a0a, 'ew'), 'lens:ew:y': lens(0xffa200, 'ew'), 'lens:ew:g': lens(0x10ff9a, 'ew'),
    };
    this.mats = {
      ...this.lens,
      galv: this.mat.galvanized,
      paintedMetal: this.mat.paintedMetal,
      dark: this.mat.darkMetal,
      blackPlastic: this.mat.blackPlastic,
      sigBody: S({ color: 0x15171a, roughness: 0.5, metalness: 0.2 }),
      wire: this.mat.wire,
      ceramic: S({ color: 0x8a8c8a, roughness: 0.35, metalness: 0 }),
      wood: this.#woodMaterial(),
      lamp: S({ color: 0xd8d8d0, emissive: new THREE.Color(0.9, 0.85, 0.7), emissiveIntensity: 0.05, roughness: 0.3 }),
      bin: S({ color: 0x9c8a6a, roughness: 0.55, metalness: 0.45 }),
      binInner: S({ color: 0x1c1b19, roughness: 0.9 }),
      concrete: this.mat.walls.concrete,
      sign: this.signs.material,
      lightbox: this.signs.lightbox,
      paint: this.mat.paint,
      asphaltLot: this.mat.asphalt,
      soil: S({ color: 0x3b2f24, roughness: 1 }),
      fence: this.#chainLinkMaterial(),
      pedHand: S({ color: 0x080808, emissive: new THREE.Color(1, 0.35, 0.05), emissiveIntensity: 3.5, roughness: 0.3 }),
      litterPaper: S({ color: 0xe8e6df, roughness: 0.9 }),
    };
  }

  #woodMaterial() {
    const m = new THREE.MeshStandardMaterial({ color: 0xa08f7c, roughness: 0.9, metalness: 0 });
    const base = 'textures/pole_wood/pole_wood_';
    Promise.all([
      this.assets.texture(`${base}diff_1k.jpg`, { srgb: true }),
      this.assets.texture(`${base}nor_gl_1k.jpg`),
    ]).then(([map, nor]) => {
      m.map = map; m.normalMap = nor; m.color.set(0xffffff); m.needsUpdate = true;
    });
    return m;
  }

  #chainLinkMaterial() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 128, 128);
    x.strokeStyle = '#ffffff';
    x.lineWidth = 6;
    x.beginPath();
    x.moveTo(0, 0); x.lineTo(128, 128);
    x.moveTo(128, 0); x.lineTo(0, 128);
    x.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return new THREE.MeshStandardMaterial({
      color: 0x9da1a3, alphaMap: tex, alphaTest: 0.45, alphaToCoverage: true, transparent: false,
      side: THREE.DoubleSide, metalness: 0.7, roughness: 0.5,
    });
  }

  // --------------------------------------------------------------- prototypes
  #prototypes() {
    // Traffic signal head facing +Z, origin at the top bracket.
    const head = new GeoBuilder();
    head.box('sigBody', [-0.17, -1.02, -0.13], [0.17, -0.02, 0.12]);
    head.box('sigBody', [-0.33, -1.15, -0.155], [0.33, 0.1, -0.135]);   // backplate
    head.box('sigBody', [-0.04, -0.02, -0.04], [0.04, 0.12, 0.04]);     // bracket
    const lensGeo = new THREE.CylinderGeometry(0.105, 0.105, 0.02, 18).rotateX(Math.PI / 2);
    const visorGeo = new THREE.CylinderGeometry(0.135, 0.135, 0.24, 14, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
    const colors = ['r', 'y', 'g'];
    colors.forEach((c, i) => {
      const y = -0.2 - i * 0.31;
      head.setTransform(new THREE.Matrix4().makeTranslation(0, y, 0.125));
      head.geometry(`lens:${c}`, lensGeo);
      head.setTransform(new THREE.Matrix4().makeTranslation(0, y, 0.25));
      head.geometry('sigBody', visorGeo);
    });
    const ped = new GeoBuilder();
    ped.box('sigBody', [-0.2, -0.45, -0.1], [0.2, 0, 0.12]);
    ped.box('pedHand', [-0.15, -0.4, 0.121], [0.15, -0.06, 0.125], 'Z');
    return { head: head.build(), ped: ped.build(), cyl: CYL(10), cyl6: CYL(6), cyl16: CYL(16), sphere: new THREE.SphereGeometry(1, 14, 8) };
  }

  /** Place a prototype (Map key->geometry) with a matrix; keys may be remapped. */
  #place(proto, matrix, remap = (k) => k) {
    this.B.setTransform(matrix);
    for (const [k, g] of proto) this.B.geometry(remap(k), g);
  }

  #cyl(key, a, b, r, segs = 10) {
    this.B.setTransform(segment(a, b, r));
    this.B.geometry(key, segs === 6 ? this.protos.cyl6 : segs === 16 ? this.protos.cyl16 : this.protos.cyl, 1);
  }

  #box(key, matrix, min, max, faces) {
    this.B.setTransform(matrix);
    // vertex-coloured materials must not inherit the previous primitive's tint
    if (key === 'concrete') this.B.setColor([0.8, 0.82, 0.84]);
    this.B.box(key, min, max, faces);
  }

  // ------------------------------------------------------------- intersections
  #intersection(X) {
    const hx = X.ns.width / 2, hz = X.ew.width / 2;
    const off = 3.1;
    const main = X.x === 0 && X.z === 0;
    // One mast arm per corner, serving the approach whose far-right corner it is.
    const corners = [
      { sx: 1, sz: -1, axis: 'ns', armDir: V(-1, 0, 0), face: 0, lanes: X.ns.lanes, half: hx },        // NE: northbound
      { sx: -1, sz: 1, axis: 'ns', armDir: V(1, 0, 0), face: Math.PI, lanes: X.ns.lanes, half: hx },   // SW: southbound
      { sx: 1, sz: 1, axis: 'ew', armDir: V(0, 0, -1), face: -Math.PI / 2, lanes: X.ew.lanes, half: hz }, // SE: eastbound
      { sx: -1, sz: -1, axis: 'ew', armDir: V(0, 0, 1), face: Math.PI / 2, lanes: X.ew.lanes, half: hz },  // NW: westbound
    ];
    for (const c of corners) {
      const px = X.x + c.sx * (hx + off), pz = X.z + c.sz * (hz + off);
      const poleH = main ? 9.2 : 7.2;
      const armY = 6.2;
      const base = V(px, CURB_H, pz);
      this.#cyl('galv', base, V(px, CURB_H + poleH, pz), 0.17, 16);
      this.#cyl('galv', V(px, CURB_H, pz), V(px, CURB_H + 0.5, pz), 0.26, 16);    // base collar
      this.physics.cylinder(px, pz, 0.2, poleH, CURB_H);
      // mast arm (slight taper via two segments + upward sweep)
      const armLen = off + c.half - 0.4;
      const end = base.clone().add(V(0, armY, 0)).addScaledVector(c.armDir, armLen).add(V(0, 0.5, 0));
      const mid = base.clone().add(V(0, armY + 0.12, 0)).addScaledVector(c.armDir, armLen * 0.5);
      this.#cyl('galv', base.clone().add(V(0, armY, 0)), mid, 0.13);
      this.#cyl('galv', mid, end, 0.09);
      // tie rod
      this.#cyl('galv', base.clone().add(V(0, armY + 1.6, 0)), mid.clone().add(V(0, 0.2, 0)), 0.025, 6);
      // signal heads over each approach lane, facing oncoming traffic
      let lo = 0.18;
      const laneCentres = c.lanes.map((w) => { const v = lo + w / 2; lo += w; return v; });
      for (const lc of laneCentres) {
        // lanes are on the approach's right-hand side; arm points from the corner toward the centre line
        const along = c.axis === 'ns' ? Math.abs(X.x + c.sx * lc - px) : Math.abs(X.z + c.sz * lc - pz);
        const t = along / armLen;
        const hp = base.clone().add(V(0, armY + 0.5 * t + 0.12 * (1 - Math.abs(2 * t - 1)), 0)).addScaledVector(c.armDir, along);
        this.#place(this.protos.head, T(hp.x, hp.y - 0.12, hp.z, c.face), (k) => (k.startsWith('lens:') ? `lens:${c.axis}:${k.slice(5)}` : k));
      }
      // pole-mounted head for the arm's approach
      this.#place(this.protos.head, T(px, CURB_H + 4.6, pz, c.face).multiply(T(0, 0, 0.25)), (k) => (k.startsWith('lens:') ? `lens:${c.axis}:${k.slice(5)}` : k));
      // secondary near-side head for the approach that has this corner on its near right
      const near = { '1,1': ['ns', 0], '1,-1': ['ew', Math.PI / 2], '-1,1': ['ew', -Math.PI / 2], '-1,-1': ['ns', Math.PI] }[`${c.sx},${c.sz}`];
      this.#place(this.protos.head, T(px, CURB_H + 3.9, pz, near[1]).multiply(T(0, 0, 0.25)), (k) => (k.startsWith('lens:') ? `lens:${near[0]}:${k.slice(5)}` : k));
      // pedestrian heads facing the two crosswalks
      this.#place(this.protos.ped, T(px, CURB_H + 3.2, pz, c.sx > 0 ? -Math.PI / 2 : Math.PI / 2).multiply(T(0, 0, 0.2)));
      this.#place(this.protos.ped, T(px, CURB_H + 3.2, pz, c.sz > 0 ? Math.PI : 0).multiply(T(0, 0, 0.2)));
      // push-button box
      this.#box('sigBody', T(px, CURB_H + 1.0, pz, c.face), [-0.07, 0, 0.17], [0.07, 0.18, 0.25]);
      // street name blade on the arm
      const roadName = c.axis === 'ns' ? X.ew.name : X.ns.name;
      const uv = this.signs.uv(`street-${roadName}`);
      if (uv) {
        const sp = base.clone().add(V(0, armY + 0.75, 0)).addScaledVector(c.armDir, 2.6);
        const m = T(sp.x, sp.y, sp.z, c.face);
        this.B.setTransform(m);
        this.B.setColor([1, 1, 1]);
        const w = 1.9, h = 0.36;
        for (const side of [1, -1]) {
          const z = side * 0.012;
          const n = [0, 0, side];
          const q = side > 0
            ? [[-w / 2, -h / 2, z], [w / 2, -h / 2, z], [w / 2, h / 2, z], [-w / 2, h / 2, z]]
            : [[w / 2, -h / 2, z], [-w / 2, -h / 2, z], [-w / 2, h / 2, z], [w / 2, h / 2, z]];
          this.B.quad('sign', ...q, n, [[uv.u0, uv.v0], [uv.u1, uv.v0], [uv.u1, uv.v1], [uv.u0, uv.v1]]);
        }
        this.#cyl('galv', sp.clone().add(V(0, -0.18, 0)), sp.clone().add(V(0, -0.6, 0)), 0.03, 6);
      }
      // luminaire on top of tall poles
      if (main) this.#luminaire(V(px, CURB_H + poleH, pz), c.armDir, 2.4);
    }
    // storm drains at the four curb returns
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const gx = X.x + sx * (hx - 0.35), gz = X.z + sz * (hz + CORNER_R + 2.5);
      this.#box('dark', T(gx, 0.004, gz), [-0.3, 0, -0.5], [0.3, 0.012, 0.5], 'Y');
    }
  }

  #luminaire(top, dir, reach) {
    const a = top.clone();
    const b = top.clone().addScaledVector(dir, reach * 0.55).add(V(0, 0.45, 0));
    const c = top.clone().addScaledVector(dir, reach).add(V(0, 0.55, 0));
    this.#cyl('galv', a, b, 0.07);
    this.#cyl('galv', b, c, 0.06);
    // cobra head: flattened ellipsoid
    const head = c.clone().addScaledVector(dir, 0.35);
    const yaw = Math.atan2(dir.x, dir.z);
    this.B.setTransform(new THREE.Matrix4().compose(head, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06, yaw, 0, 'YXZ')), V(0.32, 0.13, 0.62)));
    this.B.geometry('paintedMetal', this.protos.sphere);
    this.B.setTransform(new THREE.Matrix4().compose(head.clone().add(V(0, -0.1, 0)), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), V(0.24, 0.03, 0.45)));
    this.B.geometry('lamp', this.protos.sphere);
  }

  // --------------------------------------------------------------- streetlights
  #streetLights() {
    const nearX = (p, along) => INTERSECTIONS.some((X) => Math.abs(along === 'z' ? X.z - p : X.x - p) < 26);
    for (const road of ROADS.ns) {
      for (const side of [-1, 1]) {
        const x = road.x + side * (road.width / 2 + 0.75);
        for (let z = -MAP_HALF + 10 + (side > 0 ? 18 : 0); z < MAP_HALF - 5; z += 38) {
          if (nearX(z, 'z')) continue;
          this.#streetLight(x, z, V(-side, 0, 0));
        }
      }
    }
    for (const road of ROADS.ew) {
      for (const side of [-1, 1]) {
        const z = road.z + side * (road.width / 2 + 0.75);
        for (let x = -MAP_HALF + 10 + (side > 0 ? 18 : 0); x < MAP_HALF - 5; x += 38) {
          if (nearX(x, 'x')) continue;
          this.#streetLight(x, z, V(0, 0, -side));
        }
      }
    }
  }

  #streetLight(x, z, dir) {
    const h = 8.8;
    this.#cyl('galv', V(x, CURB_H, z), V(x, CURB_H + h * 0.55, z), 0.12, 16);
    this.#cyl('galv', V(x, CURB_H + h * 0.55, z), V(x, CURB_H + h, z), 0.09, 16);
    this.#cyl('galv', V(x, CURB_H, z), V(x, CURB_H + 0.35, z), 0.2, 16);
    this.#luminaire(V(x, CURB_H + h, z), dir, 2.3);
    this.physics.cylinder(x, z, 0.14, h, CURB_H);
  }

  // ------------------------------------------------------------- utility poles
  #utilityPoles() {
    const R = this.R;
    // Pole lines along the north side of every east–west road and both sides of Vine Ave.
    const lines = [];
    for (const road of ROADS.ew) {
      const z = road.z - road.width / 2 - SIDEWALK_W + 0.55;
      const pts = [];
      for (let x = -MAP_HALF + 4; x <= MAP_HALF - 4; x += 41) {
        const xx = x + R.range(-3, 3);
        if (INTERSECTIONS.some((X) => Math.abs(X.x - xx) < X.ns.width / 2 + 2.5)) continue;
        pts.push(V(xx, CURB_H, z));
      }
      lines.push(pts);
    }
    for (const pts of lines) {
      const poles = pts.map((p, i) => this.#woodPole(p, 0, i % 3 === 1));
      for (let i = 0; i < poles.length - 1; i++) {
        if (poles[i + 1].base.distanceTo(poles[i].base) > 60) continue;
        poles[i].attach.forEach((a, k) => this.#wire(a, poles[i + 1].attach[k], k < 3 ? 0.012 : 0.022));
      }
    }
    // Spans across Grand Blvd at the main intersection — visible against the sky in the reference.
    const a = this.#woodPole(V(-14.5, CURB_H, 15.2), Math.PI / 2, false);
    const b = this.#woodPole(V(17.5, CURB_H, 15.8), Math.PI / 2, true);
    const northLine = lines[1];
    const nearN = (x) => northLine.reduce((best, p) => (Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best), northLine[0]);
    const pa = this.#poleAttachFor(nearN(-14));
    const pb = this.#poleAttachFor(nearN(18));
    for (let k = 0; k < 3; k++) {
      this.#wire(a.attach[k], pb[k], 0.012, 0.7);
      this.#wire(b.attach[k], pa[k], 0.012, 0.8);
    }
    this.#wire(a.attach[3], b.attach[3], 0.02, 0.9);
  }

  #poleAttachFor(p) {
    // attachment points of the standard crossarm for a pole at p (yaw 0)
    const top = CURB_H + 11.2;
    return [-1.05, 0.25, 1.05].map((x) => V(p.x + x, top + 0.23, p.z)).concat([V(p.x, top - 3.4, p.z + 0.2)]);
  }

  #woodPole(p, yaw, transformer) {
    const h = 11.6;
    const top = CURB_H + 11.2;
    this.#cyl('wood', V(p.x, CURB_H - 0.2, p.z), V(p.x, CURB_H + h, p.z), 0.155, 10);
    const m = T(p.x, 0, p.z, yaw);
    this.#box('wood', m, [-1.25, top - 0.05, -0.06], [1.25, top + 0.06, 0.06]);
    // braces
    const dir = V(Math.cos(yaw), 0, -Math.sin(yaw));
    this.#cyl('dark', V(p.x, top - 0.7, p.z).addScaledVector(dir, 0), V(p.x, top, p.z).addScaledVector(dir, 0.7), 0.012, 6);
    this.#cyl('dark', V(p.x, top - 0.7, p.z), V(p.x, top, p.z).addScaledVector(dir, -0.7), 0.012, 6);
    const attach = [];
    for (const x of [-1.05, 0.25, 1.05]) {
      const ip = V(p.x, top + 0.06, p.z).addScaledVector(dir, x);
      this.#cyl('ceramic', ip, ip.clone().add(V(0, 0.16, 0)), 0.045, 6);
      attach.push(ip.clone().add(V(0, 0.17, 0)));
    }
    // communications cable bracket lower down
    const comm = V(p.x, top - 3.4, p.z).add(V(0, 0, 0.2));
    this.#box('dark', T(p.x, top - 3.5, p.z, yaw), [-0.05, 0, -0.05], [0.05, 0.2, 0.25]);
    attach.push(comm);
    if (transformer) {
      const tp = V(p.x, top - 2.2, p.z).add(V(0, 0, -0.42));
      this.#cyl('paintedMetal', tp, tp.clone().add(V(0, 1.0, 0)), 0.3, 16);
      this.#cyl('dark', tp.clone().add(V(0, 1.0, 0)), tp.clone().add(V(0, 1.06, 0)), 0.31, 16);
    }
    this.physics.cylinder(p.x, p.z, 0.17, h, CURB_H);
    return { base: p, attach };
  }

  #wire(a, b, r, sagK = 1) {
    const span = a.distanceTo(b);
    const sag = (0.012 * span + 0.25) * sagK;
    const N = Math.max(6, Math.round(span / 3));
    let prev = a;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const p = a.clone().lerp(b, t);
      p.y -= sag * 4 * t * (1 - t);
      this.#cyl('wire', prev, p, r, 6);
      prev = p;
    }
  }

  // --------------------------------------------------------------- hero area
  #heroDetails() {
    const add = (path, m) => {
      if (!this.instances.has(path)) this.instances.set(path, []);
      this.instances.get(path).push(m);
    };
    this.add = add;
    // Right of the car (SE corner of the main intersection): utility cabinet, bin, planter.
    add('models/props/utility_box_02.glb', T(13.9, CURB_H, 17.6, -Math.PI / 2, 1.2));
    this.physics.box(13.9, CURB_H + 0.65, 17.6, 0.3, 0.65, 0.6);
    this.#trashCan(11.35, 18.2);
    add('models/props/utility_box_01.glb', T(-13.4, CURB_H, -27, Math.PI / 2, 1.1));
    add('models/props/utility_box_02.glb', T(13.6, CURB_H, -31, -Math.PI / 2, 1.1));
    // hydrants near corners (rule: ~0.7 m from the curb)
    for (const [x, z, r] of [[-10.7, -21.5, 0.4], [10.7, 24.5, 2.1], [10.7, -26, 1.0], [-10.7, 27, 2.6], [40, 12.7, 0.2], [-60, -12.7, 0.3]]) {
      add('models/props/fire_hydrant.glb', T(x, CURB_H, z, r, 1.05));
      this.physics.cylinder(x, z, 0.16, 0.8, CURB_H);
    }
    // pedestrian crossing signs (reference: yellow diamond at the far corner)
    this.#pedSign(13.0, -18.6, 0);
    this.#pedSign(-12.8, 18.6, Math.PI);
    // manholes and utility vaults in the road
    for (const [x, z] of [[4.5, 30], [-3.8, -24], [22, 5.5], [-30, -6.5], [5.2, -60], [-5, 70], [60, 4], [-75, -4.5], [112, 30], [-112, -40]]) {
      add('models/props/manhole.glb', T(x, 0.0, z, this.R.range(0, 6), 1.25));
    }
    // corner trash cans
    for (const [x, z] of [[-12.6, -17.9], [12.4, -17.6], [-12.3, 17.8]]) this.#trashCan(x, z);
    // bus bench on Grand Blvd
    this.#bench(-36, 13.6, 0);
    this.#bench(48, -13.7, Math.PI);
  }

  #pedSign(x, z, yaw) {
    const uv = this.signs.uv('ped');
    this.#cyl('galv', V(x, CURB_H, z), V(x, CURB_H + 3.3, z), 0.035, 8);
    const m = T(x, CURB_H + 2.75, z, yaw);
    this.B.setTransform(m);
    this.B.setColor([1, 1, 1]);
    const s = 0.62;
    // diamond: quad rotated 45° in its plane
    const q = [[0, -s, 0.05], [s, 0, 0.05], [0, s, 0.05], [-s, 0, 0.05]];
    const cx = (uv.u0 + uv.u1) / 2, cy = (uv.v0 + uv.v1) / 2, du = (uv.u1 - uv.u0) / 2 * 0.66, dv = (uv.v1 - uv.v0) / 2 * 0.66;
    this.B.quad('sign', ...q, [0, 0, 1], [[cx, cy - dv * 1.41], [cx + du * 1.41, cy], [cx, cy + dv * 1.41], [cx - du * 1.41, cy]]);
    this.B.quad('galv', [0, -s, 0.045], [-s, 0, 0.045], [0, s, 0.045], [s, 0, 0.045], [0, 0, -1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    this.physics.cylinder(x, z, 0.05, 3.3, CURB_H);
  }

  #trashCan(x, z) {
    const m = T(x, CURB_H, z, this.R.range(0, 6));
    const n = 18, r = 0.31, h = 0.92;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = Math.cos(a) * r, pz = Math.sin(a) * r;
      const sm = m.clone().multiply(T(px, 0, pz, -a));
      this.#box('bin', sm, [-0.045, 0.06, -0.012], [0.045, h, 0.012], 'xXzZY');
    }
    this.B.setTransform(m.clone().multiply(new THREE.Matrix4().compose(V(0, h / 2 + 0.03, 0), new THREE.Quaternion(), V(r - 0.02, h - 0.02, r - 0.02))));
    this.B.geometry('binInner', this.protos.cyl16);
    for (const y of [0.1, h - 0.06]) {
      this.B.setTransform(m.clone().multiply(new THREE.Matrix4().compose(V(0, y, 0), new THREE.Quaternion(), V(r + 0.02, 0.05, r + 0.02))));
      this.B.geometry('bin', this.protos.cyl16);
    }
    this.physics.cylinder(x, z, 0.33, h, CURB_H);
  }

  #bench(x, z, yaw) {
    const m = T(x, CURB_H, z, yaw);
    this.#box('concrete', m, [-0.9, 0, -0.2], [-0.75, 0.45, 0.2]);
    this.#box('concrete', m, [0.75, 0, -0.2], [0.9, 0.45, 0.2]);
    for (let i = 0; i < 4; i++) this.#box('wood', m, [-1.0, 0.45, -0.22 + i * 0.12], [1.0, 0.49, -0.13 + i * 0.12]);
    for (let i = 0; i < 3; i++) this.#box('wood', m, [-1.0, 0.6 + i * 0.13, -0.27], [1.0, 0.7 + i * 0.13, -0.23]);
    this.#box('dark', m, [-0.85, 0.45, -0.27], [-0.8, 1.0, -0.23]);
    this.#box('dark', m, [0.8, 0.45, -0.27], [0.85, 1.0, -0.23]);
  }

  // ----------------------------------------------------------- lots & fences
  #parking() {
    for (const p of this.plan.extras.parking) {
      const y = CURB_H + 0.02;
      this.B.setTransform(new THREE.Matrix4());
      this.B.setColor([1, 1, 1]);
      // uv = world (x, z) to match the asphalt shader's tangent frame
      this.B.quad('asphaltLot', [p.x0, y, p.z1], [p.x1, y, p.z1], [p.x1, y, p.z0], [p.x0, y, p.z0], [0, 1, 0],
        [[p.x0, p.z1], [p.x1, p.z1], [p.x1, p.z0], [p.x0, p.z0]]);
      // stall stripes along the back of the lot
      this.B.setColor([0.86, 0.86, 0.84]);
      for (let x = p.x0 + 1.5; p.stalls !== false && x < p.x1 - 1; x += 2.75) {
        const z0 = p.z0 + 0.4, z1 = p.z0 + 5.4;
        this.B.quad('paint', [x - 0.06, y + 0.006, z1], [x + 0.06, y + 0.006, z1], [x + 0.06, y + 0.006, z0], [x - 0.06, y + 0.006, z0], [0, 1, 0],
          [[0, 0], [0, 1], [5, 1], [5, 0]]);
        // wheel stop
        if (x + 1.37 < p.x1 - 1) this.#box('concrete', T(x + 1.37, y, z0 + 0.35), [-0.8, 0, -0.1], [0.8, 0.12, 0.1]);
      }
    }
  }

  #fences() {
    for (const f of this.plan.extras.fences) {
      const y = CURB_H;
      const h = 1.95;
      const runs = f.gate ? [[f.x0, f.gate[0]], [f.gate[1], f.x1]] : [[f.x0, f.x1]];
      for (const [x0, x1] of runs) {
        const n = Math.max(1, Math.round((x1 - x0) / 3));
        for (let i = 0; i <= n; i++) {
          const x = x0 + ((x1 - x0) * i) / n;
          this.#cyl('galv', V(x, y, f.z), V(x, y + h + 0.05, f.z), i === 0 || i === n ? 0.045 : 0.03, 8);
        }
        this.#cyl('galv', V(x0, y + h, f.z), V(x1, y + h, f.z), 0.02, 6);
        this.B.setTransform(new THREE.Matrix4());
        this.B.setColor([1, 1, 1]);
        const s = 1 / 0.06; // one diamond ≈ 6 cm
        this.B.quad('fence', [x0, y + 0.03, f.z], [x1, y + 0.03, f.z], [x1, y + h, f.z], [x0, y + h, f.z], [0, 0, 1],
          [[0, 0], [(x1 - x0) * s, 0], [(x1 - x0) * s, h * s], [0, h * s]]);
        this.physics.box((x0 + x1) / 2, y + h / 2, f.z, (x1 - x0) / 2, h / 2, 0.05);
      }
    }
  }

  #poleSign(p) {
    const y = CURB_H;
    const panelW = 3.4, panelH = 1.33;
    for (const dx of [-1.05, 1.05]) this.#cyl('paintedMetal', V(p.x + dx, y, p.z), V(p.x + dx, y + p.h, p.z), 0.14, 12);
    this.physics.box(p.x, y + 2, p.z, 1.2, 2, 0.2);
    p.panels.forEach((id, i) => {
      const uv = this.signs.uv(id);
      const cy = y + p.h - 0.2 - panelH / 2 - i * (panelH + 0.18);
      const m = T(p.x, cy, p.z, 0);
      this.#box('dark', m, [-panelW / 2 - 0.08, -panelH / 2 - 0.08, -0.22], [panelW / 2 + 0.08, panelH / 2 + 0.08, 0.22], 'xXyY');
      this.B.setTransform(m);
      this.B.setColor([1, 1, 1]);
      for (const side of [1, -1]) {
        const z = side * 0.225;
        const w = panelW / 2, h = panelH / 2;
        const q = side > 0 ? [[-w, -h, z], [w, -h, z], [w, h, z], [-w, h, z]] : [[w, -h, z], [-w, -h, z], [-w, h, z], [w, h, z]];
        this.B.quad('lightbox', ...q, [0, 0, side], [[uv.u0, uv.v0], [uv.u1, uv.v0], [uv.u1, uv.v1], [uv.u0, uv.v1]]);
      }
    });
  }

  #billboard(b) {
    const uv = this.signs.uv(b.id);
    const y = CURB_H;
    const W = 12.8, H = 4.27;
    const m = T(b.x, y, b.z, b.rot);
    const toW = (lx, ly, lz) => V(lx, ly, lz).applyMatrix4(m);
    for (const dx of [-3.4, 3.4]) this.#cyl('paintedMetal', toW(dx, 0, -0.4), toW(dx, b.h - H / 2, -0.4), 0.3, 12);
    const pm = m.clone().multiply(T(0, b.h, 0));
    this.#box('dark', pm, [-W / 2 - 0.15, -H / 2 - 0.15, -0.35], [W / 2 + 0.15, H / 2 + 0.15, 0], 'xXyYz');
    this.B.setTransform(pm);
    this.B.setColor([1, 1, 1]);
    this.B.quad('sign', [-W / 2, -H / 2, 0.01], [W / 2, -H / 2, 0.01], [W / 2, H / 2, 0.01], [-W / 2, H / 2, 0.01], [0, 0, 1],
      [[uv.u0, uv.v0], [uv.u1, uv.v0], [uv.u1, uv.v1], [uv.u0, uv.v1]]);
    // catwalk + light arms
    this.#box('galv', pm, [-W / 2, -H / 2 - 0.25, 0], [W / 2, -H / 2 - 0.2, 1.0], 'yYzZ');
    for (let i = -2; i <= 2; i++) {
      const lp = toW(i * 2.6, b.h - H / 2 - 0.2, 1.0);
      const lp2 = toW(i * 2.6, b.h - H / 2 - 0.05, 1.6);
      this.#cyl('dark', lp, lp2, 0.03, 6);
      this.#box('dark', T(lp2.x, lp2.y, lp2.z, b.rot), [-0.18, 0, -0.12], [0.18, 0.12, 0.12]);
    }
  }

  #plaza(p) {
    if (p.kind === 'lot') return this.#cornerLot(p);
    // concrete planters with shrubs, a bench, scattered clutter
    const planters = [
      [p.x0 + 3.4, p.z0 + 1.4, 5.0, 1.5],
      [p.x0 + 1.3, p.z0 + 8.0, 1.5, 7.5],
    ];
    for (const [cx, cz, w, d] of planters) {
      const m = T(cx, CURB_H, cz);
      this.#box('concrete', m, [-w / 2, 0, -d / 2], [w / 2, 0.62, d / 2], 'xXzZ');
      this.#box('concrete', m, [-w / 2 - 0.06, 0.62, -d / 2 - 0.06], [w / 2 + 0.06, 0.7, d / 2 + 0.06], 'xXyYzZ');
      this.#box('soil', m, [-w / 2 + 0.1, 0, -d / 2 + 0.1], [w / 2 - 0.1, 0.58, d / 2 - 0.1], 'Y');
      this.physics.box(cx, CURB_H + 0.35, cz, w / 2, 0.35, d / 2);
      const long = w > d;
      const n = Math.round(Math.max(w, d) / 1.1);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const x = cx + (long ? t * (w - 0.7) : this.R.range(-0.15, 0.15));
        const z = cz + (long ? this.R.range(-0.15, 0.15) : t * (d - 0.7));
        this.plan.extras.bushes.push({ x, y: CURB_H + 0.56, z, s: this.R.range(0.24, 0.3), rot: this.R.range(0, 6.28) });
        if (this.R.chance(0.4)) this.add('models/props/shrub_04.glb', T(x + this.R.range(-0.3, 0.3), CURB_H + 0.56, z, this.R.range(0, 6), 1.6));
      }
    }
    this.#bench(p.x0 + 6, p.z0 + 4.2, Math.PI);
    this.add('models/props/trashbag.glb', T(p.x0 + 12.5, CURB_H, p.z0 + 14.6, 1.2, 1.0));
    this.add('models/props/trashbag.glb', T(p.x0 + 13.1, CURB_H, p.z0 + 14.9, 2.5, 0.85));
  }

  /** Corner lot under the big tree: block wall, shrubs around the trunk, bench, junk. */
  #cornerLot(p) {
    const R = this.R;
    const y = CURB_H;
    // low painted block wall along the back and west edges
    const wall = (x0, z0, x1, z1) => {
      const m = new THREE.Matrix4();
      this.#box('concrete', m, [Math.min(x0, x1), y, Math.min(z0, z1)], [Math.max(x0, x1), y + 1.1, Math.max(z0, z1)]);
      this.#box('concrete', m, [Math.min(x0, x1) - 0.04, y + 1.1, Math.min(z0, z1) - 0.04], [Math.max(x0, x1) + 0.04, y + 1.18, Math.max(z0, z1) + 0.04]);
      this.physics.box((x0 + x1) / 2, y + 0.6, (z0 + z1) / 2, Math.abs(x1 - x0) / 2 + 0.1, 0.6, Math.abs(z1 - z0) / 2 + 0.1);
    };
    wall(p.x0, p.z0, p.x1 - 3, p.z0 + 0.3);
    wall(p.x0, p.z0, p.x0 + 0.3, p.z1 - 2);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = R.range(2.2, 3.4);
      this.plan.extras.bushes.push({ x: -17.5 + Math.cos(a) * r, y, z: -21.0 + Math.sin(a) * r, s: R.range(0.26, 0.36), rot: R.range(0, 6.28) });
    }
    for (let i = 0; i < 7; i++) this.plan.extras.bushes.push({ x: p.x0 + 1.1, y, z: p.z0 + 2 + i * 2.2, s: R.range(0.3, 0.38), rot: R.range(0, 6.28) });
    for (let i = 0; i < 5; i++) this.add('models/props/shrub_04.glb', T(p.x0 + 2.0, y, p.z0 + 3 + i * 2.6, R.range(0, 6), 1.8));
    this.add('models/props/trashbag.glb', T(p.x0 + 1.5, y, p.z0 + 1.2, 0.3, 1));
    this.add('models/props/trashbag.glb', T(p.x0 + 2.2, y, p.z0 + 1.0, 1.9, 0.9));
    this.add('models/props/road_barrier.glb', T(p.x1 - 6, y, p.z0 + 4, 0.1, 1));
    this.#streetLight(p.x1 - 1.0, p.z1 - 8, V(1, 0, 0));
  }

  /** Auto-repair forecourt: tyre stacks, oil drums, crates and boxes against the building. */
  #autoYard(y) {
    const R = this.R;
    const back = y.z0 + 0.6;
    const tyre = (x, z, n, lean = 0) => {
      for (let i = 0; i < n; i++) {
        const m = new THREE.Matrix4().compose(V(x + R.range(-0.04, 0.04), CURB_H + 0.08 + i * 0.165, z + R.range(-0.04, 0.04)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + lean, 0, R.range(0, 6))), V(1, 1, 1));
        this.add('models/props/old_tyre.glb', m);
      }
    };
    for (let x = y.x0 + 1.2; x < y.x0 + 9; x += 0.7) tyre(x, back + R.range(0, 0.3), R.int(3, 7));
    for (let x = y.x1 - 6; x < y.x1 - 1; x += 0.7) tyre(x, back + 0.2, R.int(2, 6));
    for (let i = 0; i < 5; i++) tyre(y.x0 + 3 + i * 0.75, back + 1.4, 1);
    for (let i = 0; i < 6; i++) {
      this.add('models/props/barrel_03.glb', T(y.x0 + 11 + (i % 3) * 0.68, CURB_H, back + Math.floor(i / 3) * 0.68, R.range(0, 6)));
    }
    this.add('models/props/wooden_crate_02.glb', T(y.x1 - 9, CURB_H, back + 0.4, 0.1));
    this.add('models/props/wooden_crate_02.glb', T(y.x1 - 9.1, CURB_H + 0.45, back + 0.45, -0.15));
    for (let i = 0; i < 4; i++) this.add('models/props/plastic_crate_01.glb', T(y.x1 - 12 + i * 0.45, CURB_H + (i === 3 ? 0.26 : 0), back + 0.3, R.range(-0.2, 0.2)));
    for (let i = 0; i < 5; i++) this.add('models/props/cardboard_box_01.glb', T(y.x0 + 15 + R.range(0, 3), CURB_H + (i > 2 ? 0.34 : 0), back + R.range(0, 1), R.range(0, 6)));
    this.add('models/props/trashbag.glb', T(y.x0 + 9.5, CURB_H, back + 0.3, 0.7));
    this.physics.box((y.x0 + 9) / 2 + 0.5, CURB_H + 0.5, back + 0.5, 4.5, 0.5, 0.8);
  }

  #streetClutter() {
    const R = this.R;
    for (const s of this.plan.extras.storefronts) {
      if (R.chance(0.35)) this.#trashCan(s.x + R.range(-s.w / 3, s.w / 3), s.z + s.faces * (SIDEWALK_W - 1.0));
      if (R.chance(0.25)) this.add('models/props/trashbag.glb', T(s.x + R.range(-s.w / 2, s.w / 2), CURB_H, s.z + s.faces * 0.5, R.range(0, 6), R.range(0.8, 1.1)));
      if (R.chance(0.3)) this.add('models/props/aircon.glb', T(s.x + R.range(-s.w / 3, s.w / 3), CURB_H + 2.6, s.z - s.faces * 0.05, s.faces > 0 ? 0 : Math.PI, 1));
    }
  }

  /** Concrete jersey barriers closing every road at the edge of the playable map + invisible walls. */
  #mapBoundary() {
    const edge = MAP_HALF + 41.5;
    const profile = new THREE.Shape([
      [-0.3, 0], [0.3, 0], [0.28, 0.08], [0.16, 0.33], [0.08, 0.81], [-0.08, 0.81], [-0.16, 0.33], [-0.28, 0.08],
    ].map(([x, y]) => new THREE.Vector2(x, y)));
    const seg = new THREE.ExtrudeGeometry(profile, { depth: 3.6, bevelEnabled: false });
    seg.translate(0, 0, -1.8);
    const R = this.R;
    const barrierLine = (cx, cz, along, len) => {
      const n = Math.ceil(len / 3.7);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const x = along === 'x' ? cx + t * len : cx;
        const z = along === 'z' ? cz + t * len : cz;
        // segments run along `along`; extrusion axis is local z
        const yaw = (along === 'x' ? Math.PI / 2 : 0) + R.range(-0.03, 0.03);
        this.B.setTransform(T(x, 0, z, yaw));
        this.B.setColor([0.8, 0.82, 0.84]);
        this.B.geometry('concrete', seg);
      }
    };
    for (const road of ROADS.ns) for (const side of [-1, 1]) barrierLine(road.x, side * edge, 'x', road.width + 2 * SIDEWALK_W);
    for (const road of ROADS.ew) for (const side of [-1, 1]) barrierLine(side * edge, road.z, 'z', road.width + 2 * SIDEWALK_W);
    const L = edge + 20;
    for (const side of [-1, 1]) {
      this.physics.box(side * (edge + 0.2), 2, 0, 0.5, 2.5, L);
      this.physics.box(0, 2, side * (edge + 0.2), L, 2.5, 0.5);
    }
  }

  // ----------------------------------------------------------------- output
  #emit() {
    const group = new THREE.Group();
    group.name = 'props';
    for (const [key, geom] of this.B.build()) {
      const mat = key.startsWith('lens:') ? this.lens[key] : this.mats[key];
      if (!mat) { console.warn('no prop material', key); continue; }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = !['paint', 'asphaltLot', 'lamp', 'sign', 'lightbox'].includes(key) && !key.startsWith('lens');
      mesh.receiveShadow = true;
      if (key === 'paint') mesh.renderOrder = 1;
      group.add(mesh);
    }
    this.scene.add(group);
    this.group = group;
  }

  async #emitInstances() {
    for (const [path, mats] of this.instances) {
      const gltf = await this.assets.gltf(path);
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const im = new THREE.InstancedMesh(o.geometry, o.material, mats.length);
        mats.forEach((m, i) => im.setMatrixAt(i, m.clone().multiply(o.matrixWorld)));
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        if (o.material.map) o.material.map.anisotropy = this.assets.maxAnisotropy;
        this.group.add(im);
      });
    }
  }

  /** Small litter scattered along curbs and storefronts (instanced). */
  #litter() {
    const R = rng(99);
    const can = new THREE.CylinderGeometry(0.033, 0.033, 0.12, 10).rotateZ(Math.PI / 2);
    const cup = new THREE.CylinderGeometry(0.045, 0.033, 0.11, 10, 1, true).rotateZ(Math.PI / 2);
    const paper = new THREE.IcosahedronGeometry(0.045, 1);
    const pp = paper.attributes.position;
    for (let i = 0; i < pp.count; i++) pp.setXYZ(i, pp.getX(i) * (0.8 + Math.random() * 0.5), pp.getY(i) * (0.6 + Math.random() * 0.4), pp.getZ(i) * (0.8 + Math.random() * 0.5));
    paper.computeVertexNormals();
    const kinds = [
      { g: can, m: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.85, roughness: 0.3 }), n: 140, colors: [0xc9302c, 0xd8d8d8, 0x2a5db0, 0x2f8f3a, 0xe0b62a] },
      { g: cup, m: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide }), n: 70, colors: [0xf2f0ea, 0xd23a2e, 0xffffff] },
      { g: paper, m: this.mats.litterPaper, n: 200, colors: [0xffffff, 0xe6dfcf, 0xd8d4c8] },
    ];
    const spots = [];
    // gutters along every curb segment + sidewalks near the hero intersection
    for (let i = 0; i < 900; i++) {
      const road = R.chance(0.5) ? R.pick(ROADS.ns) : R.pick(ROADS.ew);
      const isNS = ROADS.ns.includes(road);
      const side = R.chance(0.5) ? 1 : -1;
      const along = R.range(-MAP_HALF, MAP_HALF);
      const across = side * (road.width / 2 - R.range(0.08, 0.5));
      const onWalk = R.chance(0.3);
      const off = onWalk ? side * R.range(0.4, SIDEWALK_W - 0.4) : 0;
      const p = isNS ? [road.x + across + off, along] : [along, road.z + across + off];
      if (INTERSECTIONS.some((X) => Math.abs(X.x - p[0]) < X.ns.width / 2 && Math.abs(X.z - p[1]) < X.ew.width / 2)) continue;
      spots.push([p[0], onWalk ? CURB_H : 0, p[1]]);
    }
    for (let i = 0; i < 60; i++) spots.push([R.range(9, 24), CURB_H, R.range(13, 30)]);   // around the car's corner
    let s = 0;
    const col = new THREE.Color();
    for (const k of kinds) {
      const im = new THREE.InstancedMesh(k.g, k.m, k.n);
      for (let i = 0; i < k.n; i++) {
        const [x, y, z] = spots[s++ % spots.length];
        const m = new THREE.Matrix4().compose(V(x, y + 0.03, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(R.range(-0.2, 0.2), R.range(0, 6.28), R.range(-0.2, 0.2))), V(1, R.range(0.7, 1), 1));
        im.setMatrixAt(i, m);
        im.setColorAt(i, col.set(R.pick(k.colors)));
      }
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    }
  }

  /** Signal state for an approach axis ('ns' | 'ew'): 'g' | 'y' | 'r'. Shared by AI traffic. */
  phase(axis) {
    const local = axis === 'ns' ? this.cycleT : (this.cycleT + 25) % 50;
    if (local < 20) return 'g';
    if (local < 23.5) return 'y';
    return 'r';
  }

  /** Traffic light cycle: NS green → yellow → all red → EW green → yellow → all red. */
  update(dt) {
    if (!CONFIG.capture) this.cycleT = (this.cycleT + dt) % 50;
    for (const [key, m] of Object.entries(this.lens)) {
      const [, axis, c] = key.split(':');
      const on = this.phase(axis) === c;
      m.emissiveIntensity = on ? (c === 'r' ? 14 : 10) : 0;
      m.color.setScalar(on ? 0.4 : 0.02);
    }
  }
}
