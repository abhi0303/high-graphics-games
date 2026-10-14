import * as THREE from 'three';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export const CAPSULE = { radius: 0.28, half: 0.62 };           // 1.80 m tall
const CENTER_Y = CAPSULE.half + CAPSULE.radius;               // feet → capsule centre
const WALK_SPEED = 1.15;
const RUN_SPEED = 5.5;
const JUMP_SPEED = 3.7;                                       // ≈0.7 m of clearance, 0.75 s in the air
const RUN_JUMP_SPEED = 3.4;                                   // running leaps go long rather than high
const GRAVITY = 9.81;
const MAX_STEP = 0.36;                                        // curbs, kerb stones, single steps: walked over
const MAX_HURDLE = 1.3;                                       // Space in front of a wall up to this height clears it
const PUNCH_COMBO_WINDOW = 0.45;

/**
 * On-foot gameplay for the player character: a Rapier kinematic character controller (capsule,
 * snap-to-ground) with its own step-up for curbs and small ledges (ground probes ahead of the feet),
 * camera-relative movement, and the action state machine:
 *
 *   move ─Space→ jump (standing hop / running leap; higher in front of a hurdle) ─(take-off)→ air
 *        ─(ground)→ land (rolls straight into a run when moving) → move
 *   move ─Ctrl→ kneel_down → kneel ─Ctrl/move→ kneel_up → move
 *   move ─LMB→ punch ⇄ combat ─timeout/move→ move;  RMB held → block
 *
 * Physics runs in step() at the fixed rate; the visual pose is interpolated in sync().
 */
export class OnFoot {
  constructor(physics, character) {
    this.physics = physics;
    this.character = character;
    this.active = false;
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
    this.collider = physics.world.createCollider(R.ColliderDesc.capsule(CAPSULE.half, CAPSULE.radius).setFriction(0), this.body);
    this.collider.setEnabled(false);
    const kcc = physics.world.createCharacterController(0.02);
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    kcc.setMinSlopeSlideAngle((35 * Math.PI) / 180);
    // steps are handled by #stepUp (Rapier's auto-step does not climb the road mesh's curb faces)
    kcc.enableSnapToGround(0.22);
    kcc.setApplyImpulsesToDynamicBodies(false); // a person cannot shove a parked car
    kcc.setSlideEnabled(true);
    this.kcc = kcc;
    this.pos = new THREE.Vector3();     // feet, current physics step
    this.prev = new THREE.Vector3();    // feet, previous physics step
    this.render = new THREE.Vector3();
    this.vel = new THREE.Vector3();     // horizontal velocity (m/s)
    this.vy = 0;
    this.yaw = 0;
    this.grounded = true;
    this.airTime = 0;
    this.state = 'move';
    this.stateTime = 0;
    this.queue = null;                  // buffered punch
    this.punchSide = 'l';
    this.stepOffset = 0;                // visual lag after stepping up (smooths curbs)
    this.sinceTakeoff = 9;              // seconds since the last jump take-off
    this.walls = [];                    // horizontal contact normals from the last step
    this.jumpKind = 'stand';
    this.hits = [];                     // recent hits (for gameplay / tests)
    this.onHit = null;
  }

  /** Put the character on foot at a feet position facing `yaw`. */
  spawn(pos, yaw, state = 'move') {
    this.pos.copy(pos);
    this.prev.copy(pos);
    this.render.copy(pos);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.body.setTranslation({ x: pos.x, y: pos.y + CENTER_Y, z: pos.z }, true);
    this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + CENTER_Y, z: pos.z });
    this.collider.setEnabled(true);
    this.active = true;
    this.#enter(state);
    this.character.root.visible = true;
    this.character.setPose(pos, yaw);
  }

  remove() {
    this.active = false;
    this.collider.setEnabled(false);
    this.body.setTranslation({ x: 0, y: -50, z: 0 }, true);
  }

  #enter(state) {
    const C = this.character;
    this.state = state;
    this.stateTime = 0;
    this.hitDone = false;
    switch (state) {
      case 'move': C.play(null, { fade: 0.25 }); break;
      case 'jump': C.play(this.jumpKind === 'run' ? 'run_jump' : 'jump_start', { fade: 0.08 }); this.tookOff = false; break;
      case 'air': {
        // the flight clip is stretched to the time left in the air (ballistic estimate)
        const name = this.jumpKind === 'run' ? 'run_air' : this.jumpKind === 'stand' ? 'jump_air' : 'fall';
        const dur = C.actions[name]?.clipMeta?.duration ?? 0.4;
        const left = Math.max(0.25, (Math.max(this.vy, 0) + Math.sqrt(this.vy * this.vy + 2 * GRAVITY * Math.max(0, this.pos.y - this.takeoffY))) / GRAVITY);
        C.play(name, { fade: 0.12, timeScale: name === 'fall' ? 1 : THREE.MathUtils.clamp(dur / left, 0.6, 1.6) });
        break;
      }
      case 'land': {
        const run = Math.hypot(this.vel.x, this.vel.z) > 2.5;
        this.landKind = run ? 'run' : 'stand';
        C.play(run ? 'run_land' : 'land', { fade: 0.05, timeScale: run ? 1.15 : 1.2 });
        break;
      }
      case 'kneel_down': C.play('kneel_down', { fade: 0.25, timeScale: 1.45 }); break;
      case 'kneel': C.play('kneel', { fade: 0.3 }); break;
      case 'kneel_up': C.play('kneel_up', { fade: 0.2, timeScale: 1.5 }); break;
      case 'punch': C.play(this.punchSide === 'l' ? 'punch_l' : 'punch_r', { fade: 0.1, timeScale: 1.1 }); break;
      case 'combat': C.play('combat_idle', { fade: 0.2 }); break;
      case 'block': C.play('block', { fade: 0.12 }); break;
    }
  }

  /** Can the character take a new action (punch/jump/kneel) right now? */
  get busy() { return ['jump', 'air', 'land', 'kneel_down', 'kneel', 'kneel_up'].includes(this.state); }

  /**
   * Fixed-step update. `c`: { forward, right (−1..1), run, jump, kneel, punch, block (bools; jump/kneel/punch
   * are edge-triggered), camYaw (camera heading, radians) }.
   */
  step(dt, c) {
    if (!this.active) return;
    this.prev.copy(this.pos);
    this.stateTime += dt;
    this.sinceTakeoff += dt;
    const C = this.character;
    const meta = (n) => C.actions[n]?.clipMeta ?? {};

    // ---- desired horizontal motion (camera relative)
    const fwd = _v.set(-Math.sin(c.camYaw), 0, -Math.cos(c.camYaw));
    const right = _w.set(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3().addScaledVector(fwd, c.forward).addScaledVector(right, c.right);
    const hasInput = wish.lengthSq() > 0.01;
    if (hasInput) wish.normalize();

    // ---- state transitions
    const S = this.state;
    if (S === 'move') {
      if (c.jump && this.grounded) this.#startJump();
      else if (c.kneel && this.grounded) this.#enter('kneel_down');
      else if (c.punch && this.grounded) this.#startPunch(c.camYaw);
      else if (c.block && this.grounded) this.#enter('block');
      else if (!this.grounded && this.airTime > 0.25) { this.jumpKind = 'fall'; this.takeoffY = this.pos.y; this.airCap = Math.hypot(this.vel.x, this.vel.z); this.#enter('air'); }
    } else if (S === 'jump') {
      const clip = this.jumpKind === 'run' ? 'run_jump' : 'jump_start';
      const takeoff = meta(clip).events?.takeoff ?? 0.1;
      if (!this.tookOff && this.stateTime >= takeoff * 0.85) {
        this.vy = this.jumpVy; this.grounded = false; this.tookOff = true; this.takeoffY = this.pos.y; this.sinceTakeoff = 0;
        const sp = Math.hypot(this.vel.x, this.vel.z), f = { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
        // a standing jump still hops a little forward; clearing a hurdle needs some forward speed
        const minFwd = this.hurdle ? 2.4 : 0.9;
        if (sp < minFwd) { this.vel.x += f.x * (minFwd - sp); this.vel.z += f.z * (minFwd - sp); }
        this.airCap = Math.hypot(this.vel.x, this.vel.z);
      }
      if (this.tookOff && this.stateTime > takeoff + 0.12 && this.grounded) this.#enter('land');
      else if (this.stateTime >= (meta(clip).duration ?? 0.15) - 0.02) this.#enter('air');
    } else if (S === 'air') {
      if (this.grounded && this.sinceTakeoff > 0.15) this.#enter('land');
      else if (this.jumpKind !== 'fall' && this.airTime > 1.1) { this.jumpKind = 'fall'; this.#enter('air'); } // long drop
    } else if (S === 'land') {
      const run = this.landKind === 'run';
      const end = (meta(run ? 'run_land' : 'land').duration ?? 0.4) / (run ? 1.15 : 1.2);
      if ((hasInput && this.stateTime > (run ? 0.1 : 0.2)) || this.stateTime > end - 0.08) this.#enter('move');
    } else if (S === 'kneel_down') {
      if (this.stateTime >= (meta('kneel_down').duration ?? 1.5) / 1.45 - 0.15) this.#enter('kneel');
    } else if (S === 'kneel') {
      if (c.kneel || hasInput || c.jump) this.#enter('kneel_up');
    } else if (S === 'kneel_up') {
      if (this.stateTime >= (meta('kneel_up').duration ?? 1.3) / 1.5 - 0.15) this.#enter('move');
    } else if (S === 'punch') {
      const name = this.punchSide === 'l' ? 'punch_l' : 'punch_r';
      const m = meta(name), ts = 1.1;
      const hitT = (m.events?.hit ?? 0.22) / ts;
      if (!this.hitDone && this.stateTime >= hitT) { this.hitDone = true; this.#hitTest(); }
      if (c.punch) this.queue = 'punch'; // buffered: chains into the other hand after the impact
      if (c.block) this.queue = 'block';
      const end = (m.duration ?? 0.53) / ts;
      const chain = Math.min(hitT + 0.14, end - 0.1); // the other hand goes as this one recovers
      if (this.stateTime >= chain && this.queue === 'punch') { this.queue = null; this.#startPunch(c.camYaw); }
      else if (this.stateTime >= end - 0.08) { const q = this.queue; this.queue = null; this.#enter(q === 'block' ? 'block' : 'combat'); }
    } else if (S === 'combat') {
      if (c.punch) this.#startPunch(c.camYaw);
      else if (c.block) this.#enter('block');
      else if (c.jump && this.grounded) this.#startJump();
      else if (hasInput && this.stateTime > 0.15) this.#enter('move');
      else if (this.stateTime > 4) this.#enter('move');
    } else if (S === 'block') {
      if (!c.block) this.#enter('combat');
    }

    // ---- speed and facing
    const canMove = this.state === 'move' || this.state === 'jump' || this.state === 'air' || (this.state === 'land' && (this.landKind === 'run' || this.stateTime > 0.12));
    const target = canMove && hasInput ? (c.run ? RUN_SPEED : WALK_SPEED) : 0;
    const airborne = this.state === 'air' || (this.state === 'jump' && this.tookOff);
    if (airborne) {
      // limited air control: keep momentum, steer a little, never faster than at take-off
      const cap = Math.max(this.airCap ?? 0, WALK_SPEED);
      this.vel.addScaledVector(wish, 3 * dt);
      const sp = this.vel.length();
      if (sp > cap) this.vel.multiplyScalar(cap / sp);
    } else {
      const cur = this.vel.length();
      const accel = target > cur ? (c.run ? 9 : 7) : (this.state === 'land' ? 18 : 11);
      const next = cur + THREE.MathUtils.clamp(target - cur, -accel * dt, accel * dt);
      if (hasInput && canMove) {
        // turn toward the input direction, slower at speed (body inertia)
        const want = Math.atan2(-wish.x, -wish.z);
        let d = want - this.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const rate = next > 3 ? 7 : 11;
        this.yaw += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
        // velocity follows facing (no moonwalking while turning around)
        const along = Math.max(0, Math.cos(d));
        this.vel.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).multiplyScalar(next * (0.35 + 0.65 * along));
      } else {
        this.vel.multiplyScalar(cur > 1e-4 ? next / cur : 0);
      }
    }
    if (this.state === 'punch' || this.state === 'combat' || this.state === 'block') {
      // fighting: face where the camera looks
      let d = c.camYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += THREE.MathUtils.clamp(d, -12 * dt, 12 * dt);
    }

    // ---- vertical
    if (this.grounded && this.vy <= 0) this.vy = -2; // keeps the controller snapped
    else this.vy -= GRAVITY * dt;

    // ---- collide and slide (lifting onto a curb / low step first when one is right ahead)
    const step = airborne ? null : this.#stepUp();
    const desired = { x: this.vel.x * dt + (step?.px ?? 0), y: this.vy * dt + (step?.lift ?? 0), z: this.vel.z * dt + (step?.pz ?? 0) };
    this.kcc.computeColliderMovement(this.collider, desired, this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS);
    const m = this.kcc.computedMovement();
    // horizontal contacts this step (curb faces, walls): where a step-up probe should look next time
    this.walls.length = 0;
    for (let i = 0; i < this.kcc.numComputedCollisions(); i++) {
      const n = this.kcc.computedCollision(i)?.normal1;
      if (n && Math.abs(n.y) < 0.6) { const l = Math.hypot(n.x, n.z) || 1; this.walls.push({ x: n.x / l, z: n.z / l }); }
    }
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    // just after take-off the controller can still report ground contact: keep the jump going
    if (this.grounded && this.vy > 0 && this.sinceTakeoff > 0.2) this.vy = 0;
    if (!this.grounded && wasGrounded && this.vy < 0) this.vy = 0;
    if (!this.grounded) this.airTime += dt; else this.airTime = 0;
    // blocked horizontally on the ground: lose that velocity (walking into a wall does not keep
    // accelerating). In the air the momentum is kept, so a jump at a hurdle carries over its top.
    if (dt > 0 && !airborne) {
      const ax = m.x / dt, az = m.z / dt;
      if (Math.hypot(ax, az) < this.vel.length() * 0.6) this.vel.set(ax, 0, az);
    }
    if (this.vy > 0 && desired.y > 1e-4 && m.y < desired.y * 0.5) this.vy = 0; // head hit something above
    const t = this.body.translation();
    const nx = t.x + m.x, nz = t.z + m.z;
    let ny = t.y + m.y;
    // stand on the highest support under the footprint (a curb under the edge of the feet holds
    // you up, as it would a person) and never inside a surface
    if (this.vy <= 0 && this.sinceTakeoff > 0.15) {
      const feet = ny - CENTER_Y;
      const top = this.#support(nx, nz, feet);
      if (top !== null && top > feet + 0.004) { ny += top - feet; this.grounded = true; this.vy = 0; this.airTime = 0; }
    }
    // visual smoothing of steps up and down (the capsule pops; the body eases over ~0.1 s)
    const rise = ny - CENTER_Y - this.pos.y;
    if (!airborne && Math.abs(rise) > 0.03 && Math.abs(rise) <= MAX_STEP + 0.05) this.stepOffset -= rise;
    this.stepOffset *= Math.exp(-dt * 15);
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.pos.set(nx, ny - CENTER_Y, nz);
  }

  /** Highest walkable surface within a step above the feet, under the capsule's footprint (or null). */
  #support(x, z, feet) {
    let best = null;
    const r = 0.22, f = { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
    for (const [ox, oz] of [[0, 0], [f.x, f.z], [-f.x, -f.z], [-f.z, f.x], [f.z, -f.x]]) {
      const g = this.#ground(x + ox * r, z + oz * r, feet + MAX_STEP, MAX_STEP + 0.06);
      if (!g || g.toi < 1e-3 || g.ny < 0.7) continue;
      if (best === null || g.y > best) best = g.y;
    }
    return best;
  }

  /** Ground below (x, z) by a ray from height `top` down `depth`: { y, ny (normal.y), toi } or null. */
  #ground(x, z, top, depth) {
    const R = this.physics.R;
    const hit = this.physics.world.castRayAndGetNormal(new R.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }), depth, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.collider);
    return hit ? { y: top - hit.timeOfImpact, ny: hit.normal.y, toi: hit.timeOfImpact } : null;
  }

  /**
   * Walking into a curb, kerb or step up to MAX_STEP high: how far to lift the capsule this step.
   * The probe just ahead of the feet must find a walkable top; a ray that starts inside something
   * (toi 0) means a wall or a box taller than a step, which blocks as usual.
   */
  #stepUp() {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (!this.grounded || sp < 0.05) return null;
    const dx = this.vel.x / sp, dz = this.vel.z / sp, feet = this.pos.y;
    const out = { lift: 0, px: 0, pz: 0 };
    // probe straight ahead, and into anything the capsule is pressing against (a curb met at a
    // shallow angle is beside the feet, not ahead of them: step onto it sideways)
    const dirs = [[dx, dz, CAPSULE.radius + 0.04, 0], [dx, dz, CAPSULE.radius + 0.14, 0]];
    for (const n of this.walls) if (-(n.x * dx + n.z * dz) > 0.15) dirs.push([-n.x, -n.z, CAPSULE.radius + 0.06, 0.1]);
    for (const [ux, uz, d, push] of dirs) {
      const g = this.#ground(this.pos.x + ux * d, this.pos.z + uz * d, feet + MAX_STEP + 0.02, MAX_STEP + 0.3);
      if (!g || g.toi < 1e-3 || g.ny < 0.7) continue;
      const rise = g.y - feet;
      if (rise > 0.02 && rise <= MAX_STEP && rise + 0.01 >= out.lift) {
        out.lift = rise + 0.01;
        out.px = ux * push; out.pz = uz * push;
      }
    }
    return out.lift ? out : null;
  }

  /**
   * Space: a standing hop or (when running) a leap. In front of a low wall or planter the jump
   * gets the height to clear it (ballistic), like a context vault.
   */
  #startJump() {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.jumpKind = sp > 3.2 ? 'run' : 'stand';
    this.jumpVy = this.jumpKind === 'run' ? RUN_JUMP_SPEED : JUMP_SPEED;
    this.hurdle = 0;
    const f = { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
    for (const d of [0.45, 0.7, 0.95, 1.2]) {
      const g = this.#ground(this.pos.x + f.x * d, this.pos.z + f.z * d, this.pos.y + MAX_HURDLE + 0.3, MAX_HURDLE + 0.5);
      if (!g || g.toi < 1e-3) continue; // taller than a hurdle (or a ceiling)
      const h = g.y - this.pos.y;
      if (h > MAX_STEP && h <= MAX_HURDLE) this.hurdle = Math.max(this.hurdle, h);
    }
    if (this.hurdle) this.jumpVy = Math.max(this.jumpVy, Math.sqrt(2 * GRAVITY * (this.hurdle + 0.35)));
    this.#enter('jump');
  }

  #startPunch(camYaw) {
    this.punchSide = this.state === 'punch' || (this.state === 'combat' && this.stateTime < PUNCH_COMBO_WINDOW)
      ? (this.punchSide === 'l' ? 'r' : 'l') : 'l';
    this.yawTarget = camYaw;
    this.state = null;
    this.#enter('punch');
  }

  /** At the moment of impact: a sphere around the punching fist against the world. */
  #hitTest() {
    const R = this.physics.R;
    const C = this.character;
    C.root.updateMatrixWorld(true);
    const fist = C.bonePosition(this.punchSide === 'l' ? 'Bip01_L_Hand' : 'Bip01_R_Hand', new THREE.Vector3());
    // a little ahead of the fist along the facing, at the moment of extension
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    fist.addScaledVector(f, 0.08);
    const ball = new R.Ball(0.17);
    const found = [];
    this.physics.world.intersectionsWithShape(fist, { x: 0, y: 0, z: 0, w: 1 }, ball, (col) => {
      if (col.handle !== this.collider.handle) found.push(col);
      return true;
    }, R.QueryFilterFlags.EXCLUDE_SENSORS);
    const hit = { t: performance.now(), side: this.punchSide, pos: fist.toArray(), targets: found.map((c) => (c.parent()?.isDynamic() ? 'dynamic' : c.parent()?.isKinematic() ? 'kinematic' : 'static')) };
    for (const col of found) {
      const b = col.parent();
      if (b?.isDynamic()) b.applyImpulseAtPoint({ x: f.x * 260, y: 30, z: f.z * 260 }, { x: fist.x, y: fist.y, z: fist.z }, true);
    }
    this.hits.push(hit);
    if (this.hits.length > 20) this.hits.shift();
    this.onHit?.(hit);
  }

  /** Interpolated visual pose; `alpha` = fraction between the last two physics steps. */
  sync(alpha, dt) {
    if (!this.active) return;
    this.render.lerpVectors(this.prev, this.pos, alpha);
    this.render.y += this.stepOffset;
    this.character.setPose(this.render, this.yaw);
    const speed = this.state === 'move' || this.state === 'land' ? Math.hypot(this.vel.x, this.vel.z) : 0;
    this.character.update(dt, { speed });
  }

  /** Feet position + facing for the camera. */
  get head() { return this.render; }
}
