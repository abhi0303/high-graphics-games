import * as THREE from 'three';
import { Driver } from './driver.js';
import { Drivable } from '../vehicle/drivable.js';

const PARKED = { throttle: 0, brake: 0, steer: 0, handbrake: true };
const ENTER_RANGE = 3.2;
const _v = new THREE.Vector3();
const ease = (t) => { const x = THREE.MathUtils.clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

// enter / exit choreography (seconds)
const EXIT = { swing: [0.3, 0.9], stand: 0.9, standScale: 2.1 };
const ENTER = { turn: 0.35, sitScale: 1.95, swing: 0.6 };

/**
 * Who the player controls and the transitions between them:
 *   driving ─E→ exiting → onfoot ─E near a car→ approach (walk to its door) → entering → driving
 * Any car can be entered: the Ferrari (hinged door, seated driver, cockpit view), cars the player
 * has left parked, and AI traffic (the driver pulls up, the car becomes the player's: Drivable).
 * Routes input to the right controller and keeps the camera subject, HUD and help in sync.
 */
export class Player {
  constructor({ ferrari, traffic, scene, character, onFoot, rig, hud, input }) {
    Object.assign(this, { ferrari, traffic, scene, character, onFoot, rig, hud, input });
    this.car = ferrari.car;                 // the Ferrari's visual (door, interior)
    this.driver = new Driver(character, ferrari.car);
    this.current = ferrari;                 // the car being driven / last driven
    this.drivables = [ferrari];             // every car the player owns (driven or parked)
    this.mode = 'driving';
    this.seq = null;
    this.edges = { jump: false, kneel: false, punch: false };
    character.root.visible = true;
    character.play('drive', { fade: 0 });
    input.on('KeyE', () => this.toggleVehicle());
    input.on('Space', () => { if (this.mode === 'onfoot') this.edges.jump = true; });
    input.on('ControlLeft', () => { if (this.mode === 'onfoot') this.edges.kneel = true; });
    input.on('ControlRight', () => { if (this.mode === 'onfoot') this.edges.kneel = true; });
    input.onMouse(0, () => {
      if (this.mode !== 'onfoot') return;
      this.edges.punch = true;
      input.lock();
    });
  }

  /** The physics vehicle being driven (or the last one). */
  get vehicle() { return this.current.vehicle; }

  /** Controls for drivable `d` this physics step (parked with the handbrake on unless being driven). */
  vehicleControls(c, d = this.current) {
    return this.mode === 'driving' && d === this.current ? c : PARKED;
  }

  /** Fixed-step update of the character controller (edge inputs are consumed once). */
  step(dt) {
    if (!this.onFoot.active) return;
    let c = { ...this.input.onFoot(), ...this.edges, camYaw: this.rig.yaw };
    if (this.mode === 'approach') {
      // walk to the driver's door on our own; any movement key cancels
      if (c.forward || c.right) { this.#cancelApproach(); }
      else {
        const door = this.#targetDoor(_v);
        const dx = door.x - this.onFoot.pos.x, dz = door.z - this.onFoot.pos.z;
        const d = Math.hypot(dx, dz);
        this.approachTime += dt;
        const stopped = !this.target.v || this.target.v.v < 0.3;
        if ((d < 0.25 && stopped) || this.approachTime > 6) { this.#startEnter(); return; }
        c = d < 0.25
          ? { forward: 0, right: 0, run: false, block: false, jump: false, kneel: false, punch: false, camYaw: c.camYaw }
          : { forward: 1, right: 0, run: d > 6, block: false, jump: false, kneel: false, punch: false, camYaw: Math.atan2(-dx, -dz) };
      }
    }
    this.onFoot.step(dt, c);
    this.edges.jump = this.edges.kneel = this.edges.punch = false;
  }

  sync(alpha, dt) {
    if (this.onFoot.active) this.onFoot.sync(alpha, dt);
    else if (this.mode === 'driving') {
      if (this.current.kind === 'ferrari') {
        this.character.update(dt, { speed: 0 });
        this.driver.apply(this.vehicle.steer, { firstPerson: this.rig.isCockpit && !this.rig.blend });
      }
    } else if (this.seq) this.#sequence(dt);
    if (this.doorCloseAt !== undefined && (this.doorCloseAt -= dt) <= 0) { this.car.setDoor(0); this.doorCloseAt = undefined; }
    this.#prompt();
  }

  /** World position of the Ferrari's driver's door (outside, on the ground). */
  doorPosition(out = new THREE.Vector3()) { return this.ferrari.doorPosition(out); }

  /** Nearest car door within reach: { d } for a player car, { v } for AI traffic; null if none. */
  nearestEntry(range = ENTER_RANGE) {
    const p = this.onFoot.pos;
    let best = null, bd = range;
    for (const d of this.drivables) {
      const dist = d.doorPosition(_v).distanceTo(p);
      if (dist < bd) { bd = dist; best = { d }; }
    }
    if (this.traffic) for (const v of this.traffic.vehicles) {
      if (v.drive || Math.abs(v.pos.x - p.x) > 12 || Math.abs(v.pos.z - p.z) > 12) continue;
      const dist = this.traffic.doorOf(v, _v).distanceTo(p);
      if (dist < bd) { bd = dist; best = { v }; }
    }
    return best;
  }

  #targetDoor(out) {
    return this.target.d ? this.target.d.doorPosition(out) : this.traffic.doorOf(this.target.v, out);
  }

  canEnter() {
    if (this.mode !== 'onfoot' || this.onFoot.busy) return false;
    return !!this.nearestEntry();
  }

  toggleVehicle() {
    if (this.mode === 'driving') this.exitVehicle();
    else if (this.mode === 'onfoot' && this.canEnter()) this.enterVehicle();
  }

  // ------------------------------------------------------------------ exit
  exitVehicle() {
    if (this.mode !== 'driving') return false;
    if (Math.abs(this.vehicle.speed) > 2.5) { this.hud.flashCamera('Slow down to get out'); return false; }
    this.mode = 'exiting';
    const C = this.character, D = this.current;
    if (D.kind === 'ferrari') {
      this.car.setDoor(1);
      this.seq = { kind: 'exit', t: 0, seatRoot: C.root.position.clone(), phase: 'swing' };
      C.play('sit', { fade: 0.3 });
    } else {
      // no opening door on traffic models: stand up from the seat and step out of the door side
      C.root.visible = true;
      C.play('stand_up', { fade: 0, timeScale: EXIT.standScale });
      this.seq = { kind: 'exitGeneric', t: 0 };
    }
    this.onFoot.render.copy(D.seatPosition(_v));
    this.onFoot.vel.set(0, 0, 0);
    // closed cars: the character camera takes over once he is out of the body (it would start inside)
    if (D.kind === 'ferrari') this.rig.setSubject('character', C.root, { time: 1.6 });
    this.hud.setMode('onfoot');
    this.hud.prompt(null);
    return true;
  }

  // ------------------------------------------------------------------ enter
  enterVehicle() {
    if (this.mode !== 'onfoot') return false;
    const t = this.nearestEntry();
    if (!t) return false;
    this.target = t;
    if (t.v) this.traffic.hold(t.v); // the AI driver pulls up
    this.mode = 'approach';
    this.approachTime = 0;
    this.hud.prompt(null);
    return true;
  }

  #cancelApproach() {
    if (this.target?.v) this.traffic.release(this.target.v);
    this.target = null;
    this.mode = 'onfoot';
  }

  #startEnter() {
    const C = this.character;
    // an AI car becomes the player's: physics vehicle in its place, AI no longer drives it
    if (this.target.v) {
      const d = Drivable.fromTraffic(this.traffic, this.target.v, this.scene);
      this.drivables.push(d);
      this.target = { d };
    }
    const D = this.target.d;
    this.onFoot.remove();
    this.mode = 'entering';
    this.current = D;
    if (D.kind === 'ferrari') this.car.setDoor(1);
    this.seq = { kind: D.kind === 'ferrari' ? 'enter' : 'enterGeneric', t: 0, from: this.onFoot.render.clone(), yaw0: this.onFoot.yaw, phase: 'turn' };
    C.play(null, { fade: 0.2 });
  }

  #finishEnter() {
    const D = this.current;
    this.seq = null;
    this.mode = 'driving';
    if (D.kind === 'ferrari') this.doorCloseAt = 0;
    else this.character.root.visible = false; // no interior to sit in on traffic models
    this.input.unlock();
    this.rig.setSubject('vehicle', D.root, { time: 1.1 });
    this.hud.setMode('driving');
    this.hud.flashCamera(D.name);
  }

  /** Put the hip centre at `seat` (world) with weight w, the root otherwise at `place`. */
  #placeHips(place, yaw, seat, w) {
    const C = this.character, b = C.bones;
    C.setPose(place, yaw);
    if (w <= 0) return;
    C.root.updateMatrixWorld(true);
    const hips = b.Bip01_L_Thigh.getWorldPosition(new THREE.Vector3()).add(b.Bip01_R_Thigh.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    C.root.position.addScaledVector(seat.sub(hips), w);
    C.root.updateMatrixWorld(true);
  }

  /** Drive the enter/exit choreography (visual only; the car is parked meanwhile). */
  #sequence(dt) {
    const S = this.seq, C = this.character, D = this.current;
    S.t += dt;
    const heading = this.vehicle.heading();
    const door = D.doorPosition(new THREE.Vector3());
    const outYaw = D.outwardYaw();
    D.root.updateMatrixWorld(true);

    if (S.kind === 'exitGeneric') {
      const dur = 2.5 / EXIT.standScale, u = S.t / dur;
      C.update(dt, { speed: 0 });
      const seat = D.seatPosition(new THREE.Vector3());
      const place = new THREE.Vector3().lerpVectors(seat.clone().setY(door.y), door, ease(u / 0.85));
      this.#placeHips(place, outYaw, seat, 1 - ease(u / 0.6));
      if (u > 0.55) this.rig.setSubject('character', C.root, { time: 1.0, arc: 0.6 });
      if (u >= 1) {
        this.seq = null;
        this.mode = 'onfoot';
        this.onFoot.spawn(C.root.position.clone().setY(door.y), outYaw);
      }
      this.onFoot.render.copy(C.root.position);
      return;
    }
    if (S.kind === 'enterGeneric') {
      if (S.t < ENTER.turn) {
        const u = ease(S.t / ENTER.turn);
        C.update(dt, { speed: 0 });
        C.setPose(new THREE.Vector3().lerpVectors(S.from, door, u), lerpAngle(S.yaw0, outYaw, u));
      } else {
        if (S.phase !== 'sit') {
          S.phase = 'sit';
          C.play('sit_down', { fade: 0.15, timeScale: ENTER.sitScale });
          this.rig.setSubject('vehicle', D.root, { time: 1.3, arc: 0.9 }); // over the roof to the chase view
        }
        const u = (S.t - ENTER.turn) / (2.9 / ENTER.sitScale);
        C.update(dt, { speed: 0 });
        const seat = D.seatPosition(new THREE.Vector3());
        const place = new THREE.Vector3().lerpVectors(door, seat.clone().setY(door.y), ease(u));
        this.#placeHips(place, outYaw, seat, ease((u - 0.3) / 0.6));
        if (u >= 1) this.#finishEnter();
      }
      this.onFoot.render.copy(C.root.position);
      return;
    }

    // ---- the Ferrari: hinged door, legs swing in/out over the sill, seated driver with IK
    const out = Math.PI / 2;
    if (S.kind === 'exit') {
      if (S.t < EXIT.stand) {
        C.update(dt, { speed: 0 });
        const u = ease((S.t - EXIT.swing[0]) / (EXIT.swing[1] - EXIT.swing[0]));
        this.driver.apply(0, { yaw: out * u, ik: 1 - ease(S.t / EXIT.swing[0] - 0.2) });
      } else {
        if (S.phase !== 'stand') { S.phase = 'stand'; C.play('stand_up', { fade: 0.15, timeScale: EXIT.standScale }); S.standStart = S.t; }
        const u = (S.t - S.standStart) / (2.5 / EXIT.standScale);
        C.update(dt, { speed: 0 });
        const place = new THREE.Vector3().lerpVectors(S.seatRoot, door, ease(u / 0.85));
        this.driver.apply(0, { yaw: out, place, weight: 1 - ease(u / 0.7), ik: 0 });
        if (u >= 1) {
          this.seq = null;
          this.mode = 'onfoot';
          this.onFoot.spawn(C.root.position.clone().setY(door.y), heading + out);
          this.doorCloseAt = 0.25;
        }
      }
      this.onFoot.render.copy(C.root.position);
      return;
    }
    if (S.t < ENTER.turn) {
      const u = ease(S.t / ENTER.turn);
      C.update(dt, { speed: 0 });
      C.setPose(new THREE.Vector3().lerpVectors(S.from, door, u), lerpAngle(S.yaw0, heading + out, u));
    } else {
      const sitDur = 2.9 / ENTER.sitScale;
      const t = S.t - ENTER.turn;
      if (t < sitDur) {
        if (S.phase !== 'sit') { S.phase = 'sit'; C.play('sit_down', { fade: 0.15, timeScale: ENTER.sitScale }); }
        const u = t / sitDur;
        C.update(dt, { speed: 0 });
        const seat = D.seatPosition(new THREE.Vector3()).setY(door.y);
        const place = new THREE.Vector3().lerpVectors(door, seat, ease(u));
        this.driver.apply(0, { yaw: out, place, weight: ease((u - 0.3) / 0.6), ik: 0 });
      } else {
        if (S.phase !== 'swing') { S.phase = 'swing'; C.play('drive', { fade: 0.35 }); }
        const u = ease((t - sitDur) / ENTER.swing);
        C.update(dt, { speed: 0 });
        this.driver.apply(this.vehicle.steer * u, { yaw: out * (1 - u), ik: ease((u - 0.45) / 0.55) });
        if (u >= 1) this.#finishEnter();
      }
    }
    this.onFoot.render.copy(C.root.position);
  }

  #prompt() {
    let text = null;
    if (this.mode === 'onfoot' && !this.onFoot.busy) {
      const e = this.nearestEntry();
      if (e) { const c = e.d ? e.d.name : e.v.model.meta.category; text = `E  Enter ${c === 'suv' ? 'SUV' : c}`; }
    }
    if (text !== this.promptText) { this.promptText = text; this.hud.prompt(text); }
  }
}
