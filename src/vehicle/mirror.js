import * as THREE from 'three';
import { PROBE_LAYER } from './reflectionProbe.js';

/** Extra layer for things the mirror shows beyond the reflection-probe set (traffic, the car itself). */
export const MIRROR_LAYER = 2;
const HIDDEN_PARTS = /^(wheel|rim|tire|brake|nuts|centre|steering|lights|leds|grills|wipers|yellow_trim|blue)/;

const _pe = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _pc = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Interior rear-view mirror for the driver view. The scene is rendered at low resolution from the
 * viewer's eye reflected in the mirror plane, through an off-axis (generalised perspective)
 * frustum fitted exactly to the glass, so the image lines up with the glass as a real mirror would.
 * The glass is the model's own mirror surface (chrome triangles facing the driver), re-used with
 * planar UVs. It only renders while the camera is close to it (driver view), at a reduced rate and
 * with the reflection-probe object set (buildings, roads, signals, sky) plus traffic and the car.
 */
export class RearViewMirror {
  constructor(car, renderer, scene, { width = 384, every = 4 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.car = car;
    this.every = every;
    this.frame = 0;
    this.active = false;
    if (!this.#buildGlass(car, width)) return;
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.camera.layers.set(PROBE_LAYER);
    this.camera.layers.enable(MIRROR_LAYER);
    // the player car as seen looking back through the cabin: skip wheels, brakes, lamps and the wheel
    car.root.traverse((o) => { if (!o.isMesh || !HIDDEN_PARTS.test(o.name)) o.layers.enable(MIRROR_LAYER); });
  }

  /** Make an object tree visible in the mirror. */
  static include(object) {
    object.traverse((o) => o.layers.enable(MIRROR_LAYER));
  }

  #buildGlass(car, width) {
    const mesh = car.model.getObjectByName('chrome');
    const src = mesh && (mesh.isMesh ? mesh : mesh.children.find((c) => c.isMesh));
    if (!src) return false;
    car.root.updateMatrixWorld(true);
    const toCar = new THREE.Matrix4().copy(car.root.matrixWorld).invert().multiply(src.matrixWorld);
    const geo = src.geometry, pos = geo.attributes.position, index = geo.index;
    const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
    const verts = [], normal = new THREE.Vector3();
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < 3; k++) tri[k].fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(toCar);
      // centre console mirror: above the dash, in front of the driver, facing back into the cabin
      const cx = (tri[0].x + tri[1].x + tri[2].x) / 3, cy = (tri[0].y + tri[1].y + tri[2].y) / 3, cz = (tri[0].z + tri[1].z + tri[2].z) / 3;
      if (Math.abs(cx) > 0.3 || cy < 0.95 || cy > 1.3 || cz < -0.9 || cz > 0.2) continue;
      fn.crossVectors(e1.subVectors(tri[1], tri[0]), e2.subVectors(tri[2], tri[0]));
      const area = fn.length();
      if (area < 1e-10) continue;
      fn.divideScalar(area);
      if (fn.z < 0.75) continue;
      normal.addScaledVector(fn, area);
      for (const t of tri) verts.push(t.x, t.y, t.z);
    }
    if (verts.length < 9) return false;
    // glass plane basis: n towards the viewer, r to the viewer's right (car +X), u up
    normal.normalize();
    const r = new THREE.Vector3(1, 0, 0).addScaledVector(normal, -normal.x).normalize();
    const u = new THREE.Vector3().crossVectors(normal, r);
    const centre = new THREE.Vector3();
    for (let i = 0; i < verts.length; i += 3) centre.x += verts[i], centre.y += verts[i + 1], centre.z += verts[i + 2];
    centre.divideScalar(verts.length / 3);
    let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
    const p = new THREE.Vector3(), st = [];
    for (let i = 0; i < verts.length; i += 3) {
      p.set(verts[i], verts[i + 1], verts[i + 2]).sub(centre);
      const s = p.dot(r), t = p.dot(u);
      st.push(s, t);
      smin = Math.min(smin, s); smax = Math.max(smax, s); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
    }
    // UVs: the render is seen from behind the glass, so it is mirrored horizontally
    const uv = new Float32Array((verts.length / 3) * 2);
    for (let i = 0; i < st.length; i += 2) {
      uv[i] = 1 - (st[i] - smin) / (smax - smin);
      uv[i + 1] = (st[i + 1] - tmin) / (tmax - tmin);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.translate(normal.x * 0.0008, normal.y * 0.0008, normal.z * 0.0008);
    out.computeVertexNormals();

    const aspect = (smax - smin) / (tmax - tmin);
    this.target = new THREE.WebGLRenderTarget(width, Math.max(16, Math.round(width / aspect)), { type: THREE.HalfFloatType, samples: 2 });
    this.target.texture.generateMipmaps = false;
    // silvered glass reflects ~85%, slightly cool
    this.glass = new THREE.Mesh(out, new THREE.MeshBasicMaterial({ map: this.target.texture, color: new THREE.Color(0.82, 0.84, 0.86) }));
    this.glass.name = 'rear-view-mirror';
    this.glass.visible = false;
    this.glass.castShadow = this.glass.receiveShadow = false;
    car.root.add(this.glass);
    // local-frame rectangle (corners as seen by the viewer) and plane
    this.local = {
      centre, normal, r, u,
      ll: centre.clone().addScaledVector(r, smin).addScaledVector(u, tmin),
      lr: centre.clone().addScaledVector(r, smax).addScaledVector(u, tmin),
      ul: centre.clone().addScaledVector(r, smin).addScaledVector(u, tmax),
    };
    return true;
  }

  /**
   * Render the mirror if the viewer is close to it (driver view). `busy` = another offscreen pass
   * (the reflection probe) already ran this frame: the mirror then waits a frame, so the two never
   * stack up into one long frame.
   */
  update(viewer, busy = false) {
    if (!this.glass) return;
    const L = this.local, root = this.car.root;
    root.updateMatrixWorld();
    const centreW = _pa.copy(L.centre).applyMatrix4(root.matrixWorld);
    const near = viewer.position.distanceTo(centreW) < 1.6;
    this.glass.visible = near;
    if (!near) { this.active = false; return; }
    if (this.active && (busy || ++this.frame < this.every)) return;
    this.frame = 0;
    this.active = true;

    // world-frame plane, then reflect the eye through it
    _n.copy(L.normal).transformDirection(root.matrixWorld);
    _pe.copy(viewer.position);
    const dist = _pe.clone().sub(centreW).dot(_n);
    if (dist <= 0.01) return; // behind the glass
    _pe.addScaledVector(_n, -2 * dist);
    // seen from the reflected eye the rectangle is flipped: right = -r, normal = -n (towards the eye)
    _pa.copy(L.lr).applyMatrix4(root.matrixWorld);
    _pb.copy(L.ll).applyMatrix4(root.matrixWorld);
    _pc.copy(L.ul).applyMatrix4(root.matrixWorld).add(_pa).sub(_pb); // upper corner above pa
    const vr = _r.subVectors(_pb, _pa).normalize();
    const vu = _u.subVectors(_pc, _pa).normalize();
    const vn = new THREE.Vector3().crossVectors(vr, vu).normalize();
    const va = _pa.sub(_pe), vb = _pb.sub(_pe), vc = _pc.sub(_pe);
    const d = -va.dot(vn);
    // near plane just past the glass, so the mirror's own housing and silvering are never rendered
    const n = d + 0.012, f = 800;
    const l = (vr.dot(va) * n) / d, rr = (vr.dot(vb) * n) / d, b = (vu.dot(va) * n) / d, t = (vu.dot(vc) * n) / d;
    const cam = this.camera;
    cam.projectionMatrix.makePerspective(l, rr, t, b, n, f);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.matrix.copy(_m.makeBasis(vr, vu, vn).setPosition(_pe));
    cam.matrixWorld.copy(cam.matrix);
    cam.matrixWorldInverse.copy(cam.matrix).invert();
    cam.near = n; cam.far = f;

    const R = this.renderer;
    const prevTarget = R.getRenderTarget();
    const autoShadow = R.shadowMap.autoUpdate;
    R.shadowMap.autoUpdate = false;
    this.glass.visible = false;
    this.beforeRender?.();
    R.setRenderTarget(this.target);
    R.clear();
    R.render(this.scene, cam);
    R.setRenderTarget(prevTarget);
    this.afterRender?.();
    this.glass.visible = true;
    R.shadowMap.autoUpdate = autoShadow;
  }
}
