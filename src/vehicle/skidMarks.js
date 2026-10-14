import * as THREE from 'three';
import { WHEELS } from './physics.js';

const CAPACITY = 6000;          // quads in the ring buffer (fixed memory, oldest are overwritten)
const LIFETIME = 45;            // seconds until a mark has fully faded
const MIN_STEP = 0.3;           // metres between strip vertices
const HALF_WIDTH = [0.12, 0.12, 0.14, 0.14]; // front tyres are narrower than rears

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _f = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _l = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Rubber marks left on the road by sliding tyres.
 *
 * One dynamic BufferGeometry holds a ring buffer of quads; each wheel extends its own
 * continuous strip while it skids. A quad stores its birth time and strength, and the
 * shader fades it out and breaks up its edges with noise, so nothing is re-uploaded
 * per frame except the newly written quads.
 */
export class SkidMarks {
  constructor(scene, noiseTex) {
    this.time = 0;
    this.head = 0;
    this.count = 0;
    this.strips = WHEELS.map(() => ({ active: false, left: new THREE.Vector3(), right: new THREE.Vector3(), last: new THREE.Vector3(), v: 0, s: 0 }));

    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(CAPACITY * 4 * 3);
    this.data = new Float32Array(CAPACITY * 4 * 4); // across (0/1), along (m), birth (s), strength
    const idx = new Uint32Array(CAPACITY * 6);
    for (let i = 0; i < CAPACITY; i++) {
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aSkid', this.dataAttr);
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(CAPACITY * 4 * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;

    const m = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, roughness: 0.86, metalness: 0, envMapIntensity: 0.25, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12,
    });
    this.uniforms = { uTime: { value: 0 }, uLife: { value: LIFETIME }, uNoise: { value: noiseTex } };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aSkid;\nvarying vec4 vSkid;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkid = aSkid;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime, uLife;\nuniform sampler2D uNoise;\nvarying vec4 vSkid;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float across = vSkid.x, along = vSkid.y;
            float age = uTime - vSkid.z;
            float fade = 1.0 - smoothstep(uLife * 0.55, uLife, age);
            // ragged edges: the usable half-width wobbles along the strip
            float wob = texture2D(uNoise, vec2(along * 0.11, 0.37)).r;
            float e = abs(across - 0.5) * 2.0;
            float edge = 1.0 - smoothstep(0.55 + 0.35 * wob, 1.0, e);
            // tread: faint longitudinal grooves, patchy rubber deposit along the strip
            float tread = 0.78 + 0.22 * smoothstep(0.2, 0.8, abs(sin(across * 3.14159 * 5.0)));
            float deposit = mix(0.55, 1.0, texture2D(uNoise, vec2(along * 0.31, across * 0.6 + 0.5)).g);
            diffuseColor.a = clamp(vSkid.w, 0.0, 1.0) * 0.62 * fade * edge * tread * deposit;
          }`);
    };
    m.customProgramCacheKey = () => 'skidmarks';
    this.material = m;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skid-marks';
    scene.add(this.mesh);
  }

  /** Skid intensity 0..1 for wheel i from tyre saturation, slip and driver inputs. */
  #intensity(vehicle, i) {
    const ctrl = vehicle.ctrl;
    const body = vehicle.body;
    const cp = ctrl.wheelContactPoint(i);
    if (!cp) return 0;
    // velocity of the contact patch
    const lv = body.linvel(), av = body.angvel(), com = body.worldCom();
    _v.set(cp.x - com.x, cp.y - com.y, cp.z - com.z);
    _w.set(av.x, av.y, av.z).cross(_v).add(_n.set(lv.x, lv.y, lv.z));
    // wheel heading: chassis forward yawed by the wheel's steering angle
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _f.set(0, 0, -1).applyAxisAngle(_s.set(0, 1, 0), ctrl.wheelSteering(i) ?? 0).applyQuaternion(_q);
    _s.set(0, 1, 0).applyQuaternion(_q).cross(_f).normalize(); // wheel's lateral axis
    const vLong = _w.dot(_f);
    const vLat = _w.dot(_s);
    const speed = Math.abs(vLong);

    // friction circle saturation (Rapier clamps impulses to suspension force * frictionSlip * dt)
    const susp = ctrl.wheelSuspensionForce(i) ?? 0;
    const fwdImp = ctrl.wheelForwardImpulse(i) ?? 0;
    const sideImp = ctrl.wheelSideImpulse(i) ?? 0;
    const front = vehicle.wheels[i].front;
    const maxImp = susp * vehicle.physics.dt * (front ? vehicle.spec.slipFront : vehicle.spec.slipRear);
    const sat = maxImp > 1 ? Math.hypot(fwdImp, sideImp) / maxImp : 0;

    let k = 0;
    k = Math.max(k, THREE.MathUtils.smoothstep(Math.abs(vLat), 1.4, 4.0));                 // sliding sideways
    k = Math.max(k, THREE.MathUtils.smoothstep(sat, 0.92, 1.0) * THREE.MathUtils.smoothstep(speed, 4, 9) * 0.8);
    // hard braking at speed: only once the pedal is pressed hard, never for a light touch
    if (vehicle.braking && vehicle.speed > 0) {
      k = Math.max(k, THREE.MathUtils.smoothstep(vehicle.brakePressure, 0.8, 1.0) * THREE.MathUtils.smoothstep(speed, 8, 16) * 0.85);
    }
    if (vehicle.handbrake && !front) k = Math.max(k, THREE.MathUtils.smoothstep(speed, 1.2, 6) * 0.95);
    return k;
  }

  update(dt, vehicle) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (vehicle !== this.vehicle) { this.vehicle = vehicle; for (const st of this.strips) st.active = false; } // switched cars
    const ctrl = vehicle.ctrl;
    for (let i = 0; i < 4; i++) {
      const st = this.strips[i];
      const contact = ctrl.wheelIsInContact(i);
      const k = contact ? this.#intensity(vehicle, i) : 0;
      st.s += (k - st.s) * Math.min(1, dt * 12); // smooth onset / release
      if (!contact || st.s < 0.12) { st.active = false; continue; }

      const cp = ctrl.wheelContactPoint(i);
      const cn = ctrl.wheelContactNormal(i) ?? { x: 0, y: 1, z: 0 };
      const p = _v.set(cp.x, cp.y, cp.z).addScaledVector(_n.set(cn.x, cn.y, cn.z), 0.012);
      if (!st.active) {
        this.#edges(vehicle, i, p, st.left, st.right);
        st.last.copy(p);
        st.active = true;
        continue;
      }
      const step = p.distanceTo(st.last);
      if (step < MIN_STEP) continue;
      if (step > 3) { st.active = false; continue; } // teleport / reset guard
      this.#edges(vehicle, i, p, _l, _r, st.last);
      this.#quad(st.left, st.right, _r, _l, st.v, st.v + step, st.s);
      st.v += step;
      st.left.copy(_l); st.right.copy(_r); st.last.copy(p);
    }
  }

  /** Strip edge points at p, perpendicular to the direction of travel (falls back to wheel heading). */
  #edges(vehicle, i, p, outL, outR, prev) {
    if (prev && p.distanceToSquared(prev) > 1e-4) {
      _f.subVectors(p, prev).setY(0).normalize();
    } else {
      const r = vehicle.body.rotation();
      _f.set(0, 0, -1).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).setY(0).normalize();
    }
    _s.set(-_f.z, 0, _f.x).multiplyScalar(HALF_WIDTH[i]);
    outL.copy(p).sub(_s);
    outR.copy(p).add(_s);
  }

  #quad(a0, b0, b1, a1, v0, v1, strength) {
    const slot = this.head;
    this.head = (this.head + 1) % CAPACITY;
    this.count = Math.min(CAPACITY, this.count + 1);
    const pts = [a0, b0, b1, a1];
    const across = [0, 1, 1, 0];
    const along = [v0, v0, v1, v1];
    for (let k = 0; k < 4; k++) {
      this.pos.set([pts[k].x, pts[k].y, pts[k].z], (slot * 4 + k) * 3);
      this.data.set([across[k], along[k], this.time, strength], (slot * 4 + k) * 4);
    }
    // a strip quad wound so its face points up: a0 (left, old) -> b0 (right, old) -> b1 -> a1
    this.posAttr.addUpdateRange(slot * 12, 12);
    this.dataAttr.addUpdateRange(slot * 16, 16);
    this.posAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, this.count * 6);
  }

  clear() {
    this.count = 0;
    this.head = 0;
    this.geometry.setDrawRange(0, 0);
    this.strips.forEach((s) => { s.active = false; });
  }
}
