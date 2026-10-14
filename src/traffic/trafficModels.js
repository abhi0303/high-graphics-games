import * as THREE from 'three';
import { ASSET_ROOT } from '../config.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TAIL_RX = /back.?light|tail|rear.?light|brake|stop.?light|rear.?lamp|lamp.?rear|red.?light/i;
const HEAD_RX = /head.?light|front.?light|headlamp|head.?lamp|front.?lamp/i;
const LAMP_RX = /light|lamp|led\b|^tled|lens/i; // generic lamp materials (front + rear in one texture)
const NOT_LAMP_RX = /lightmap|interior|inside|interrior|plate|mirror/i;

/**
 * Loads standardised traffic vehicles (see tools/process_vehicle.py for the contract)
 * and prepares them for instanced rendering:
 *  - body primitives become InstancedMeshes shared by every car of that model,
 *  - one wheel geometry is reused for all four wheels (right side = turned 180°),
 *  - the 'paint' material is upgraded to clear-coat and recoloured per instance,
 *  - lamp materials (by name) get emissive light; tail lamps glow per instance when braking.
 */
export async function loadTrafficModels(assets, slugs) {
  const out = [];
  for (const slug of slugs) {
    try {
      const meta = await fetch(`${ASSET_ROOT}models/traffic/${slug}.json`).then((r) => r.json());
      const [lod0, lod1] = await Promise.all([
        assets.gltf(`models/traffic/${slug}.glb`),
        assets.gltf(`models/traffic/${slug}_lod1.glb`),
      ]);
      out.push({ slug, meta, lods: [prepare(lod0.scene, meta, assets, 0), prepare(lod1.scene, meta, assets, 1)] });
    } catch (e) {
      console.error(`traffic model ${slug} failed to load`, e);
    }
  }
  return out;
}

const materialCache = new Map();

/** Unnamed tail lamps: a small, clearly red, untextured part sitting toward the back of the vehicle. */
function looksLikeTailLamp(mesh, material, meta) {
  if (!material.color || material.map) return false;
  const c = material.color;
  if (!(c.r > 0.2 && c.r > 2.2 * c.g && c.r > 2.2 * c.b)) return false;
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  return centre.z > meta.length * 0.25 && size.y < 0.9; // front faces -Z, so the rear is +Z
}

function lampKind(o, meta) {
  const name = o.material.name || '';
  if (name === 'paint') return null;
  if (TAIL_RX.test(name) || looksLikeTailLamp(o, o.material, meta)) return 'tail';
  if (HEAD_RX.test(name)) return 'head';
  if (LAMP_RX.test(name) && !NOT_LAMP_RX.test(name)) return 'lamp';
  return null;
}

function upgradeMaterial(m, assets, kind = null) {
  const key = `${m.uuid}:${kind}`;
  if (materialCache.has(key)) return materialCache.get(key);
  let r = m;
  const name = m.name || '';
  if (name === 'paint') {
    r = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map: m.map ?? null, roughness: 0.33, metalness: 0.25,
      clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.0, name: 'paint',
    });
  } else {
    r = m.clone();
    // KHR_materials_transmission makes three.js re-render the whole opaque scene at full resolution
    // for every camera that sees it (main view and mirror); these lenses are already alpha-blended
    if (r.transmission > 0) r.transmission = 0;
    if (kind === 'tail') {
      r.emissive = new THREE.Color(1, 0.05, 0.03);
      r.emissiveMap = m.map ?? null;
      r.emissiveIntensity = 0.9;
      r.userData.lamp = 'tail';
    } else if (kind === 'lamp') {
      // lens texture decides the colour: clear front lenses glow white, red rear lenses red
      r.emissive = m.map ? new THREE.Color(1, 1, 1) : m.color.clone();
      r.emissiveMap = m.map ?? null;
      r.emissiveIntensity = 0.55;
      r.userData.lamp = 'tail';
    } else if (kind === 'head') {
      r.emissive = new THREE.Color(1, 0.96, 0.88);
      r.emissiveMap = m.map ?? null;
      r.emissiveIntensity = 1.4;
      r.userData.lamp = 'head';
    }
    if (r.isMeshStandardMaterial) r.envMapIntensity = 1.0;
  }
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
    if (r[k]) r[k].anisotropy = Math.min(8, assets.maxAnisotropy);
  }
  if (r.userData.lamp === 'tail') patchBrakeGlow(r);
  materialCache.set(key, r);
  return r;
}

/** Per-instance brake glow: an instanced attribute scales the tail lamps' emissive term. */
function patchBrakeGlow(m) {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBrake;\nattribute float aRear;\nvarying float vBrake;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBrake = aBrake * aRear;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBrake;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float redness = clamp((totalEmissiveRadiance.r - max(totalEmissiveRadiance.g, totalEmissiveRadiance.b)) / max(totalEmissiveRadiance.r, 1e-4) * 1.5, 0.0, 1.0);
        totalEmissiveRadiance *= 1.0 + vBrake * redness * 7.0;`);
  };
  m.customProgramCacheKey = () => 'traffic-brake';
}

const TEX_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap'];
const textured = (m) => TEX_KEYS.some((k) => m[k]);

/**
 * Untextured sub-materials (trim, chrome, plastics, rubber, glass, ...) differ only in
 * colour and a few scalars. They are merged into a handful of vertex-coloured buckets so
 * a model with 25 materials costs ~6 draw calls per pass instead of 25.
 */
function bucketKey(m) {
  if (m.name === 'paint' || m.userData.lamp || textured(m)) return null;
  const q = (v, n) => Math.round((v ?? 0) * n) / n;
  if (m.transparent) return `glass|${q(m.opacity, 4)}|${q(m.roughness, 4)}`;
  return `solid|${q(m.roughness, 4)}|${q(m.metalness, 2)}|${m.side}`;
}

function mergeBucket(key, items) {
  const geoms = items.map(({ geometry, matrix, color, vertexColors }) => {
    let g = geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(matrix);
    if (!g.index) {
      const n = g.attributes.position.count;
      g.setIndex([...Array(n).keys()]);
    }
    let c = vertexColors;
    if (!c) {
      c = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < c.length; i += 3) { c[i] = color.r; c[i + 1] = color.g; c[i + 2] = color.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.morphAttributes = {};
    return g;
  });
  const geometry = mergeGeometries(geoms, false);
  const src = items[0].material;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: src.roughness ?? 0.5, metalness: src.metalness ?? 0,
    transparent: src.transparent, opacity: src.opacity, depthWrite: !src.transparent, side: src.side,
    envMapIntensity: 1.0, name: `merged:${key}`,
  });
  material.forceSinglePass = true;
  return { geometry, material, local: new THREE.Matrix4(), paint: false, tail: false, shadow: !src.transparent };
}

function surfaceArea(geometry, matrix) {
  const p = geometry.attributes.position, idx = geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = idx ? idx.count : p.count;
  let sum = 0;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(matrix);
    b.fromBufferAttribute(p, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(matrix);
    c.fromBufferAttribute(p, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(matrix);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

const pixelCache = new Map();
/** Texture pixels (sRGB bytes) at a modest resolution for per-vertex sampling. */
function texturePixels(tex) {
  if (pixelCache.has(tex)) return pixelCache.get(tex);
  let px = null;
  try {
    const img = tex.image;
    const w = Math.min(256, img.width || 256), h = Math.min(256, img.height || 256);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    px = { w, h, data: ctx.getImageData(0, 0, w, h).data };
  } catch (e) { /* unreadable: fall back to flat colour */ }
  pixelCache.set(tex, px);
  return px;
}

const SRGB = new Float32Array(256).map((_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });

/** Bake a textured part's base colour into linear per-vertex colours (map × colour factor). */
function bakeVertexColors(geometry, material) {
  const uv = geometry.attributes.uv;
  const n = geometry.attributes.position.count;
  const out = new Float32Array(n * 3);
  const px = material.map && uv ? texturePixels(material.map) : null;
  const k = material.color;
  if (!px) {
    for (let i = 0; i < n; i++) out.set([k.r, k.g, k.b], i * 3);
    return out;
  }
  material.map.updateMatrix();
  const m = material.map.matrix, t = new THREE.Vector2();
  for (let i = 0; i < n; i++) {
    t.set(uv.getX(i), uv.getY(i)).applyMatrix3(m);
    const x = ((Math.floor((t.x - Math.floor(t.x)) * px.w) % px.w) + px.w) % px.w;
    const y = ((Math.floor((t.y - Math.floor(t.y)) * px.h) % px.h) + px.h) % px.h;
    const j = (y * px.w + x) * 4;
    out[i * 3] = SRGB[px.data[j]] * k.r;
    out[i * 3 + 1] = SRGB[px.data[j + 1]] * k.g;
    out[i * 3 + 2] = SRGB[px.data[j + 2]] * k.b;
  }
  return out;
}

/**
 * One shared material for far vehicles: every surface of a model is merged into a single
 * geometry carrying colour, roughness/metalness, a paint flag (instance colour applies only
 * to paint), lamp emission and a rear mask (brake glow) as vertex attributes.
 */
let uberMaterial = null;
export function getUberMaterial() {
  if (uberMaterial) return uberMaterial;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, envMapIntensity: 1.0, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aRM;
        attribute vec3 aMisc;   // paint, emission, rear
        attribute float aBrake; // per instance
        varying vec2 vRM;
        varying vec3 vEmit;`)
      .replace('#include <color_vertex>', `
        vColor = vec4(1.0);
        vColor.rgb *= color.rgb;
        // only red lenses brighten when braking (white reverse / amber indicator lamps don't)
        float redness = clamp((color.r - max(color.g, color.b)) * 3.0, 0.0, 1.0);
        vEmit = color.rgb * aMisc.y * (1.0 + aBrake * aMisc.z * redness * 7.0);
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aMisc.x);
        #endif
        vRM = aRM;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRM;\nvarying vec3 vEmit;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRM.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;');
  };
  m.customProgramCacheKey = () => 'traffic-uber';
  uberMaterial = m;
  return m;
}

const EMIT = { tail: 0.9, head: 1.4, lamp: 0.55 };

/**
 * Merge meshes into uber geometries (body / wheel). `accept(o, isWheel)` selects which meshes
 * are merged; the rest are left to the caller.
 */
function prepareUber(root, meta, assets, accept = () => true) {
  root.updateMatrixWorld(true);
  const wheelNode = root.getObjectByName('wheel_fl') ?? root.getObjectByName('wheel_rl');
  const wheelInv = wheelNode ? new THREE.Matrix4().copy(wheelNode.matrixWorld).invert() : new THREE.Matrix4();
  const body = [], wheel = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    let w = o;
    while (w && !/^wheel_/.test(w.name)) w = w.parent;
    if (w && w !== wheelNode) return;
    if (!accept(o, !!w)) return;
    const src = o.material;
    const kind = w ? null : lampKind(o, meta);
    const matrix = w ? new THREE.Matrix4().multiplyMatrices(wheelInv, o.matrixWorld) : o.matrixWorld;
    const g = o.geometry.clone();
    const n = g.attributes.position.count;
    let col = bakeVertexColors(g, src);
    let rough = src.roughness ?? 0.5, metal = src.metalness ?? 0;
    const paint = src.name === 'paint' ? 1 : 0;
    if (paint) { col = new Float32Array(n * 3).fill(1); rough = 0.3; metal = 0.3; } // tinted per instance
    if (src.transparent && !kind) { for (let i = 0; i < col.length; i++) col[i] *= 0.18; rough = 0.06; metal = 0.0; } // glass reads dark + glossy at distance
    const emit = kind ? EMIT[kind] : 0;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(matrix);
    if (!g.index) g.setIndex([...Array(n).keys()]);
    const rm = new Float32Array(n * 2), misc = new Float32Array(n * 3);
    const pos = g.attributes.position;
    for (let i = 0; i < n; i++) {
      rm[i * 2] = rough; rm[i * 2 + 1] = metal;
      misc[i * 3] = paint; misc[i * 3 + 1] = emit; misc[i * 3 + 2] = !w && pos.getZ(i) > meta.length * 0.2 ? 1 : 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRM', new THREE.BufferAttribute(rm, 2));
    g.setAttribute('aMisc', new THREE.BufferAttribute(misc, 3));
    g.morphAttributes = {};
    (w ? wheel : body).push(g);
  });
  const mat = getUberMaterial();
  const parts = body.length ? [{ geometry: mergeGeometries(body, false), material: mat, local: new THREE.Matrix4(), paint: true, tail: false, uber: true, shadow: true }] : [];
  const wheels = wheel.length ? [{ geometry: mergeGeometries(wheel, false), material: mat, local: new THREE.Matrix4(), uber: true }] : [];
  return { parts, wheel: wheels };
}

function prepare(root, meta, assets, lod = 0) {
  if (lod === 1) return prepareUber(root, meta, assets);
  // LOD0: untextured opaque parts (trim, chrome, rubber, untextured lamps) and small textured
  // details share one uber mesh; paint (clear coat), glass and large textured surfaces
  // (liveries, tyre/rim textures, big panels) keep their own materials.
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const area = new Map(meshes.map((o) => [o, surfaceArea(o.geometry, o.matrixWorld)]));
  const total = [...area.values()].reduce((a, b) => a + b, 0);
  const keepOwn = (o) => {
    const m = o.material;
    return m.name === 'paint' || m.transparent || (textured(m) && area.get(o) > total * 0.06);
  };
  const uber = prepareUber(root, meta, assets, (o) => !keepOwn(o));
  const rest = prepareDetailed(root, meta, assets, keepOwn);
  return { parts: [...uber.parts, ...rest.parts], wheel: [...uber.wheel, ...rest.wheel] };
}

function prepareDetailed(root, meta, assets, accept) {
  root.updateMatrixWorld(true);
  // LOD1 (beyond ~40 m): textured opaque parts are baked into per-vertex colours so the whole
  // vehicle merges into a few vertex-coloured buckets (draw calls dominate the cost of traffic).
  const parts = [];
  const wheelParts = [];
  const buckets = new Map();
  const wheelBuckets = new Map();
  const wheelNode = root.getObjectByName('wheel_fl') ?? root.getObjectByName('wheel_rl');
  const wheelInv = wheelNode ? new THREE.Matrix4().copy(wheelNode.matrixWorld).invert() : new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isMesh) return;
    let w = o;
    while (w && !/^wheel_/.test(w.name)) w = w.parent;
    if (!accept(o)) return;
    let material = upgradeMaterial(o.material, assets, w ? null : lampKind(o, meta));
    material.forceSinglePass = true; // transparent double-sided parts would otherwise draw twice
    const key = bucketKey(material);
    const baked = null;
    if (w) {
      if (w !== wheelNode) return; // all four wheels drawn from one geometry
      const local = new THREE.Matrix4().multiplyMatrices(wheelInv, o.matrixWorld);
      if (key) {
        if (!wheelBuckets.has(key)) wheelBuckets.set(key, []);
        wheelBuckets.get(key).push({ geometry: o.geometry, matrix: local, color: material.color, vertexColors: baked, material });
      } else wheelParts.push({ geometry: o.geometry, material, local });
      return;
    }
    if (key) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ geometry: o.geometry, matrix: o.matrixWorld, color: material.color, vertexColors: baked, material });
      return;
    }
    const tail = material.userData.lamp === 'tail';
    let geometry = o.geometry;
    if (tail) {
      // per-vertex rear mask in model space (front faces -Z): only rear lamps react to braking
      geometry = o.geometry.clone();
      const pos = geometry.attributes.position, v = new THREE.Vector3(), rear = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) rear[i] = v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).z > meta.length * 0.2 ? 1 : 0;
      geometry.setAttribute('aRear', new THREE.BufferAttribute(rear, 1));
    }
    parts.push({ geometry, material, local: o.matrixWorld.clone(), paint: material.name === 'paint', tail, shadow: !material.transparent && !material.userData.lamp });
  });
  for (const [k, items] of buckets) parts.push(mergeBucket(k, items));
  for (const [k, items] of wheelBuckets) wheelParts.push(mergeBucket(k, items));
  return { parts, wheel: wheelParts };
}
