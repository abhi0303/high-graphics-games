import * as THREE from 'three';

const V = () => new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// Ferrari 458 driver's seat (car-local metres), measured from the seat, footwell and wheel meshes.
export const SEAT = {
  hip: new THREE.Vector3(-0.355, 0.43, 0.02),       // hip-joint centre above the cushion's low point
  pedalL: new THREE.Vector3(-0.47, 0.29, -0.84),    // left foot on the rest
  pedalR: new THREE.Vector3(-0.26, 0.29, -0.86),    // right foot on the throttle
  lean: THREE.MathUtils.degToRad(17),               // backrest recline beyond the chair pose
};
const GRIP_LIMIT = 0.55; // rad: hands follow the rim this far, then the rim slides through them (push-pull)
const IK_BONES = ['Bip01_Spine', 'Bip01_Spine2', 'Bip01_Head',
  ...['L', 'R'].flatMap((s) => [`Bip01_${s}_Thigh`, `Bip01_${s}_Calf`, `Bip01_${s}_Foot`, `Bip01_${s}_UpperArm`, `Bip01_${s}_Forearm`, `Bip01_${s}_Hand`])];

/** Rotate a bone by a world-space rotation about its own origin (keeps children attached). */
function rotateWorld(bone, q) {
  const parentQ = bone.parent.getWorldQuaternion(_q1);
  const world = _q2.copy(parentQ).multiply(bone.quaternion);
  world.premultiply(q);
  bone.quaternion.copy(parentQ.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/** Set a bone's world orientation (children follow). */
function setWorldQuaternion(bone, q) {
  const parentQ = bone.parent.getWorldQuaternion(_q1);
  bone.quaternion.copy(parentQ.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

/** Analytic two-bone IK: place `end` at `target`, bending toward `pole` (all world space). */
export function solveTwoBone(upper, lower, end, target, pole) {
  const A = upper.getWorldPosition(V()), B = lower.getWorldPosition(V()), C = end.getWorldPosition(V());
  const lab = A.distanceTo(B), lbc = B.distanceTo(C);
  const toT = V().subVectors(target, A);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(lab - lbc) + 1e-4, lab + lbc - 1e-4);
  const dir = toT.normalize();
  const cosA = THREE.MathUtils.clamp((lab * lab + d * d - lbc * lbc) / (2 * lab * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const toP = V().subVectors(pole, A);
  const u = toP.addScaledVector(dir, -toP.dot(dir)).normalize();
  const Bt = V().copy(A).addScaledVector(dir, lab * cosA).addScaledVector(u, lab * sinA);
  rotateWorld(upper, new THREE.Quaternion().setFromUnitVectors(B.sub(A).normalize(), V().subVectors(Bt, A).normalize()));
  const B2 = lower.getWorldPosition(V()), C2 = end.getWorldPosition(V());
  const Ct = V().copy(A).addScaledVector(dir, d);
  rotateWorld(lower, new THREE.Quaternion().setFromUnitVectors(C2.sub(B2).normalize(), Ct.sub(B2).normalize()));
}

/**
 * The character in the driver's seat: the 'drive' clip (seated idle, gripping fingers) plus
 * procedural fitting to this car — pelvis on the seat's H-point, recline, feet on the pedals and
 * hands on the steering-wheel rim (two-bone IK) following the wheel as it turns.
 */
export class Driver {
  constructor(character, car) {
    this.character = character;
    this.car = car;
    this.b = character.bones;
    this.#measureWheel();
    this.#measureHands();
  }

  /** Steering-wheel rim (wheel-local frame): centre, axis, 12 o'clock direction and rim radius. */
  #measureWheel() {
    const sw = this.car.steeringWheel;
    const rim = this.car.model.getObjectByName('steering_leather');
    const mesh = rim.isMesh ? rim : rim.children.find((c) => c.isMesh);
    sw.updateMatrixWorld(true);
    const toWheel = _m.copy(sw.matrixWorld).invert().multiply(mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position, v = V();
    // the wheel spins about its local Y (see Car.sync); rim = the outermost ring around that axis
    let maxR = 0;
    const pts = [];
    for (let i = 0; i < pos.count; i += 2) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toWheel);
      const r = Math.hypot(v.x, v.z);
      pts.push([r, v.y]);
      maxR = Math.max(maxR, r);
    }
    const ring = pts.filter((p) => p[0] > maxR - 0.03);
    this.wheel = {
      radius: maxR - 0.014,                                   // centre of the rim tube
      y: ring.reduce((a, p) => a + p[1], 0) / ring.length,    // rim plane offset along the axis
    };
    // 12 o'clock in wheel-local coordinates (car up projected onto the wheel plane, at rest)
    const upCar = V().set(0, 1, 0);
    const qWheelInCar = this.car.root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(sw.getWorldQuaternion(new THREE.Quaternion()));
    const upLocal = upCar.applyQuaternion(qWheelInCar.clone().invert());
    upLocal.y = 0;
    this.wheel.up = upLocal.normalize();
    this.wheel.right = V().crossVectors(this.wheel.up, V().set(0, 1, 0)).normalize(); // toward 3 o'clock
    // make sure 'right' is the driver's right (car +X)
    const rCar = this.wheel.right.clone().applyQuaternion(qWheelInCar);
    if (rCar.x < 0) this.wheel.right.negate();
  }

  /** Hand-local axes: wrist→knuckles and palm normal (toward the curled fingertips). */
  #measureHands() {
    const C = this.character;
    // pose the drive clip once so the fingers are curled
    for (const k of Object.keys(C.actions)) C.actions[k].setEffectiveWeight(k === 'drive' ? 1 : 0);
    C.mixer.update(0);
    C.root.updateMatrixWorld(true);
    this.hands = {};
    for (const s of ['L', 'R']) {
      const hand = this.b[`Bip01_${s}_Hand`];
      const inv = hand.matrixWorld.clone().invert();
      const loc = (n) => this.b[n].getWorldPosition(V()).applyMatrix4(inv);
      const k = loc(`Bip01_${s}_Finger2`).normalize();
      const across = loc(`Bip01_${s}_Finger1`).sub(loc(`Bip01_${s}_Finger4`)).normalize();
      let n = V().crossVectors(k, across).normalize();
      const tips = loc(`Bip01_${s}_Finger22`).sub(loc(`Bip01_${s}_Finger2`));
      if (tips.dot(n) < 0) n.negate();
      // grip point: the middle of the palm, a little in from the knuckles
      const grip = loc(`Bip01_${s}_Finger2`).multiplyScalar(0.55).addScaledVector(n, 0.035 / hand.getWorldScale(V()).x);
      this.hands[s] = { k, n, grip };
    }
    for (const k of Object.keys(C.actions)) C.actions[k].setEffectiveWeight(0);
  }

  /** World position of the rim at clock angle `a` (0 = 12 o'clock, +π/2 = 3 o'clock) for a wheel turned by `turn`. */
  #rim(a, turn, out) {
    const W = this.wheel, sw = this.car.steeringWheel;
    // grips sit at the base frame rotated by the (clamped) wheel turn; car.sync rotates the wheel by -steer*4
    const ang = a - turn;
    out.copy(W.up).multiplyScalar(Math.cos(ang) * W.radius).addScaledVector(W.right, Math.sin(ang) * W.radius);
    out.y = W.y;
    // wheel-local at the *rest* orientation → world
    return out.applyMatrix4(this.#wheelRest());
  }

  /** World matrix of the steering wheel in its rest (straight-ahead) orientation. */
  #wheelRest() {
    const sw = this.car.steeringWheel;
    return _m.compose(sw.position, this.car.steeringBase, sw.scale).premultiply(sw.parent.matrixWorld);
  }

  /**
   * Fit the seated pose to the car. Call after Character.update(). `steer` is the vehicle's steer
   * angle (the wheel is turned by steer * 4). `firstPerson` hides the head (the camera is the eyes).
   */
  apply(steer, { firstPerson = false, weight = 1, yaw = 0, place = null, ik = 1 } = {}) {
    const C = this.character, car = this.car, b = this.b;
    car.root.updateMatrixWorld(true);
    // 1) seat: put the hip centre on the H-point. `yaw` turns the body relative to the car (legs
    //    swinging in/out of the door); `place` is the caller's root position that `weight` blends from.
    C.root.quaternion.copy(car.root.quaternion).multiply(_q1.setFromAxisAngle(V().set(0, 1, 0), yaw));
    C.root.position.copy(place ?? car.root.position);
    C.root.updateMatrixWorld(true);
    const hips = b.Bip01_L_Thigh.getWorldPosition(V()).add(b.Bip01_R_Thigh.getWorldPosition(V())).multiplyScalar(0.5);
    const want = car.root.localToWorld(SEAT.hip.clone());
    C.root.position.add(want.sub(hips).multiplyScalar(place ? weight : 1));
    C.root.updateMatrixWorld(true);
    C.headScale = firstPerson ? 0.001 : 1;
    b.Bip01_Head.scale.setScalar(C.headScale);
    if (ik <= 0.001) { b.Bip01_Head.updateMatrixWorld(true); return; } // enter/exit: placement only
    // remember the clip pose so the fitted pose can be blended in/out (hands onto the wheel, ...)
    const fk = IK_BONES.map((n) => b[n].quaternion.clone());
    const q = car.root.quaternion;
    const right = V().set(1, 0, 0).applyQuaternion(q), up = V().set(0, 1, 0).applyQuaternion(q), fwd = V().set(0, 0, -1).applyQuaternion(q);

    // 2) recline into the backrest (spine), then look down the road (neck/head)
    rotateWorld(b.Bip01_Spine, new THREE.Quaternion().setFromAxisAngle(right, SEAT.lean * 0.7));
    rotateWorld(b.Bip01_Spine2, new THREE.Quaternion().setFromAxisAngle(right, SEAT.lean * 0.3));
    const headQ = this.#lookQuaternion(b.Bip01_Head, fwd, up, steer);
    setWorldQuaternion(b.Bip01_Head, b.Bip01_Head.getWorldQuaternion(new THREE.Quaternion()).slerp(headQ, 0.85));

    // 3) legs: feet on the pedals, knees up
    for (const s of ['L', 'R']) {
      const thigh = b[`Bip01_${s}_Thigh`], calf = b[`Bip01_${s}_Calf`], foot = b[`Bip01_${s}_Foot`];
      const target = car.root.localToWorld((s === 'L' ? SEAT.pedalL : SEAT.pedalR).clone());
      const pole = thigh.getWorldPosition(V()).addScaledVector(up, 1).addScaledVector(fwd, 0.8).addScaledVector(right, s === 'L' ? -0.25 : 0.25);
      solveTwoBone(thigh, calf, foot, target, pole);
      this.#alignFoot(foot, fwd, up); // sole on the pedal: toes forward and slightly up
    }

    // 4) arms: hands on the rim at a quarter to three, following the wheel up to the slip limit
    const turn = THREE.MathUtils.clamp(-steer * 4, -GRIP_LIMIT, GRIP_LIMIT);
    for (const s of ['L', 'R']) {
      const a = s === 'L' ? -Math.PI * 0.42 : Math.PI * 0.42;
      const grip = this.#rim(a, turn, V());
      const upper = b[`Bip01_${s}_UpperArm`], fore = b[`Bip01_${s}_Forearm`], hand = b[`Bip01_${s}_Hand`];
      const shoulder = upper.getWorldPosition(V());
      const pole = shoulder.clone().addScaledVector(up, -1).addScaledVector(right, s === 'L' ? -0.7 : 0.7).addScaledVector(fwd, -0.2);
      // the wrist sits behind the grip point by the hand's grip offset; iterate twice (orientation moves it)
      let wrist = grip.clone();
      for (let it = 0; it < 2; it++) {
        solveTwoBone(upper, fore, hand, wrist, pole);
        this.#orientHand(s, hand, grip);
        const g = this.hands[s].grip.clone().applyMatrix4(hand.matrixWorld);
        wrist.add(grip.clone().sub(g));
      }
    }

    if (ik < 0.999) {
      IK_BONES.forEach((n, i) => { const bone = b[n]; bone.quaternion.copy(fk[i].slerp(bone.quaternion, ik)); });
      C.root.updateMatrixWorld(true);
    }
  }

  /** Head orientation looking down the road, turned a little into the corner. */
  #lookQuaternion(head, fwd, up, steer) {
    const look = fwd.clone().applyAxisAngle(up, steer * 0.6).addScaledVector(up, -0.08).normalize();
    const cur = head.getWorldQuaternion(new THREE.Quaternion());
    // the head's local forward/up, taken from the seated clip (which looks ahead) on first use
    if (!this.headFwd) {
      const inv = cur.clone().invert();
      this.headFwd = fwd.clone().applyQuaternion(inv).normalize();
      this.headUp = up.clone().applyQuaternion(inv).normalize();
    }
    const m1 = new THREE.Matrix4().makeBasis(this.headFwd, this.headUp, V().crossVectors(this.headFwd, this.headUp));
    const lookUp = up.clone().addScaledVector(look, -up.dot(look)).normalize();
    const m2 = new THREE.Matrix4().makeBasis(look, lookUp, V().crossVectors(look, lookUp));
    return new THREE.Quaternion().setFromRotationMatrix(m2.multiply(m1.invert()));
  }

  #alignFoot(foot, fwd, up) {
    // keep the ankle where IK put it; point the foot forward with the sole tilted onto the pedal
    if (!this.footFwdL) {
      const toe = this.b.Bip01_L_Toe0.getWorldPosition(V()).sub(this.b.Bip01_L_Foot.getWorldPosition(V())).normalize();
      this.footFwdL = toe.applyQuaternion(this.b.Bip01_L_Foot.getWorldQuaternion(new THREE.Quaternion()).invert());
      const toeR = this.b.Bip01_R_Toe0.getWorldPosition(V()).sub(this.b.Bip01_R_Foot.getWorldPosition(V())).normalize();
      this.footFwdR = toeR.applyQuaternion(this.b.Bip01_R_Foot.getWorldQuaternion(new THREE.Quaternion()).invert());
    }
    const local = foot === this.b.Bip01_L_Foot ? this.footFwdL : this.footFwdR;
    const cur = local.clone().applyQuaternion(foot.getWorldQuaternion(new THREE.Quaternion()));
    const want = fwd.clone().addScaledVector(up, 0.45).normalize();
    rotateWorld(foot, new THREE.Quaternion().setFromUnitVectors(cur, want));
  }

  /** Wrist→knuckles along the rim toward the dash, palm wrapped onto the rim. */
  #orientHand(s, hand, grip) {
    const sw = this.car.steeringWheel;
    const axis = V().set(0, 1, 0).applyQuaternion(sw.getWorldQuaternion(new THREE.Quaternion())); // toward the dash
    const centre = V().set(0, this.wheel.y, 0).applyMatrix4(this.#wheelRest());
    const radial = V().subVectors(grip, centre).normalize();         // centre → grip
    const tangentUp = V().crossVectors(axis, radial).normalize();    // along the rim
    if (tangentUp.dot(V().set(0, 1, 0).applyQuaternion(this.car.root.quaternion)) < 0) tangentUp.negate();
    const K = V().copy(axis).multiplyScalar(0.55).addScaledVector(tangentUp, 0.5).addScaledVector(radial, 0.35).normalize();
    let N = V().copy(radial).multiplyScalar(-1).addScaledVector(axis, -0.2);
    N.addScaledVector(K, -N.dot(K)).normalize();
    const H = this.hands[s];
    const ml = new THREE.Matrix4().makeBasis(H.k, H.n, V().crossVectors(H.k, H.n));
    const mw = new THREE.Matrix4().makeBasis(K, N, V().crossVectors(K, N));
    setWorldQuaternion(hand, new THREE.Quaternion().setFromRotationMatrix(mw.multiply(ml.invert())));
  }
}
