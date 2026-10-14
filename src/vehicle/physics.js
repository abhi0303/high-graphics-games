import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/** Thin wrapper around a Rapier world with helpers for static city geometry. */
export class Physics {
  static async create(hz) {
    await RAPIER.init();
    return new Physics(hz);
  }

  constructor(hz) {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / hz;
    this.dt = 1 / hz;
    this.ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // ground plane y = 0: an exact half-space (an 8 km box loses precision in shape casts, which made
    // the character controller sink into it)
    this.world.createCollider(new RAPIER.ColliderDesc(new RAPIER.HalfSpace({ x: 0, y: 1, z: 0 })).setFriction(1), this.ground);
  }

  box(cx, cy, cz, hx, hy, hz, rotY = 0, friction = 0.6) {
    const d = this.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setFriction(friction);
    if (rotY) d.setRotation(quatY(rotY));
    return this.world.createCollider(d, this.ground);
  }

  cylinder(cx, cz, radius, height, y0 = 0) {
    const d = this.R.ColliderDesc.cylinder(height / 2, radius).setTranslation(cx, y0 + height / 2, cz).setFriction(0.5);
    return this.world.createCollider(d, this.ground);
  }

  trimesh(geometry) {
    const g = geometry.index ? geometry : geometry.clone();
    const pos = g.attributes.position.array;
    const verts = pos instanceof Float32Array ? pos : new Float32Array(pos);
    const idx = g.index ? new Uint32Array(g.index.array) : new Uint32Array([...Array(verts.length / 3).keys()]);
    const d = this.R.ColliderDesc.trimesh(verts, idx).setFriction(0.9);
    return this.world.createCollider(d, this.ground);
  }

  /**
   * If `point` lies inside a moving (kinematic) vehicle, return the ray distance from
   * `origin` along `dir` at which that vehicle is entered; otherwise null.
   */
  insideVehicle(point, origin, dir, maxToi, excludeBody) {
    let inside = false;
    this.world.intersectionsWithPoint(point, () => { inside = true; return false; }, this.R.QueryFilterFlags.ONLY_KINEMATIC);
    if (!inside) return null;
    const hit = this.world.castRay(new this.R.Ray(origin, dir), maxToi, true, this.R.QueryFilterFlags.ONLY_KINEMATIC, undefined, undefined, excludeBody);
    return hit ? hit.timeOfImpact : null;
  }

  /** Cast a ray against static (fixed) geometry only. Returns hit distance or null. */
  raycast(origin, dir, maxToi, excludeBody) {
    const ray = new this.R.Ray(origin, dir);
    const flags = this.R.QueryFilterFlags.EXCLUDE_KINEMATIC | this.R.QueryFilterFlags.EXCLUDE_DYNAMIC;
    const hit = this.world.castRay(ray, maxToi, true, flags, undefined, undefined, excludeBody);
    return hit ? hit.timeOfImpact : null;
  }

  /**
   * Sweep a sphere from `origin` along unit `dir` against everything (static, vehicles) except
   * `excludeCollider` and sensors. Returns the travel distance at first contact or null.
   */
  sphereCast(origin, dir, maxToi, radius, excludeCollider) {
    this._ball ??= new this.R.Ball(radius);
    if (this._ball.radius !== radius) this._ball = new this.R.Ball(radius);
    const hit = this.world.castShape(origin, { x: 0, y: 0, z: 0, w: 1 }, dir, this._ball, 0, maxToi, true,
      this.R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, excludeCollider);
    return hit ? hit.time_of_impact ?? hit.toi ?? hit.timeOfImpact : null;
  }

  step() {
    this.world.step();
  }
}

function quatY(a) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** Wheel layout of the Ferrari model (metres, car faces -Z, origin on the ground). */
export const WHEELS = [
  { name: 'wheel_fl', x: -0.836, z: -1.155, front: true },
  { name: 'wheel_fr', x: 0.836, z: -1.155, front: true },
  { name: 'wheel_rl', x: -0.822, z: 1.496, front: false },
  { name: 'wheel_rr', x: 0.822, z: 1.496, front: false },
];
export const WHEEL_RADIUS = 0.36;
const SUSPENSION_REST = 0.16;
const CONNECTION_Y = WHEEL_RADIUS + SUSPENSION_REST - 0.04;

/** The player's Ferrari (tuned by hand; the default spec). */
export const FERRARI_SPEC = {
  name: 'ferrari', mass: 1450, length: 4.6, width: 2.0,
  com: { x: 0, y: 0.32, z: 0.12 }, inertia: { x: 2600, y: 2900, z: 650 },
  wheels: WHEELS.map((w) => ({ x: w.x, y: CONNECTION_Y, z: w.z, front: w.front })),
  wheelRadius: WHEEL_RADIUS, suspensionRest: SUSPENSION_REST, stiffness: 42, maxSuspensionForce: 60000,
  slipFront: 2.3, slipRear: 2.45, power: 360000, maxDrive: 10500, reverse: 4200, brake: 13000, handbrake: 9000,
  maxSteer: 0.58, drag: 0.42, downforce: 1.6,
  shapes: [
    { half: [0.9, 0.2, 2.12], round: 0.08, at: [0, 0.56, 0.05] },  // lower tub
    { half: [0.68, 0.16, 0.95], round: 0.06, at: [0, 0.96, 0.15] }, // cabin
  ],
};

/**
 * Physics spec for a traffic model from its metadata (dimensions, wheel centres, category): mass,
 * power and brakes by category; suspension force scaled with mass; body shapes from the
 * bounding box (a lower body plus a narrower cabin).
 */
export function specFromMeta(meta) {
  const cat = meta.category;
  const mass = { bus: 11000, van: 2300, suv: 2150, pickup: 2200, hatchback: 1350, taxi: 1750 }[cat] ?? 1650;
  const L = meta.length, W = Math.min(meta.width, cat === 'bus' ? 2.6 : 2.05), H = meta.height;
  const r = meta.wheelRadius || 0.34;
  const rest = cat === 'bus' ? 0.2 : 0.17;
  const wheels = ['fl', 'fr', 'rl', 'rr'].map((k) => {
    const c = meta.wheels[k];
    return { x: c[0], y: c[1] + rest - 0.04, z: c[2], front: k[0] === 'f' };
  });
  const k = mass / 1450;
  const clear = cat === 'bus' ? 0.35 : 0.24;
  const lowH = Math.min(0.55, (H - clear) * 0.45);
  return {
    name: meta.slug, mass, length: L, width: W,
    com: { x: 0, y: H * 0.3, z: 0 },
    inertia: { x: mass * (H * H + L * L) / 12, y: mass * (W * W + L * L) / 12, z: mass * (W * W + H * H) / 12 },
    wheels, wheelRadius: r, suspensionRest: rest, stiffness: 38, maxSuspensionForce: 60000 * k,
    slipFront: cat === 'bus' ? 1.9 : 2.1, slipRear: cat === 'bus' ? 2.0 : 2.2,
    power: { bus: 230000, van: 150000, suv: 230000, hatchback: 160000 }[cat] ?? 200000,
    maxDrive: mass * (cat === 'bus' ? 2.2 : 5.5), reverse: mass * 2.6, brake: 13000 * k, handbrake: 9000 * k,
    maxSteer: cat === 'bus' ? 0.5 : 0.56, drag: cat === 'bus' ? 1.1 : 0.5, downforce: 0.4,
    shapes: [
      { half: [W / 2 * 0.95, lowH / 2, L / 2 * 0.96], round: 0.06, at: [0, clear + lowH / 2, 0] },
      { half: [W / 2 * 0.86, (H - clear - lowH) / 2 * 0.95, L / 2 * (cat === 'bus' || cat === 'van' ? 0.93 : 0.62)], round: 0.06, at: [0, clear + lowH + (H - clear - lowH) / 2 * 0.95, cat === 'bus' || cat === 'van' ? 0 : L * 0.05] },
    ],
  };
}

/**
 * Ray-cast vehicle (Rapier's DynamicRayCastVehicleController) with an arcade-
 * leaning but inertia-respecting drivetrain: power-limited engine force, brake
 * bias, speed-sensitive steering, handbrake that unloads rear grip, aero drag
 * and a little downforce for stability.
 */
export class Vehicle {
  /** `start`: { x, z, heading, y? }; `spec`: FERRARI_SPEC (default) or specFromMeta(meta). */
  constructor(physics, start, spec = FERRARI_SPEC) {
    const R = physics.R;
    this.physics = physics;
    this.spec = spec;
    this.mass = spec.mass;
    this.wheels = spec.wheels;
    this.length = spec.length;
    this.width = spec.width;

    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), start.heading);
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(start.x, (start.y ?? 0) + 0.05, start.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.02)
      .setAngularDamping(0.6)
      .setCcdEnabled(true)
      .setAdditionalMassProperties(spec.mass, spec.com, spec.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = physics.world.createRigidBody(bodyDesc);
    // body shell (massless: mass comes from the additional properties)
    for (const sh of spec.shapes) {
      physics.world.createCollider(R.ColliderDesc.roundCuboid(...sh.half, sh.round).setTranslation(...sh.at)
        .setDensity(0).setFriction(0.25).setRestitution(0.05), this.body);
    }

    this.ctrl = physics.world.createVehicleController(this.body);
    this.ctrl.indexUpAxis = 1;
    this.ctrl.setIndexForwardAxis = 2;
    spec.wheels.forEach((w, i) => {
      this.ctrl.addWheel({ x: w.x, y: w.y, z: w.z }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, spec.suspensionRest, spec.wheelRadius);
      this.ctrl.setWheelSuspensionStiffness(i, spec.stiffness);
      this.ctrl.setWheelSuspensionCompression(i, 2.6);
      this.ctrl.setWheelSuspensionRelaxation(i, 3.4);
      this.ctrl.setWheelMaxSuspensionTravel(i, 0.14);
      this.ctrl.setWheelMaxSuspensionForce(i, spec.maxSuspensionForce);
      this.ctrl.setWheelFrictionSlip(i, w.front ? spec.slipFront : spec.slipRear);
      this.ctrl.setWheelSideFrictionStiffness(i, 1.0);
    });

    this.steer = 0;
    this.speed = 0;
    this.braking = false;     // driver is applying the service brake (brake lights)
    this.reversing = false;   // reverse gear engaged (reverse lights)
    this.brakePressure = 0;   // 0..1, ramps like a real brake pedal: a tap brakes gently, holding brakes hard
    this.handbrake = false;
    this.throttle = 0;
    this._v = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  forward(out = this._fwd) {
    const r = this.body.rotation();
    this._q.set(r.x, r.y, r.z, r.w);
    return out.set(0, 0, -1).applyQuaternion(this._q);
  }

  /** controls: { throttle 0..1, brake 0..1, steer -1..1 (positive = left, matching heading), handbrake bool } */
  update(dt, c) {
    const lv = this.body.linvel();
    this._v.set(lv.x, lv.y, lv.z);
    const fwd = this.forward();
    const speed = this._v.dot(fwd);
    this.speed = speed;
    const absV = Math.abs(speed);

    // Speed-sensitive steering with rate limiting.
    const S = this.spec;
    const maxSteer = THREE.MathUtils.lerp(S.maxSteer, 0.1, THREE.MathUtils.clamp(absV / 45, 0, 1));
    const target = c.steer * maxSteer;
    const rate = (c.steer === 0 ? 3.2 : 2.2) * dt;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -rate, rate);

    let engine = 0;
    let brakeF = 0;
    const driveForce = (v) => Math.min(S.maxDrive, S.power / Math.max(Math.abs(v), 1));
    // Service brake demand: S while rolling forward, or W while still rolling backward.
    const wantBrake = (c.brake > 0 && speed > 0.8) || (c.throttle > 0 && speed < -0.8);
    this.brakePressure = wantBrake
      ? Math.min(1, this.brakePressure + dt / 0.35)
      : Math.max(0, this.brakePressure - dt / 0.12);
    if (c.throttle > 0 && speed >= -0.8) engine = driveForce(speed) * c.throttle;
    if (c.brake > 0 && speed <= 0.8) { engine = -S.reverse * c.brake; this.reversing = true; }
    if (c.throttle > 0 && speed > 0.3) this.reversing = false;
    if (wantBrake) brakeF = S.brake * (0.25 + 0.75 * this.brakePressure);
    if (speed < -14) engine = Math.max(engine, 0);
    if (c.throttle === 0 && c.brake === 0) brakeF = (absV < 0.6 ? 1500 : 220) * (S.mass / 1450); // engine braking / rolling resistance
    this.braking = wantBrake;
    this.handbrake = c.handbrake;
    this.throttle = c.throttle;

    const dtImpulse = dt;
    for (let i = 0; i < 4; i++) {
      const front = this.wheels[i].front;
      // Rapier (like Bullet) rotates the steered axle about the chassis up axis, so a
      // positive angle yaws the wheel counter-clockwise seen from above: a LEFT turn for
      // this -Z-forward chassis. this.steer uses the same convention (positive = left),
      // matching the visual wheel pivots in car.js and heading().
      this.ctrl.setWheelSteering(i, front ? this.steer : 0);
      this.ctrl.setWheelEngineForce(i, front ? 0 : engine / 2);
      let b = brakeF * (front ? 0.62 : 0.38);
      let slip = front ? S.slipFront : S.slipRear;
      if (c.handbrake && !front) { b = Math.max(b, S.handbrake); slip = 1.05; }
      this.ctrl.setWheelBrake(i, b * dtImpulse);
      this.ctrl.setWheelFrictionSlip(i, slip);
    }

    // Aerodynamic drag + downforce.
    const drag = S.drag * absV;
    const down = S.downforce * absV * absV;
    this.body.applyImpulse({ x: -lv.x * drag * dt, y: -down * dt, z: -lv.z * drag * dt }, true);

    this.ctrl.updateVehicle(dt);
  }

  reset(pose) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.heading);
    this.body.setTranslation({ x: pose.x, y: (pose.y ?? 0) + 0.3, z: pose.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
  }

  heading() {
    const f = this.forward();
    return Math.atan2(-f.x, -f.z);
  }
}
