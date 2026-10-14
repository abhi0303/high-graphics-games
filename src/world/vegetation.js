import * as THREE from 'three';
import { GeoBuilder } from './geo.js';
import { ROADS, INTERSECTIONS, CURB_H, MAP_HALF, rng } from './layout.js';
import { CONFIG } from '../config.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Trees and palms.
 * - Broadleaf trees: Poly Haven "island_tree_01" scan, thinned in Blender
 *   (tools/process_tree.py) into two LODs, drawn as InstancedMeshes; instances
 *   migrate between LODs by camera distance.
 * - Fan palms: generated here (trunk rings, pleated fan fronds, dead-frond skirt).
 */
export class Vegetation {
  constructor(scene, assets, materials, physics, plan, renderer) {
    this.renderer = renderer;
    this.scene = scene;
    this.assets = assets;
    this.mat = materials;
    this.physics = physics;
    this.plan = plan;
    this.trees = [];
    this.timer = 0;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    scene.add(this.group);
  }

  async build() {
    this.#placeTrees();
    await this.#buildTrees();
    this.#buildPalms();
  }

  #placeTrees() {
    const R = rng(808);
    const t = this.trees;
    for (const h of this.plan.extras.trees) t.push({ ...h });
    // street trees in tree wells along some sidewalks
    const wells = [];
    const clearOfX = (x, z) => !INTERSECTIONS.some((X) => Math.abs(X.x - x) < X.ns.width / 2 + 11 && Math.abs(X.z - z) < X.ew.width / 2 + 11);
    for (const road of ROADS.ew) {
      for (const side of [-1, 1]) {
        if (road.name === 'Grand Blvd' && side < 0) continue; // north side of Grand carries the pole line
        const z = road.z + side * (road.width / 2 + 1.6);
        for (let x = -MAP_HALF + 8; x < MAP_HALF - 8; x += R.range(15, 24)) {
          if (!clearOfX(x, z) || R.chance(0.45)) continue;
          wells.push([x, z]);
        }
      }
    }
    for (const road of ROADS.ns) {
      if (road.name === 'Vine Ave') continue;
      for (const side of [-1, 1]) {
        const x = road.x + side * (road.width / 2 + 1.6);
        for (let z = -MAP_HALF + 8; z < MAP_HALF - 8; z += R.range(18, 28)) {
          if (!clearOfX(x, z) || R.chance(0.5)) continue;
          wells.push([x, z]);
        }
      }
    }
    for (const [x, z] of wells) t.push({ x, z, scale: R.range(1.5, 2.1), rot: R.range(0, 6.28), well: true });
    this.wells = wells;
  }

  async #buildTrees() {
    const [hero, lod0, lod1] = await Promise.all([
      this.assets.gltf('models/trees/island_tree_hero.glb'),
      this.assets.gltf('models/trees/island_tree_lod0.glb'),
      this.assets.gltf('models/trees/island_tree_lod1.glb'),
    ]);
    const parts = (gltf) => {
      const out = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        m.transparent = false;
        m.depthWrite = true;
        m.alphaTest = 0;
        m.side = THREE.DoubleSide;
        if (m.map) m.map.anisotropy = this.assets.maxAnisotropy;
        if (/leaves|leaf/i.test(o.name) || /leaves/i.test(m.name)) this.#leafShading(m);
        out.push({ geom: o.geometry.clone().applyMatrix4(o.matrixWorld), mat: m });
      });
      return out;
    };
    const ph = parts(hero), p0 = parts(lod0), p1 = parts(lod1);
    const n = this.trees.length;
    const imp = this.#impostor(p1);
    this.#bushes(p1);
    this.lods = [ph, p0, p1, [imp]].map((parts) => parts.map(({ geom, mat }) => {
      const im = new THREE.InstancedMesh(geom, mat, n);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.group.add(im);
      return im;
    }));
    this.treeMatrices = this.trees.map((t) => new THREE.Matrix4().compose(
      new THREE.Vector3(t.x, CURB_H, t.z), new THREE.Quaternion().setFromAxisAngle(UP, t.rot), new THREE.Vector3(t.scale, t.scale * (t.big ? 1.0 : 1.08), t.scale)));
    for (const t of this.trees) this.physics.cylinder(t.x, t.z, 0.18 * t.scale, 3, CURB_H);

    // soil + iron grate in each tree well
    const B = new GeoBuilder();
    for (const [x, z] of this.wells) {
      B.box('soil', [x - 0.75, CURB_H - 0.03, z - 0.75], [x + 0.75, CURB_H + 0.004, z + 0.75], 'Y');
      B.box('grate', [x - 0.8, CURB_H + 0.004, z - 0.8], [x + 0.8, CURB_H + 0.012, z - 0.72], 'Y');
      B.box('grate', [x - 0.8, CURB_H + 0.004, z + 0.72], [x + 0.8, CURB_H + 0.012, z + 0.8], 'Y');
      B.box('grate', [x - 0.8, CURB_H + 0.004, z - 0.72], [x - 0.72, CURB_H + 0.012, z + 0.72], 'Y');
      B.box('grate', [x + 0.72, CURB_H + 0.004, z - 0.72], [x + 0.8, CURB_H + 0.012, z + 0.72], 'Y');
    }
    const g = B.build();
    const soil = new THREE.MeshStandardMaterial({ color: 0x2f261e, roughness: 1 });
    if (g.get('soil')) this.group.add(Object.assign(new THREE.Mesh(g.get('soil'), soil), { receiveShadow: true }));
    if (g.get('grate')) this.group.add(Object.assign(new THREE.Mesh(g.get('grate'), this.mat.darkMetal), { receiveShadow: true }));
    this.update(0, null, true);
  }

  /**
   * Dense ornamental shrubs: the scanned tree's leaf + twig crown (no trunk),
   * shrunk to ~1.4 m so its leaves become small and tightly packed.
   */
  #bushes(parts) {
    const list = this.plan.extras.bushes ?? [];
    if (!list.length) return;
    const crown = parts.filter((p) => /leaves|branches/i.test(p.mat.name));
    for (const { geom, mat } of crown) {
      geom.computeBoundingBox();
      const im = new THREE.InstancedMesh(geom, mat, list.length);
      list.forEach((b, i) => {
        const m = new THREE.Matrix4().compose(new THREE.Vector3(b.x, b.y - 0.62 * b.s, b.z),
          new THREE.Quaternion().setFromAxisAngle(UP, b.rot), new THREE.Vector3(b.s * 1.15, b.s, b.s * 1.15));
        im.setMatrixAt(i, m);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    }
  }

  /**
   * Bake the LOD1 tree into an albedo+alpha texture (ambient-only lighting
   * returns albedo for a Lambert surface) and return crossed quads using it.
   */
  #impostor(parts) {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    for (const p of parts) group.add(new THREE.Mesh(p.geom, p.mat));
    scene.add(group, new THREE.AmbientLight(0xffffff, Math.PI));
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const w = Math.max(size.x, size.z) * 1.02, h = size.y * 1.02;
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 200);
    cam.position.set(c.x, c.y, c.z + 60);
    cam.lookAt(c);
    const res = 512;
    const rt = new THREE.WebGLRenderTarget(res, Math.round((res * h) / w), { samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const r = this.renderer;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, cam);
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
    this.impostorRT = rt;

    // two crossed quads, base at y = box.min.y, normals splayed outward/upward to fake volume
    const geom = new THREE.BufferGeometry();
    const pos = [], nor = [], uv = [], idx = [];
    for (const rot of [0, Math.PI / 2]) {
      const cx = Math.cos(rot), cz = -Math.sin(rot);
      const base = pos.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const lx = (u - 0.5) * w;
        const y = box.min.y + v * h;
        pos.push(c.x + lx * cx, y, c.z + lx * cz);
        const n = new THREE.Vector3((u - 0.5) * 1.6 * cx, 0.35 + v * 0.6, (u - 0.5) * 1.6 * cz).normalize();
        nor.push(n.x, n.y, n.z);
        uv.push(u, v);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geom.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ map: rt.texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    this.#leafShading(mat);
    return { geom, mat };
  }

  /** Cheap foliage translucency: light the back face with transmitted sun, plus slight hue drift. */
  #leafShading(m) {
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        {
          vec3 L = directionalLights[0].direction;
          float back = saturate(dot(-normal, L));
          reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * vec3(0.9, 1.0, 0.45) * back * 0.35;
        }
        #endif`);
    };
    m.customProgramCacheKey = () => 'leaf-translucent';
    m.color.multiplyScalar(1.05);
  }

  #buildPalms() {
    const R = rng(515);
    const variants = [0, 1, 2].map((i) => palmGeometry(rng(900 + i), 16 + i * 3));
    const trunkMat = new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: 0.95, metalness: 0 });
    trunkMat.map.anisotropy = 8;
    const frondMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.45 });
    this.#leafShading(frondMat);
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, envMapIntensity: 0.4 });

    const spots = [];
    // hero blocks: behind the restaurant, behind the auto shop, along 5th St; plus distant groves
    for (const [x, z] of [[49, -55], [55, -58], [21, -50], [-86, -60], [-80, -64], [-30, -70], [70, 40], [-40, 60], [92, -90], [-95, 95],
      [140, -140], [160, -150], [-150, -160], [30, -150], [-60, -140], [100, -175], [-120, 150]]) spots.push([x, z, R.range(0.85, 1.25)]);
    for (let x = -MAP_HALF + 15; x < MAP_HALF - 15; x += R.range(22, 34)) {
      if (R.chance(0.45)) continue;
      spots.push([x, 112 + 7.5 + 1.7, R.range(0.9, 1.2)]);
    }
    // far palms sprinkled around the horizon so the skyline has the LA silhouette
    for (let i = 0; i < 40; i++) {
      const a = R.range(0, Math.PI * 2), d = R.range(260, 700);
      spots.push([Math.cos(a) * d, Math.sin(a) * d, R.range(0.9, 1.4)]);
    }
    const buckets = variants.map(() => []);
    for (const [x, z, s] of spots) {
      const v = Math.floor(R() * variants.length);
      buckets[v].push(new THREE.Matrix4().compose(new THREE.Vector3(x, CURB_H, z), new THREE.Quaternion().setFromAxisAngle(UP, R.range(0, 6.28)), new THREE.Vector3(s, s, s)));
      if (Math.abs(x) < MAP_HALF && Math.abs(z) < MAP_HALF) this.physics.cylinder(x, z, 0.3 * s, 4, CURB_H);
    }
    variants.forEach((v, i) => {
      const mats = buckets[i];
      if (!mats.length) return;
      for (const [geom, mat] of [[v.trunk, trunkMat], [v.fronds, frondMat], [v.skirt, skirtMat]]) {
        const im = new THREE.InstancedMesh(geom, mat, mats.length);
        mats.forEach((m, k) => im.setMatrixAt(k, m));
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    });
  }

  /** Re-bucket broadleaf trees into LOD0 / LOD1 by distance (every few frames). */
  update(dt, camera, force = false) {
    if (!this.lods) return;
    this.timer += dt;
    if (!force && this.timer < 0.25) return;
    this.timer = 0;
    const lodDist = CONFIG.quality.treeLodDistance;
    const cam = camera?.position ?? new THREE.Vector3(8, 2, 26);
    const buckets = [[], [], [], []];
    this.trees.forEach((t, i) => {
      const d = Math.hypot(t.x - cam.x, t.z - cam.z);
      const lod = t.hero && d < 160 ? 0 : (t.big && d < 120) || d < lodDist ? 1 : d < lodDist * 1.9 ? 2 : 3;
      buckets[lod].push(i);
    });
    const fill = (meshes, idx) => meshes.forEach((im) => {
      idx.forEach((ti, k) => im.setMatrixAt(k, this.treeMatrices[ti]));
      im.count = idx.length;
      im.instanceMatrix.needsUpdate = true;
    });
    buckets.forEach((b, i) => fill(this.lods[i], b));
  }
}

/** Washingtonia robusta: tall slim trunk, compact crown of pleated fan leaves, skirt of dead fronds. */
function palmGeometry(R, height) {
  const B = new GeoBuilder();
  const lean = new THREE.Vector3(R.range(-1, 1), 0, R.range(-1, 1)).normalize().multiplyScalar(R.range(0.2, 1.2));
  const trunkPoint = (t) => new THREE.Vector3(lean.x * t * t, t * height, lean.z * t * t);
  // trunk: tapered tube with metric v so bark rings stay ~constant size
  const segs = 14, radial = 10;
  const trunk = new THREE.BufferGeometry();
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const c = trunkPoint(t);
    const r = THREE.MathUtils.lerp(0.34, 0.2, Math.sqrt(t)) * (i === 0 ? 1.25 : 1);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      pos.push(c.x + n.x * r, c.y, c.z + n.z * r);
      nor.push(n.x, n.y, n.z);
      uv.push(j / radial, (t * height) / 1.6);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  trunk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  trunk.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  trunk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  trunk.setIndex(idx);

  const top = trunkPoint(1);
  const green = [[0.13, 0.2, 0.05], [0.16, 0.24, 0.06], [0.2, 0.25, 0.07], [0.12, 0.18, 0.06]];
  const fan = (key, base, dir, len, droop, colorFn, fanR) => {
    // petiole
    const tip = base.clone().addScaledVector(dir, len);
    const segN = 5;
    for (let k = 0; k < segN; k++) {
      const a = base.clone().addScaledVector(dir, (k / segN) * len);
      const b = base.clone().addScaledVector(dir, ((k + 1) / segN) * len);
      a.y -= droop * 0.15 * (k / segN) ** 2; b.y -= droop * 0.15 * ((k + 1) / segN) ** 2;
      B.setColor(colorFn(0.3));
      ribbon(B, key, a, b, 0.035);
    }
    tip.y -= droop * 0.15;
    // fan blade: radial pleats in the plane spanned by dir and its horizontal perpendicular
    const side = new THREE.Vector3().crossVectors(dir, UP).normalize();
    if (side.lengthSq() < 0.01) side.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(side, dir).normalize();
    const N = 18, rings = 3;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = THREE.MathUtils.lerp(-1.75, 1.75, i / N);
      const row = [];
      for (let k = 0; k <= rings; k++) {
        const r = (k / rings) * fanR * (0.92 + 0.08 * Math.cos(a * 3));
        const p = tip.clone().addScaledVector(dir, Math.cos(a) * r * 0.85).addScaledVector(side, Math.sin(a) * r).addScaledVector(up, Math.cos(a) * r * 0.2);
        p.y -= droop * (r / fanR) ** 2 * 0.75 + Math.max(0, r / fanR - 0.55) * 0.35;
        // pleat: alternate radial lines up/down
        p.addScaledVector(up, (i % 2 ? 1 : -1) * 0.05 * (k / rings));
        row.push(p);
      }
      pts.push(row);
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < rings; k++) {
      const a = pts[i][k], b = pts[i + 1][k], c = pts[i + 1][k + 1], d = pts[i][k + 1];
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
      B.setColor(colorFn(k / rings));
      B.quad(key, a.toArray(), b.toArray(), c.toArray(), d.toArray(), n.toArray(), [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
  };
  // live crown
  const nLive = R.int(28, 36);
  for (let i = 0; i < nLive; i++) {
    // golden-angle spiral gives an even, ball-shaped crown
    const az = i * 2.39996 + R.range(-0.15, 0.15);
    const k = i / nLive;
    const el = THREE.MathUtils.lerp(0.85, -0.75, k) + R.range(-0.12, 0.12);
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const g = k > 0.85 ? [0.32, 0.3, 0.1] : R.pick(green);
    fan('fronds', top.clone().add(new THREE.Vector3(0, R.range(-0.4, 0.2), 0)), dir, R.range(1.1, 1.7), R.range(0.6, 1.4),
      (t) => [g[0] * (1 + t * 0.45), g[1] * (1 + t * 0.3), g[2] * (1 + t * 0.2)], R.range(0.95, 1.25));
  }
  // skirt of dead fronds hanging down
  const nDead = R.int(14, 22);
  const skirtLen = R.range(1.5, 3.2);
  for (let i = 0; i < nDead; i++) {
    const az = (i / nDead) * Math.PI * 2 + R.range(-0.3, 0.3);
    const dir = new THREE.Vector3(Math.cos(az) * 0.32, -1, Math.sin(az) * 0.32).normalize();
    const b = R.range(0.3, 0.42);
    const col = [b, b * 0.78, b * 0.55];
    fan('skirt', top.clone().add(new THREE.Vector3(Math.cos(az) * 0.15, -0.3, Math.sin(az) * 0.15)), dir, 0.4, 0.05,
      () => col, skirtLen * R.range(0.5, 0.7));
  }
  const g = B.build();
  return { trunk, fronds: g.get('fronds'), skirt: g.get('skirt') };
}

/** Thin quad strip between a and b (camera-agnostic: two crossed quads). */
function ribbon(B, key, a, b, w) {
  const d = new THREE.Vector3().subVectors(b, a).normalize();
  const s1 = new THREE.Vector3().crossVectors(d, UP).normalize().multiplyScalar(w);
  if (s1.lengthSq() < 1e-6) s1.set(w, 0, 0);
  const s2 = new THREE.Vector3().crossVectors(d, s1).normalize().multiplyScalar(w);
  for (const s of [s1, s2]) {
    const n = new THREE.Vector3().crossVectors(d, s).normalize();
    B.quad(key, a.clone().sub(s).toArray(), a.clone().add(s).toArray(), b.clone().add(s).toArray(), b.clone().sub(s).toArray(), n.toArray(), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
}

/** Ringed palm bark painted on a canvas. */
function barkTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#7a6e60';
  x.fillRect(0, 0, 128, 256);
  const R = rng(31);
  for (let y = 0; y < 256; y += R.range(5, 9)) {
    x.fillStyle = `rgba(${R.int(40, 70)},${R.int(34, 58)},${R.int(26, 44)},${R.range(0.5, 0.9)})`;
    x.fillRect(0, y, 128, R.range(1.5, 3.5));
    x.fillStyle = `rgba(190,175,150,${R.range(0.1, 0.3)})`;
    x.fillRect(0, y + 3, 128, 1.5);
  }
  for (let i = 0; i < 260; i++) {
    x.fillStyle = `rgba(30,25,20,${R.range(0.1, 0.35)})`;
    x.fillRect(R.range(0, 128), R.range(0, 256), R.range(1, 3), R.range(3, 14));
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
