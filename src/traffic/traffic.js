import * as THREE from 'three';
import { buildLaneGraph } from './laneGraph.js';
import { rng } from '../world/layout.js';

const MAX_INSTANCES_PER_MODEL = 24;
const LOD0_DIST = 40;      // cars; buses use LOD0 a little further out
const DRAW_DIST = 420;
const PAINTS = [
  [0xf2f2ef, 22], [0x111214, 18], [0xa9adb2, 14], [0x5d6166, 12], [0x1f3554, 8], [0x8c1414, 7],
  [0xd8cfbf, 5], [0x2c4a37, 4], [0x6d1d2a, 4], [0x3b6fa8, 3], [0xc4a35a, 3],
];

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const FLIP_Y = new THREE.Matrix4().makeRotationY(Math.PI);
const _pf = new THREE.Vector3();
const _pr = new THREE.Vector3();
const _df = new THREE.Vector3();

/**
 * AI traffic.
 * Simulation (fixed step, called from the physics loop):
 *  - vehicles follow lane paths (laneGraph) with the Intelligent Driver Model,
 *  - obey the shared traffic-light cycle, yield on permissive left turns,
 *  - keep distance to leaders on their route and to anything in a forward cone
 *    (including the player), and are kinematic Rapier bodies so the player collides with them.
 * Rendering: per model and LOD, InstancedMeshes for body parts and one shared wheel.
 */
export class Traffic {
  constructor(scene, physics, models, { signals, player, count = 28, seed = 11 } = {}) {
    this.scene = scene;
    this.physics = physics;
    this.models = models;
    this.signals = signals;
    this.player = player;
    this.players = [player];     // every car the player drives or has parked: obstacles for the AI
    this.R = rng(seed);
    this.graph = buildLaneGraph();
    this.vehicles = [];
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    scene.add(this.group);
    this.#buildRenderers();
    this.#spawn(count);
  }

  // ------------------------------------------------------------------ rendering setup
  #buildRenderers() {
    for (const model of this.models) {
      model.render = model.lods.map((lod) => {
        const mk = (geometry, material, n, shadow = true) => {
          const im = new THREE.InstancedMesh(geometry, material, n);
          im.count = 0;
          im.visible = false;
          im.frustumCulled = true; // bounding sphere refreshed every frame in render()
          im.castShadow = shadow;
          im.receiveShadow = true;
          this.group.add(im);
          return im;
        };
        const parts = lod.parts.map((p) => {
          const im = mk(p.geometry, p.material, MAX_INSTANCES_PER_MODEL, p.shadow !== false);
          if (p.paint) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES_PER_MODEL * 3).fill(1), 3);
          if (p.tail || p.uber) {
            const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES_PER_MODEL), 1);
            a.setUsage(THREE.DynamicDrawUsage);
            im.geometry = p.geometry.clone(); // attribute is per-InstancedMesh
            im.geometry.setAttribute('aBrake', a);
            im.userData.brake = a;
          }
          return { im, local: p.local };
        });
        const wheels = lod.wheel.map((w) => {
          const im = mk(w.geometry, w.material, MAX_INSTANCES_PER_MODEL * 4);
          if (w.uber) { // uber shader expects the per-instance brake attribute even on wheels
            im.geometry = w.geometry.clone();
            im.geometry.setAttribute('aBrake', new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES_PER_MODEL * 4), 1));
          }
          return { im, local: w.local };
        });
        return { parts, wheels };
      });
    }
  }

  // ------------------------------------------------------------------ spawning
  #pickModel(onWideRoad) {
    const R = this.R;
    const counts = new Map();
    for (const v of this.vehicles) counts.set(v.model, (counts.get(v.model) ?? 0) + 1);
    const pool = this.models.filter((m) => (counts.get(m) ?? 0) < MAX_INSTANCES_PER_MODEL && (m.meta.category !== 'bus' || onWideRoad));
    const weight = (m) => (m.meta.category === 'bus' ? 0.35 : m.meta.category === 'van' || m.meta.category === 'pickup' ? 0.8 : 1.2) / (1 + (counts.get(m) ?? 0));
    const total = pool.reduce((a, m) => a + weight(m), 0);
    let r = R() * total;
    for (const m of pool) { r -= weight(m); if (r <= 0) return m; }
    return pool[0];
  }

  #spawn(count) {
    const R = this.R;
    const segs = this.graph.segments;
    const player = this.players[0].body.translation();
    let guard = 0;
    while (this.vehicles.length < count && guard++ < count * 40) {
      const seg = segs[Math.floor(R() * segs.length)];
      const wide = seg.road.name === 'Grand Blvd' || seg.road.name === 'Vine Ave';
      const model = this.#pickModel(wide);
      if (!model) continue; // e.g. only buses loaded and this is a narrow street
      const len = model.meta.length;
      if (seg.length < len + 6) continue;
      const s = len / 2 + R() * (seg.length - len - 2);
      seg.sample(s, _p, _d);
      if (Math.hypot(_p.x - player.x, _p.z - player.z) < 22) continue;
      const clash = this.vehicles.some((o) => o.path === seg && Math.abs(o.s - s) < (o.len + len) / 2 + 9);
      if (clash) continue;
      this.vehicles.push(this.#makeVehicle(model, seg, s));
    }
  }

  #makeVehicle(model, seg, s) {
    const R = this.R;
    const m = model.meta;
    const paint = (() => {
      const tot = PAINTS.reduce((a, p) => a + p[1], 0);
      let r = R() * tot;
      for (const [c, w] of PAINTS) { r -= w; if (r <= 0) return new THREE.Color(c); }
      return new THREE.Color(0xffffff);
    })();
    const width = Math.min(m.width, m.category === 'bus' ? 2.6 : 2.05);
    const height = m.height;
    seg.sample(s, _p, _d);
    const h0 = Math.atan2(-_d.x, -_d.z);
    _q.setFromAxisAngle(UP, h0);
    const desc = this.physics.R.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(_p.x, 0, _p.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    const body = this.physics.world.createRigidBody(desc);
    const clearance = m.category === 'bus' ? 0.35 : 0.25;
    this.physics.world.createCollider(
      this.physics.R.ColliderDesc.cuboid(width / 2 * 0.96, (height - clearance) / 2, m.length / 2 * 0.97)
        .setTranslation(0, clearance + (height - clearance) / 2, 0).setFriction(0.4),
      body,
    );
    const v = {
      model, path: seg, s, v: 0, a: 0, len: m.length, width, height,
      bus: m.category === 'bus',
      factor: m.category === 'bus' ? 0.85 : 0.88 + R() * 0.22,
      paint, body, spin: 0, steer: 0, brake: 0, wait: 0, creep: 0, pitch: 0,
      pos: new THREE.Vector3(), dir: new THREE.Vector3(), heading: 0,
      next: null, prevPath: null,
      // axle positions relative to the model origin (+ = ahead of it)
      axleF: -(m.wheels?.fl?.[2] ?? -m.length * 0.32),
      axleR: -(m.wheels?.rl?.[2] ?? m.length * 0.32),
    };
    v.next = this.#chooseConnector(v, seg);
    this.#pose(v, 0);
    this.#syncBody(v);
    return v;
  }

  #chooseConnector(v, seg) {
    const R = this.R;
    const opts = seg.outgoing;
    if (!opts.length) return null;
    const w = (c) => {
      if (v.bus) return c.move === 'straight' ? 5 : c.move === 'left' ? 1.2 : 0.25; // buses avoid tight right turns
      return c.move === 'straight' ? 3 : 1;
    };
    const tot = opts.reduce((a, c) => a + w(c), 0);
    let r = R() * tot;
    for (const c of opts) { r -= w(c); if (r <= 0) return c; }
    return opts[0];
  }

  // ------------------------------------------------------------------ simulation
  step(dt) {
    this.time += dt;
    const vs = this.vehicles;
    for (const v of vs) if (!v.drive) this.#think(v, dt);
    for (const v of vs) if (!v.drive) this.#advance(v, dt);
  }

  /** Route chain ahead of v: [{path, offset}] where offset = distance from v's centre to the path start. */
  #chain(v) {
    const out = [{ path: v.path, offset: -v.s }];
    let off = v.path.length - v.s;
    if (v.next) {
      out.push({ path: v.next, offset: off });
      off += v.next.length;
      out.push({ path: v.next.to ?? v.next, offset: off });
    } else if (v.path.to && v.path.kind !== 'segment') {
      out.push({ path: v.path.to, offset: off });
    }
    return out;
  }

  #think(v, dt) {
    const LOOK = 55;
    let gap = Infinity, leadV = 0;
    const chain = this.#chain(v);
    // 1) vehicles on our route
    for (const o of this.vehicles) {
      if (o === v || o.drive) continue;
      for (const c of chain) {
        if (o.path !== c.path) continue;
        const ahead = c.offset + o.s;           // centre-to-centre distance along our route
        if (ahead <= 0) continue;               // behind us: not a leader
        const d = ahead - (v.len + o.len) / 2;
        if (d < gap) { gap = Math.max(0.05, d); leadV = o.v; }
      }
    }
    // 2) anything in a forward cone (crossing traffic finishing a turn, the player)
    const cone = (pos, heading, len, width, vel, isPlayer) => {
      _d.set(pos.x - v.pos.x, 0, pos.z - v.pos.z);
      const f = _d.dot(v.dir);
      if (f <= 0 || f > LOOK) return;
      const lat = Math.abs(_d.x * -v.dir.z + _d.z * v.dir.x);
      const rel = Math.abs(Math.sin(heading - v.heading));
      const halfW = width / 2 * (1 - rel) + len / 2 * rel;
      if (lat > v.width / 2 + halfW + 0.35) return;
      const ext = len / 2 * (1 - rel) + width / 2 * rel;
      const g = f - v.len / 2 - ext;
      // ignore oncoming vehicles that are not actually in our way laterally (handled by lanes)
      if (!isPlayer && Math.cos(heading - v.heading) < -0.5 && lat > 1.2) return;
      if (g < gap) { gap = Math.max(0.05, g); leadV = Math.max(0, vel * Math.cos(heading - v.heading)); }
    };
    if (v.creep <= 0) {
      for (const o of this.vehicles) {
        if (o === v || o.drive) continue;
        if (Math.abs(o.pos.x - v.pos.x) > LOOK || Math.abs(o.pos.z - v.pos.z) > LOOK) continue;
        cone(o.pos, o.heading, o.len, o.width, o.v, false);
      }
    }
    for (const pv of this.players) {
      const pt = pv.body.translation();
      _p.set(pt.x, 0, pt.z);
      if (Math.abs(_p.x - v.pos.x) > LOOK || Math.abs(_p.z - v.pos.z) > LOOK) continue;
      const plv = pv.body.linvel();
      cone(_p, pv.heading(), pv.length ?? 4.6, pv.width ?? 2.0, Math.hypot(plv.x, plv.z), true);
    }
    // the player on foot: a pedestrian-sized obstacle (drivers stop rather than run them over)
    const ped = this.pedestrian;
    if (ped?.active && Math.abs(ped.pos.x - v.pos.x) < LOOK && Math.abs(ped.pos.z - v.pos.z) < LOOK) {
      _p.set(ped.pos.x, 0, ped.pos.z);
      cone(_p, ped.yaw, 0.9, 0.9, 0, true);
    }

    // 3) traffic signal at the end of our segment / permissive left turns
    if (v.path.kind === 'segment' && v.next) {
      const toStop = v.path.length - v.s - v.len / 2;
      if (toStop < 70) {
        const phase = this.signals.phase(v.path.axis);
        let stop = phase === 'r' || (phase === 'y' && toStop > (v.v * v.v) / (2 * 3.5) + 1);
        if (!stop && v.next.move === 'left' && toStop < 25) stop = this.#mustYieldLeft(v);
        if (!stop && toStop < 18) stop = this.#adjacentConflict(v, toStop);
        if (stop && toStop < gap) { gap = Math.max(0.05, toStop); leadV = 0; }
      }
    }

    // desired speed: current limit, approach speed for the next path, curvature
    const limit = (p) => Math.min(p.speedLimit, p.maxSpeed(2.2));
    let v0 = limit(v.path) * v.factor;
    if (v.next) {
      const dNext = v.path.length - v.s;
      const vn = limit(v.next) * v.factor;
      v0 = Math.min(v0, Math.sqrt(vn * vn + 2 * 1.8 * Math.max(0, dNext - v.len / 2)));
    }
    // Intelligent Driver Model
    const aMax = v.bus ? 0.9 : 1.5, b = 2.2, s0 = v.bus ? 3.0 : 2.2, T = v.bus ? 1.6 : 1.3;
    const free = 1 - Math.pow(Math.max(0, v.v) / Math.max(0.5, v0), 4);
    let a = aMax * free;
    if (gap < Infinity) {
      const sStar = s0 + Math.max(0, v.v * T + (v.v * (v.v - leadV)) / (2 * Math.sqrt(aMax * b)));
      a -= aMax * (sStar / Math.max(0.05, gap)) ** 2;
    }
    v.a = THREE.MathUtils.clamp(a, -7.5, aMax);
    if (v.held) v.a = v.v > 0.05 ? -5.5 : 0; // the player is getting in: pull up and wait
    // deadlock breaker: stuck behind a cone-only obstacle for a long time → creep past it
    if (v.v < 0.2 && gap < 6) v.wait += dt; else v.wait = Math.max(0, v.wait - dt * 2);
    v.creep = Math.max(0, v.creep - dt);
    if (v.wait > 9 && !this.#routeBlocked(v)) { v.creep = 2.5; v.wait = 0; }
  }

  #routeBlocked(v) {
    const chain = this.#chain(v);
    return this.vehicles.some((o) => o !== v && !o.drive && chain.some((c) => c.path === o.path && c.offset + o.s - v.len / 2 > 0 && c.offset + o.s < 12))
      || (v.path.kind === 'segment' && this.signals.phase(v.path.axis) !== 'g' && v.path.length - v.s < 12);
  }

  /**
   * Side-by-side manoeuvres from neighbouring lanes of the same approach: a turning
   * vehicle's tail swings into the next lane (a lot for buses), so the vehicle that is
   * further back waits until the other has got going. Ties go to the lower id.
   */
  #adjacentConflict(v, toStop) {
    const seg = v.path;
    for (const o of this.vehicles) {
      if (o === v || o.drive) continue;
      let oSeg, oToStop;
      if (o.path.kind === 'segment' && o.path !== seg && o.path.from === seg.from && o.path.to === seg.to) {
        oSeg = o.path; oToStop = o.path.length - o.s - o.len / 2;
        if (!o.next) continue;
        const turning = v.next.move !== 'straight' || o.next.move !== 'straight';
        if (!turning || Math.abs(oToStop - toStop) > (v.len + o.len) / 2 + 2) continue;
        if (oToStop < toStop - 0.5 || (Math.abs(oToStop - toStop) <= 0.5 && this.vehicles.indexOf(o) < this.vehicles.indexOf(v))) return true;
      } else if (o.path.kind !== 'segment' && o.path.from && o.path.from !== seg && o.path.from.from === seg.from && o.path.from.to === seg.to) {
        oSeg = o.path.from;
        // the other vehicle has entered its manoeuvre: wait until its tail has cleared the stop line area
        if ((v.next.move !== 'straight' || o.path.move !== 'straight') && o.s < o.len + 3) return true;
      }
      void oSeg;
    }
    return false;
  }

  /** Yield to oncoming straight/right traffic that is close or already crossing. */
  #mustYieldLeft(v) {
    const I = v.next.intersection;
    for (const o of this.vehicles) {
      if (o === v || o.drive) continue;
      if (o.path.kind !== 'segment' && o.path.intersection === I && o.path.from.heading.dot(v.path.heading) < -0.9 && o.path.move !== 'left') return true;
      if (o.path.kind === 'segment' && v.path.oncoming.includes(o.path) && o.next && o.next.move !== 'left') {
        const d = o.path.length - o.s;
        if (d < 8 + o.v * 4.5 && o.v > 0.5) return true;
      }
    }
    return false;
  }

  #advance(v, dt) {
    v.v = Math.max(0, v.v + v.a * dt);
    v.s += v.v * dt;
    while (v.s > v.path.length) {
      v.s -= v.path.length;
      v.prevPath = v.path;
      if (v.path.kind === 'segment') {
        if (!v.next) { v.s = v.path.length; v.v = 0; break; }
        v.path = v.next;
        v.next = null; // the connector's target segment is implied by path.to
      } else {
        v.path = v.path.to;
        v.next = this.#chooseConnector(v, v.path);
      }
    }
    this.#pose(v, dt);
    v.spin += (v.v * dt) / (v.model.meta.wheelRadius || 0.34);
    v.brake += ((v.a < -0.6 || v.v < 0.3 ? 1 : 0) - v.brake) * Math.min(1, dt * 12);
    v.pitch += (THREE.MathUtils.clamp(-v.a * 0.0045, -0.02, 0.02) - v.pitch) * Math.min(1, dt * 4);
    this.#syncBody(v);
  }

  /** Sample the route at distance d from the vehicle's path position (may reach the previous/next element). */
  #routeSample(v, d, outPos, outDir) {
    let p = v.path, s = v.s + d;
    if (s < 0 && v.prevPath) { p = v.prevPath; s += p.length; }
    else if (s > p.length) {
      const nxt = p.kind === 'segment' ? v.next : p.to;
      if (nxt) { s -= p.length; p = nxt; }
    }
    return p.sample(s, outPos, outDir);
  }

  /**
   * Rigid-body pose with both axles on the lane path (like a real car, the body pivots
   * near its axles instead of its centre, so long vehicles don't swing into the next lane).
   */
  #pose(v, dt) {
    this.#routeSample(v, v.axleF, _pf, _df);
    this.#routeSample(v, v.axleR, _pr, _d);
    v.dir.subVectors(_pf, _pr).setY(0);
    if (v.dir.lengthSq() < 1e-8) v.dir.copy(_df);
    v.dir.normalize();
    v.heading = Math.atan2(-v.dir.x, -v.dir.z);
    v.pos.copy(_pr).addScaledVector(v.dir, -v.axleR); // model origin lies |axleR| ahead of the rear axle
    // front-wheel steer = path tangent at the front axle relative to the body (positive = left)
    const target = Math.atan2(v.dir.x * _df.z - v.dir.z * _df.x, v.dir.dot(_df));
    v.steer += (THREE.MathUtils.clamp(-target, -0.6, 0.6) - v.steer) * Math.min(1, dt * 10 || 1);
  }

  #syncBody(v) {
    _q.setFromAxisAngle(UP, v.heading);
    v.body.setNextKinematicTranslation({ x: v.pos.x, y: 0, z: v.pos.z });
    v.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
  }

  // ------------------------------------------------------------------ player takeover
  /** Ask an AI vehicle to stop where it is (the player is walking up to get in). */
  hold(v) { v.held = true; }

  release(v) { v.held = false; }

  /**
   * Hand a vehicle over to the player: the AI stops simulating it, its kinematic body is removed
   * (the player's physics vehicle replaces it) and it is drawn from `drive.root` and the physics wheels.
   */
  takeOver(v, drive) {
    v.drive = drive;
    v.held = false;
    if (v.body) { this.physics.world.removeRigidBody(v.body); v.body = null; }
    this.players.push(drive.vehicle);
  }

  /** Driver's door of a vehicle in world space (outside, on the ground). */
  doorOf(v, out = new THREE.Vector3()) {
    const m = v.model.meta;
    const fl = m.wheels.fl, wb = m.wheelbase || m.length * 0.6;
    const lx = v.bus ? m.width / 2 + 0.55 : -(Math.min(m.width, 2.05) / 2 + 0.45);  // buses board at the front right
    const lz = v.bus ? fl[2] - 0.2 : fl[2] + wb * 0.42;
    out.set(lx, 0, lz).applyAxisAngle(UP, v.heading);
    return out.add(_p.set(v.pos.x, 0, v.pos.z));
  }

  // ------------------------------------------------------------------ rendering
  render(camera) {
    const cam = camera.position;
    for (const model of this.models) for (const r of model.render) {
      r.n = 0;
    }
    for (const v of this.vehicles) {
      const dist = Math.hypot(v.pos.x - cam.x, v.pos.z - cam.z);
      if (dist > DRAW_DIST) continue;
      const lodIndex = dist < (v.bus ? LOD0_DIST * 1.25 : LOD0_DIST) ? 0 : 1;
      const r = v.model.render[lodIndex];
      const i = r.n++;
      const D = v.drive;
      if (D) {
        // player-driven / parked: the physics pose, wheels from the ray-cast vehicle
        _m.copy(D.root.matrixWorld);
        v.pos.setFromMatrixPosition(_m);
        v.heading = D.vehicle.heading();
        v.brake += ((D.vehicle.braking || Math.abs(D.vehicle.speed) < 0.3 ? 1 : 0) - v.brake) * 0.3;
      } else {
        _e.set(v.pitch, v.heading, 0, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(v.pos.x, 0, v.pos.z), _q, _s);
      }
      for (const part of r.parts) {
        part.im.setMatrixAt(i, _m2.multiplyMatrices(_m, part.local));
        if (part.im.instanceColor) part.im.setColorAt(i, v.paint);
        if (part.im.userData.brake) part.im.userData.brake.array[i] = v.brake;
      }
      const meta = v.model.meta;
      ['fl', 'fr', 'rl', 'rr'].forEach((k, wi) => {
        const c = meta.wheels[k];
        if (!c) return;
        const right = c[0] > 0;
        let steer = k[0] === 'f' ? v.steer : 0, spin = v.spin, y = c[1];
        if (D) {
          const ctrl = D.vehicle.ctrl;
          steer = ctrl.wheelSteering(wi) ?? 0;
          spin = ctrl.wheelRotation(wi) ?? 0;
          y = D.vehicle.wheels[wi].y - (ctrl.wheelSuspensionLength(wi) ?? D.vehicle.spec.suspensionRest);
        }
        _m2.copy(_m).multiply(_wheelMat.makeTranslation(c[0], y, c[2]))
          .multiply(_rot.makeRotationY(steer))
          .multiply(_rot2.makeRotationX(-spin)); // same sense both sides: the flip below is applied first
        if (right) _m2.multiply(FLIP_Y);
        for (const w of r.wheels) w.im.setMatrixAt(i * 4 + wi, _tmp.multiplyMatrices(_m2, w.local));
      });
    }
    for (const model of this.models) for (const r of model.render) {
      for (const part of r.parts) {
        part.im.count = r.n;
        part.im.visible = r.n > 0;
        if (!r.n) continue;
        part.im.instanceMatrix.needsUpdate = true;
        if (part.im.instanceColor) part.im.instanceColor.needsUpdate = true;
        if (part.im.userData.brake) part.im.userData.brake.needsUpdate = true;
        part.im.computeBoundingSphere();
      }
      for (const w of r.wheels) {
        w.im.count = r.n * 4;
        w.im.visible = r.n > 0;
        if (!r.n) continue;
        w.im.instanceMatrix.needsUpdate = true;
        w.im.computeBoundingSphere();
      }
    }
  }
}

const _wheelMat = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _rot2 = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
