import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Vehicle camera modes, cycled with C. Third-person modes define distance/height behind
 * the car, a look-at height and an optional lateral framing offset; the driver mode is a
 * first-person head inside the cabin.
 */
const MODES = [
  { name: 'Chase', dist: 6.3, height: 1.85, lookH: 1.05, fov: 52, frame: 0.0 },
  { name: 'Driver', cockpit: true, eye: [-0.355, 1.04, 0.07], pitch: -0.06, fov: 60, near: 0.06 },
  { name: 'Far chase', dist: 9.5, height: 2.7, lookH: 1.2, fov: 55, frame: 0.0 },
  { name: 'Bumper', dist: -0.9, height: 0.95, lookH: 0.95, fov: 68, frame: 0, rigid: true },
  { name: 'Cinematic', dist: 7.5, height: 1.3, lookH: 0.9, fov: 38, frame: 1.4 },
];
const DEFAULT_NEAR = 0.25;
const BLEND_TIME = 0.75;

/** On-foot camera modes (C while walking): orbit distance, height above the shoulder pivot, shoulder offset. */
const FOOT_MODES = [
  { name: 'Third person', dist: 3.2, side: 0.38, fov: 55 },
  { name: 'Over the shoulder', dist: 1.75, side: 0.52, fov: 52 },
  { name: 'Far', dist: 5.6, side: 0.0, fov: 55 },
];

/** Fixed poses for capture mode / reference comparisons. Offsets are in the car's frame. */
export const PRESETS = {
  reference: { orbit: -0.8, pitch: 0.0, dist: 7.4, height: 2.15, lookH: 1.35, fov: 55, frame: 2.5 },
  rear: { orbit: 0, pitch: 0, dist: 6.3, height: 1.85, lookH: 1.05, fov: 52, frame: 0 },
  side: { orbit: 1.4, pitch: 0, dist: 6.5, height: 1.4, lookH: 0.8, fov: 45, frame: 0 },
  front: { orbit: Math.PI - 0.5, pitch: 0, dist: 6.5, height: 1.5, lookH: 0.8, fov: 45, frame: 0 },
  street: { orbit: 0.9, pitch: -0.05, dist: 18, height: 3, lookH: 4, fov: 60, frame: 0 },
  sky: { orbit: 0.0, pitch: -0.5, dist: 20, height: 4, lookH: 30, fov: 70, frame: 0 },
};

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class CameraRig {
  constructor(camera, physics) {
    this.camera = camera;
    this.physics = physics;
    this.modeIndex = 0;
    this.orbit = 0;        // user yaw offset (radians, positive = camera swings toward the car's right side)
    this.pitch = 0;
    this.zoom = 1;
    this.followYaw = null; // smoothed car heading
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.initialized = false;
    this.preset = null;
    this._tmp = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    // pose produced by the active mode this frame
    this.target = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 52, near: DEFAULT_NEAR };
    // blend between modes: the start pose is stored relative to the anchor (car) so a moving
    // car never makes the transition lag behind
    this.blend = null;
    // driver-view head state
    this.head = { off: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, gaze: 0, prevV: null, roll: 0, idle: 0 };
    // what the camera follows: 'vehicle' (MODES) or 'character' (FOOT_MODES)
    this.subject = 'vehicle';
    this.footIndex = 0;
    this.foot = { yaw: 0, pitch: 0.12, zoom: 1, dist: null, pivotY: 1.5 };
  }

  get mode() { return this.subject === 'character' ? FOOT_MODES[this.footIndex] : MODES[this.modeIndex]; }
  get isCockpit() { return this.subject === 'vehicle' && !this.preset && !!this.mode.cockpit; }
  /** Heading the camera looks along (radians, same convention as the car: 0 = -Z). */
  get yaw() {
    if (this.subject === 'character') return this.foot.yaw; // the on-foot rig's own heading (debug cameras don't steer)
    const d = this.camera.getWorldDirection(this._dir);
    return Math.atan2(-d.x, -d.z);
  }

  /**
   * Follow the car or the character. The switch blends from the current view, anchored to the new
   * subject so a moving subject never leaves the camera behind.
   */
  setSubject(subject, anchor, { arc = 0, time = 0.9 } = {}) {
    if (subject === this.subject) return;
    const fromCockpit = this.isCockpit;
    this.subject = subject;
    this.preset = null;
    if (subject === 'character') {
      // keep looking the same way as the previous view (foot.yaw is the camera heading)
      this.foot.yaw = this.yaw;
      this.foot.pitch = 0.12;
      this.foot.dist = null;
    }
    this.initialized = false;
    this.beginBlend(anchor, { arc: fromCockpit ? Math.max(arc, 0.9) : arc, time });
  }

  /** Start a smooth transition from the camera's current pose, expressed relative to `anchor`. */
  beginBlend(anchor, { arc = 0, time = BLEND_TIME } = {}) {
    anchor.updateMatrixWorld();
    const inv = _m.copy(anchor.matrixWorld).invert();
    this.blend = {
      t: 0, time, arc, anchor,
      localPos: this.camera.position.clone().applyMatrix4(inv),
      localQuat: anchor.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(this.camera.quaternion),
      fov: this.camera.fov, near: this.camera.near,
    };
  }

  cycle(car, character) {
    if (this.subject === 'character') {
      this.footIndex = (this.footIndex + 1) % FOOT_MODES.length;
      this.foot.dist = null;
      if (character) this.beginBlend(character.root, { time: 0.5 });
      return this.mode.name;
    }
    const wasCockpit = this.mode.cockpit, wasRigid = this.mode.rigid;
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    // the driver view needs a modelled interior (only the Ferrari has one)
    if (MODES[this.modeIndex].cockpit && car && car.hasCockpit === false) this.modeIndex = (this.modeIndex + 1) % MODES.length;
    this.orbit = 0;
    this.pitch = 0;
    this.head.yaw = this.head.pitch = 0;
    // arc over the (open-top) car when entering or leaving the cabin so the path never cuts the body
    // arc over the car whenever the path would cut through it: into/out of the cabin, or from the
    // bumper (in front) to a view behind
    if (car) this.beginBlend(car.root, { arc: wasCockpit || this.mode.cockpit ? 1.1 : wasRigid || this.mode.rigid ? 0.8 : 0 });
    this.initialized = false;
    return this.mode.name;
  }

  /** Start from the reference composition; the user takes over as soon as they drive or drag. */
  setPreset(p) {
    this.preset = p ? { ...p } : null;
    if (p) { this.orbit = p.orbit; this.pitch = p.pitch; }
    this.initialized = false;
  }

  update(dt, car, vehicle, mouse, onFoot = null) {
    if (this.subject === 'character' && onFoot) this.#onFoot(dt, onFoot, mouse);
    else {
      if (this.mode.cockpit && car.hasCockpit === false) this.modeIndex = 0; // switched to a car without an interior
      const m = this.preset ?? this.mode;
      if (m.cockpit) this.#cockpit(dt, car, vehicle, mouse, m);
      else this.#thirdPerson(dt, car, vehicle, mouse, m);
    }
    this.#apply(dt);
  }

  /**
   * Third-person character camera: mouse orbit and zoom around a shoulder-height pivot that follows
   * the head (lower when kneeling), slight over-the-shoulder offset, and a sphere cast so walls,
   * poles and vehicles never come between the camera and the character.
   */
  #onFoot(dt, F, mouse) {
    const m = FOOT_MODES[this.footIndex];
    const S = this.foot;
    const ch = F.character;
    if (mouse) {
      if (mouse.dx || mouse.dy) {
        S.yaw -= mouse.dx * 0.0032;
        S.pitch = THREE.MathUtils.clamp(S.pitch + mouse.dy * 0.0026, -0.5, 0.95);
      }
      if (mouse.wheel) S.zoom = THREE.MathUtils.clamp(S.zoom * (1 + mouse.wheel * 0.08), 0.55, 1.9);
      // drift behind the character while it moves and the mouse is left alone
      const speed = Math.hypot(F.vel.x, F.vel.z);
      if (mouse.idleMs > 2500 && speed > 1 && F.state === 'move') {
        let d = F.yaw - S.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        S.yaw += d * (1 - Math.exp(-dt * 0.8));
      }
    }
    // pivot: just below the head, so kneeling or landing lowers the camera naturally
    const head = ch.headBone ? ch.headBone.getWorldPosition(_v2) : _v2.copy(F.render).setY(F.render.y + 1.65);
    const pivotY = THREE.MathUtils.clamp(head.y - F.render.y - 0.12, 0.7, 1.62);
    S.pivotY += (pivotY - S.pivotY) * (1 - Math.exp(-dt * 6));
    const pivot = this._tmp.set(F.render.x, F.render.y + S.pivotY, F.render.z);
    const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const back = new THREE.Vector3(Math.sin(S.yaw) * cp, sp, Math.cos(S.yaw) * cp); // pivot → camera
    const right = new THREE.Vector3(Math.cos(S.yaw), 0, -Math.sin(S.yaw));
    const want = m.dist * S.zoom;
    const origin = new THREE.Vector3().copy(pivot).addScaledVector(right, m.side * 0.5);
    const toCam = new THREE.Vector3().copy(back).multiplyScalar(want).addScaledVector(right, m.side * 0.5);
    const len = toCam.length();
    toCam.divideScalar(len);
    const hit = this.physics.sphereCast(origin, toCam, len, 0.22, F.collider);
    const free = hit === null ? len : Math.max(0.35, hit - 0.05);
    if (S.dist === null || !this.initialized) S.dist = free;
    // pull in fast when something is in the way, ease back out slowly
    S.dist += (free - S.dist) * (1 - Math.exp(-dt * (free < S.dist ? 25 : 3)));
    const T = this.target;
    T.pos.copy(origin).addScaledVector(toCam, S.dist);
    T.pos.y = Math.max(T.pos.y, F.render.y + 0.25);
    const look = new THREE.Vector3().copy(pivot).addScaledVector(right, m.side);
    _m.lookAt(T.pos, look, UP);
    T.quat.setFromRotationMatrix(_m);
    T.fov = !this.initialized ? m.fov : T.fov + (m.fov - T.fov) * (1 - Math.exp(-dt * 6));
    T.near = 0.1;
    this.initialized = true;
  }

  /** Blend (if active) from the stored start pose to this frame's target pose, then write the camera. */
  #apply(dt) {
    const T = this.target;
    const cam = this.camera;
    if (this.blend) {
      const b = this.blend;
      b.t = Math.min(1, b.t + dt / b.time);
      const e = smootherstep(b.t);
      b.anchor.updateMatrixWorld();
      const from = _v.copy(b.localPos).applyMatrix4(b.anchor.matrixWorld);
      const fromQ = b.anchor.getWorldQuaternion(_q).multiply(b.localQuat);
      // quadratic Bézier with a raised control point (arc over the car)
      const ctrl = _v2.copy(from).add(T.pos).multiplyScalar(0.5);
      ctrl.y = Math.max(from.y, T.pos.y) + b.arc;
      const u = 1 - e;
      cam.position.set(
        u * u * from.x + 2 * u * e * ctrl.x + e * e * T.pos.x,
        u * u * from.y + 2 * u * e * ctrl.y + e * e * T.pos.y,
        u * u * from.z + 2 * u * e * ctrl.z + e * e * T.pos.z,
      );
      cam.quaternion.slerpQuaternions(fromQ, T.quat, e);
      cam.fov = THREE.MathUtils.lerp(b.fov, T.fov, e);
      cam.near = Math.min(b.near, T.near);
      if (b.t >= 1) { this.blend = null; cam.near = T.near; }
    } else {
      cam.position.copy(T.pos);
      cam.quaternion.copy(T.quat);
      cam.fov = T.fov;
      cam.near = T.near;
    }
    cam.updateProjectionMatrix();
  }

  /** First-person driver's head: rigid to the chassis (so it carries suspension pitch/roll) plus restrained g-force sway. */
  #cockpit(dt, car, vehicle, mouse, m) {
    const H = this.head;
    const root = car.root;
    root.updateMatrixWorld();
    // chassis-local velocity → acceleration
    const lv = vehicle.body.linvel();
    const inv = _q.copy(root.quaternion).invert();
    const vLocal = _v.set(lv.x, lv.y, lv.z).applyQuaternion(inv);
    if (!H.prevV || !this.initialized) H.prevV = vLocal.clone();
    const a = _v2.copy(vLocal).sub(H.prevV).divideScalar(Math.max(dt, 1e-3));
    H.prevV.copy(vLocal);
    // target head offset (m): back under acceleration, forward under braking, outward in corners, damped bumps
    const target = this._tmp.set(
      THREE.MathUtils.clamp(-a.x * 0.0035, -0.03, 0.03),
      THREE.MathUtils.clamp(-a.y * 0.0018, -0.02, 0.02),
      THREE.MathUtils.clamp(-a.z * 0.004, -0.035, 0.035),
    );
    // critically damped spring (ω = 7 rad/s): smooth, no oscillation
    const w = 7;
    const acc = this._dir.copy(target).sub(H.off).multiplyScalar(w * w).addScaledVector(H.vel, -2 * w);
    H.vel.addScaledVector(acc, dt);
    H.off.addScaledVector(H.vel, dt);
    H.roll += (THREE.MathUtils.clamp(a.x * 0.0012, -0.02, 0.02) - H.roll) * Math.min(1, dt * 4);

    // optional mouse look (head turn); recentres when the mouse is idle and the car moves
    if (mouse) {
      if (mouse.dx || mouse.dy) {
        H.yaw = THREE.MathUtils.clamp(H.yaw - mouse.dx * 0.004, -1.9, 1.9);
        H.pitch = THREE.MathUtils.clamp(H.pitch - mouse.dy * 0.003, -0.6, 0.45);
      }
      if (mouse.idleMs > 1500 && Math.abs(vehicle.speed) > 2) {
        const k = 1 - Math.exp(-dt * 2);
        H.yaw *= 1 - k;
        H.pitch *= 1 - k;
      }
    }
    // look slightly into corners, like a real driver
    H.gaze += (vehicle.steer * 0.35 - H.gaze) * Math.min(1, dt * 3);

    const eye = _v.set(m.eye[0], m.eye[1], m.eye[2]).add(H.off);
    this.target.pos.copy(eye).applyMatrix4(root.matrixWorld);
    _e.set(m.pitch + H.pitch, H.yaw + H.gaze, H.roll, 'YXZ');
    this.target.quat.copy(root.quaternion).multiply(_q.setFromEuler(_e));
    this.target.fov = m.fov;
    this.target.near = m.near;
    this.initialized = true;
  }

  #thirdPerson(dt, car, vehicle, mouse, m) {
    const heading = vehicle.heading();
    const speed = vehicle.speed;

    if (mouse) {
      if (mouse.dx || mouse.dy) {
        this.orbit -= mouse.dx * 0.005;
        this.pitch = THREE.MathUtils.clamp(this.pitch + mouse.dy * 0.003, -0.35, 0.6);
      }
      if (mouse.wheel) this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + mouse.wheel * 0.08), 0.6, 2.2);
      // Blend out of the reference preset once the player is driving.
      if (this.preset && Math.abs(speed) > 2) {
        this.preset.frame *= Math.exp(-dt * 1.2);
        this.preset.lookH += (this.mode.lookH - this.preset.lookH) * (1 - Math.exp(-dt * 1.2));
        if (Math.abs(this.preset.frame) < 0.02) this.preset = null;
      }
      // auto-recentre behind the car while driving and not dragging
      if (mouse.idleMs > 1500 && Math.abs(speed) > 3) {
        const k = 1 - Math.exp(-dt * 1.4);
        this.orbit += (0 - this.orbit) * k;
        this.pitch += (0 - this.pitch) * k;
      }
    }

    // Follow heading with lag (looks forward in reverse only after a moment).
    if (this.followYaw === null || !this.initialized) this.followYaw = heading;
    const target = speed < -3 ? heading + Math.PI : heading;
    let d = target - this.followYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.followYaw += d * (1 - Math.exp(-dt * (m.rigid ? 30 : 3.2)));

    const yaw = this.followYaw + this.orbit;
    const carPos = car.root.position;
    const scale = car.camScale ?? 1; // pull back for long vehicles (buses)
    const dist = m.dist * (m.rigid ? 1 : scale * this.zoom) * (1 + Math.min(Math.abs(speed), 40) * 0.006);
    const back = this._dir.set(Math.sin(yaw), 0, Math.cos(yaw)); // unit vector pointing behind the car
    const desired = this._tmp.copy(carPos).addScaledVector(back, dist);
    desired.y = carPos.y + m.height * (0.6 + 0.4 * scale) + this.pitch * dist * 0.9;

    const lookTarget = new THREE.Vector3().copy(carPos);
    lookTarget.y += m.lookH * (0.6 + 0.4 * scale);
    // Framing: shift the look point sideways so the car sits off-centre.
    if (m.frame) {
      const right = new THREE.Vector3().crossVectors(back.clone().negate(), UP).normalize();
      lookTarget.addScaledVector(right, -m.frame);
    }

    // Keep the camera out of buildings: ray from the car toward the desired position.
    if (!m.rigid) {
      const origin = this._tmp2 ?? (this._tmp2 = new THREE.Vector3());
      origin.copy(carPos).add(new THREE.Vector3(0, 1.3, 0));
      const toCam = desired.clone().sub(origin);
      const len = toCam.length();
      toCam.divideScalar(len);
      const hit = this.physics.raycast(origin, toCam, len, vehicle.body);
      if (hit !== null && hit < len) desired.copy(origin).addScaledVector(toCam, Math.max(0.6, hit - 0.35));
      // never end up inside a bus or car of the traffic (passing cars between us and the car are ignored)
      const inVeh = this.physics.insideVehicle(desired, origin, toCam, len, vehicle.body);
      if (inVeh !== null) desired.copy(origin).addScaledVector(toCam, Math.max(0.6, inVeh - 0.3));
      desired.y = Math.max(desired.y, 0.4);
    }

    if (!this.initialized || m.rigid) {
      this.pos.copy(desired);
      this.look.copy(lookTarget);
      this.initialized = true;
    } else {
      const k = 1 - Math.exp(-dt * 9);
      this.pos.lerp(desired, k);
      this.look.lerp(lookTarget, 1 - Math.exp(-dt * 14));
    }

    const T = this.target;
    if (m.rigid) {
      // bumper cam: rigidly attached in the car's frame
      const q = car.root.quaternion;
      const front = (vehicle.length ?? 4.6) / 2 - 0.9; // just behind the front bumper (1.4 m on the Ferrari)
      T.pos.set(0, m.height * (scale > 1.5 ? 2.3 : 1), -front).applyQuaternion(q).add(carPos);
      const f = new THREE.Vector3(0, -0.02, -1).applyQuaternion(q);
      _m.lookAt(T.pos, f.add(T.pos), UP);
    } else {
      T.pos.copy(this.pos);
      _m.lookAt(T.pos, this.look, UP);
    }
    T.quat.setFromRotationMatrix(_m);
    // fov eases toward the mode's value (zoom/blend continuity)
    T.fov = T.fov === undefined || !this.initialized ? m.fov : T.fov + (m.fov - T.fov) * (1 - Math.exp(-dt * 6));
    T.near = DEFAULT_NEAR;
  }
}
