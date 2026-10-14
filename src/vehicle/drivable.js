import * as THREE from 'three';
import { Vehicle, specFromMeta } from './physics.js';

/**
 * A car the player can get into: physics (Vehicle) plus a visual root that follows the body with
 * render interpolation. Two kinds:
 *  - 'ferrari': the hero car (its Car visual: interior, hinged door, cockpit view, seated driver)
 *  - 'traffic': a traffic model taken over from the AI; Traffic keeps drawing it through its
 *    instancing, from this root and the physics wheels
 */
export class Drivable {
  constructor({ kind, vehicle, root, car = null, traffic = null, trafficVehicle = null }) {
    Object.assign(this, { kind, vehicle, root, car, traffic, tv: trafficVehicle });
    this.prevPos = new THREE.Vector3(); this.currPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion(); this.currQuat = new THREE.Quaternion();
    this.renderPos = new THREE.Vector3(); this.renderQuat = new THREE.Quaternion();
    this.capture(); this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat);
    this.hasCockpit = kind === 'ferrari';
    this.hasDoor = kind === 'ferrari';
    // chase cameras pull back for long vehicles (a bus is 12 m)
    this.camScale = Math.max(1, (vehicle.length ?? 4.6) / 4.6);
  }

  /** Take over a traffic vehicle (stopped): physics from its metadata at its current pose. */
  static fromTraffic(traffic, v, scene) {
    const meta = v.model.meta;
    const vehicle = new Vehicle(traffic.physics, { x: v.pos.x, z: v.pos.z, heading: v.heading, y: 0.02 }, specFromMeta(meta));
    const root = new THREE.Object3D();
    root.name = `player-${meta.slug}`;
    scene.add(root);
    const d = new Drivable({ kind: 'traffic', vehicle, root, traffic, trafficVehicle: v });
    d.meta = meta;
    traffic.takeOver(v, d);
    d.interpolate(1);
    return d;
  }

  /** After a physics step: remember the body pose for interpolation. */
  capture() {
    this.prevPos.copy(this.currPos); this.prevQuat.copy(this.currQuat);
    const t = this.vehicle.body.translation(), r = this.vehicle.body.rotation();
    this.currPos.set(t.x, t.y, t.z); this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  /** Pose the visual between the last two physics steps. */
  interpolate(alpha, dt = 1 / 60) {
    this.renderPos.lerpVectors(this.prevPos, this.currPos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    if (this.car) this.car.sync(this.renderPos, this.renderQuat, this.vehicle, dt);
    else {
      this.root.position.copy(this.renderPos);
      this.root.quaternion.copy(this.renderQuat);
      this.root.updateMatrixWorld(true);
    }
  }

  /** Car-local driver's door (outside, ground level) and seat (hip point). */
  #local() {
    if (this.kind === 'ferrari') return { door: [-1.32, 0, 0.12], seat: [-0.355, 0.43, 0.02] };
    const m = this.meta, bus = m.category === 'bus';
    const fl = m.wheels.fl, wb = m.wheelbase || m.length * 0.6, w = Math.min(m.width, bus ? 2.6 : 2.05);
    const hip = { bus: 1.15, van: 0.85, suv: 0.75, pickup: 0.8 }[m.category] ?? 0.55;
    return bus
      ? { door: [w / 2 + 0.55, 0, fl[2] - 0.2], seat: [-w * 0.25, hip, fl[2] - 0.35] }
      : { door: [-(w / 2 + 0.45), 0, fl[2] + wb * 0.42], seat: [-w * 0.22, hip, fl[2] + wb * 0.5] };
  }

  doorPosition(out = new THREE.Vector3()) {
    out.fromArray(this.#local().door).applyQuaternion(this.renderQuat).add(this.renderPos);
    out.y = this.renderPos.y;
    return out;
  }

  seatPosition(out = new THREE.Vector3()) {
    return out.fromArray(this.#local().seat).applyQuaternion(this.renderQuat).add(this.renderPos);
  }

  /** Heading the character faces when getting out (toward the door side). */
  outwardYaw() {
    const side = this.#local().door[0] < 0 ? 1 : -1; // door on the left → face +90°
    return this.vehicle.heading() + side * Math.PI / 2;
  }

  get length() { return this.vehicle.length; }
  get name() {
    if (this.kind === 'ferrari') return 'Ferrari 458';
    const c = this.meta.category;
    return c === 'suv' ? 'SUV' : c[0].toUpperCase() + c.slice(1);
  }
}
