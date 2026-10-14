import * as THREE from 'three';
import { ASSET_ROOT } from '../config.js';

const _v = new THREE.Vector3();

/**
 * Playable human: the Rocketbox "Male_Adult_05" avatar (MIT) with motion-captured clips built by
 * tools/build_character.py. This class owns the visual model, the animation mixer and the
 * per-clip metadata; gameplay (movement, states) lives in OnFoot / the vehicle seat logic.
 *
 * Locomotion is a 1-D blend space (idle → walk → run) driven by the real ground speed. The
 * natural speed and foot-contact phase of every cycle are measured from the clips themselves, so
 * playback rate follows the movement speed and walk/run stay in step while blending (no sliding).
 */
export class Character {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.root = new THREE.Group(); // feet on the ground, faces -Z (like the car)
    this.root.name = 'player-character';
    this.root.visible = false;
    scene.add(this.root);
    this.actions = {};
    this.layer = { name: null };   // current non-locomotion action
    this.loco = { phase: 0, speed: 0, weight: 1 };
    this.blink = { t: 2.5, phase: -1 };
    this.headScale = 1;
  }

  async load() {
    const [gltf, meta] = await Promise.all([
      this.assets.gltf('models/character/character.glb'),
      fetch(`${ASSET_ROOT}models/character/character.json`).then((r) => r.json()),
    ]);
    this.meta = meta;
    const model = gltf.scene;
    model.rotation.y = Math.PI; // the export faces +Z
    this.model = model;
    this.root.add(model);
    this.meshes = []; // one skinned mesh per material (skin, clothes, hair) sharing the skeleton
    model.traverse((o) => {
      if (o.isSkinnedMesh) {
        this.meshes.push(o);
        this.mesh ??= o;
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false; // skinned bounds are the bind pose; the character is always near the camera
      }
      if (o.isBone) (this.bones ??= {})[o.name] = o;
    });
    this.#materials();
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      // drop scale tracks (all 1) and keep the per-bone rotations + pelvis translation
      clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.scale') && (!t.name.endsWith('.position') || t.name.startsWith('Bip01_Pelvis')));
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[clip.name] = a;
      a.clipMeta = meta.clips[clip.name] ?? {};
      if (!a.clipMeta.loop) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    }
    this.#measureCycles();
    this.blinkers = this.meshes.filter((m) => m.morphTargetDictionary && 'blinkL' in m.morphTargetDictionary);
    this.headBone = this.bones.Bip01_Head;
    this.actions.idle.setEffectiveWeight(1);
  }

  /** Physically based materials tuned for the game's lighting. */
  #materials() {
    for (const mesh of this.meshes) {
      const src = mesh.material;
      const mats = Array.isArray(src) ? src : [src];
      const out = mats.map((m) => this.#upgrade(m));
      for (const m of mats) m.dispose();
      mesh.material = Array.isArray(src) ? out : out[0];
      for (const m of out) for (const k of ['map', 'normalMap', 'roughnessMap']) if (m[k]) m[k].anisotropy = Math.min(8, this.assets.maxAnisotropy ?? 8);
    }
  }

  /** Physically based material for one part of the avatar. */
  #upgrade(m) {
    if (m.name === 'skin') {
      // skin: lower F0 (≈0.028) and a soft red sheen at grazing angles as a cheap subsurface cue
      return new THREE.MeshPhysicalMaterial({
        name: 'skin', map: m.map, normalMap: m.normalMap, normalScale: new THREE.Vector2(0.9, 0.9),
        roughnessMap: m.roughnessMap, roughness: 1, metalness: 0, specularIntensity: 0.65,
        sheen: 0.35, sheenColor: new THREE.Color(0.75, 0.32, 0.22), sheenRoughness: 0.65, envMapIntensity: 0.75,
      });
    }
    if (m.name === 'hair') {
      // hair cards, beard, brows and lashes: alpha-tested with alpha-to-coverage (MSAA) for soft edges
      return new THREE.MeshStandardMaterial({
        name: 'hair', map: m.map, alphaTest: 0.45, alphaToCoverage: true, transparent: false, side: THREE.DoubleSide,
        roughness: 0.8, metalness: 0, envMapIntensity: 0.35, // a glossier value lights the cards up as white streaks in sun
      });
    }
    return new THREE.MeshPhysicalMaterial({
      name: 'clothes', map: m.map, normalMap: m.normalMap, roughnessMap: m.roughnessMap, roughness: 1, metalness: 0,
      sheen: 0.5, sheenColor: new THREE.Color(0.35, 0.35, 0.35), sheenRoughness: 0.8, envMapIntensity: 0.6,
    });
  }

  /**
   * For the locomotion cycles: natural ground speed (foot velocity during stance) and the phase of
   * left-foot contact, sampled from the clip by posing the skeleton.
   */
  #measureCycles() {
    const foot = { L: this.bones.Bip01_L_Foot, R: this.bones.Bip01_R_Foot };
    this.cycles = {};
    for (const name of ['walk', 'run']) {
      const a = this.actions[name];
      const T = a.getClip().duration;
      const N = 60;
      const samples = { L: [], R: [] };
      for (const k of Object.keys(this.actions)) this.actions[k].setEffectiveWeight(k === name ? 1 : 0);
      for (let i = 0; i < N; i++) {
        a.time = (i / N) * T;
        this.mixer.update(0);
        this.model.updateMatrixWorld(true);
        for (const s of ['L', 'R']) {
          const p = foot[s].getWorldPosition(_v);
          const local = this.root.worldToLocal(p.clone());
          samples[s].push({ y: local.y, z: local.z });
        }
      }
      // stance = lowest 40% of the foot height; speed = rate the foot moves backward then
      let speed = 0, n = 0, contactL = 0, minY = Infinity;
      for (const s of ['L', 'R']) {
        const ys = samples[s].map((q) => q.y).sort((x, y) => x - y);
        const cut = ys[Math.floor(N * 0.4)];
        for (let i = 0; i < N; i++) {
          const a0 = samples[s][i], a1 = samples[s][(i + 1) % N];
          if (a0.y <= cut && a1.y <= cut) { speed += (a1.z - a0.z) / (T / N); n++; }
          if (s === 'L' && a0.y < minY) { minY = a0.y; contactL = i / N; }
        }
      }
      // natural speed from the clip's extracted root travel (exact); foot-based estimate as a fallback
      const natural = a.clipMeta.speed ?? Math.abs(speed / Math.max(1, n));
      this.cycles[name] = { duration: T, speed: natural, footSpeed: Math.abs(speed / Math.max(1, n)), contactL };
      a.time = 0;
    }
    for (const k of Object.keys(this.actions)) this.actions[k].setEffectiveWeight(0);
  }

  /**
   * Blend the locomotion cycles for a ground speed (m/s). `weight` scales the whole locomotion layer
   * (it fades out while an action such as a punch or a jump plays).
   */
  #locomotion(dt, speed, weight) {
    const W = this.cycles.walk, R = this.cycles.run;
    const a = this.actions;
    // blend weights: idle → walk (0..walk speed), walk → run (walk..run speed)
    let wi, ww, wr;
    if (speed <= W.speed) { const t = THREE.MathUtils.clamp(speed / (W.speed * 0.6), 0, 1); wi = 1 - t; ww = t; wr = 0; }
    else { const t = THREE.MathUtils.clamp((speed - W.speed) / (R.speed - W.speed), 0, 1); wi = 0; ww = 1 - t; wr = t; }
    // distance covered per cycle interpolates between the two clips; phase advances with real speed
    const dist = THREE.MathUtils.lerp(W.speed * W.duration, R.speed * R.duration, wr);
    const moving = Math.max(speed, ww > 0 || wr > 0 ? W.speed * 0.5 : 0);
    this.loco.phase = (this.loco.phase + (moving * dt) / dist) % 1;
    const ph = this.loco.phase;
    a.walk.time = (((ph + W.contactL) % 1) * W.duration);
    a.run.time = (((ph + R.contactL) % 1) * R.duration);
    a.walk.timeScale = a.run.timeScale = 0; // driven manually
    a.idle.setEffectiveWeight(wi * weight);
    a.walk.setEffectiveWeight(ww * weight);
    a.run.setEffectiveWeight(wr * weight);
    this.loco.weights = { idle: wi, walk: ww, run: wr };
  }

  /**
   * Play a one-shot or looping action over locomotion (cross-fade `fade` seconds). Returns the action.
   * Passing null fades back to locomotion.
   */
  play(name, { fade = 0.2, timeScale = 1, from = 0 } = {}) {
    const prev = this.layer;
    if (prev.name === name && name) return this.actions[name];
    const next = name ? this.actions[name] : null;
    if (next) {
      next.reset();
      next.time = from;
      next.timeScale = timeScale;
      next.setEffectiveWeight(0);
    }
    this.layer = { name, action: next, prevAction: prev.action ?? null, fade, t: 0, prevWeight: prev.weight ?? 0 };
    return next;
  }

  /** Normalised progress (0..1) of the current layered action. */
  progress() {
    const a = this.layer.action;
    return a ? a.time / a.getClip().duration : 0;
  }

  update(dt, { speed = 0 } = {}) {
    if (!this.mixer) return;
    const L = this.layer;
    // cross-fade layer in, previous layer out; locomotion takes what is left
    L.t += dt;
    const k = L.fade > 0 ? Math.min(1, L.t / L.fade) : 1;
    const e = k * k * (3 - 2 * k);
    if (L.action) L.action.setEffectiveWeight(e);
    if (L.prevAction && L.prevAction !== L.action) L.prevAction.setEffectiveWeight((1 - e) * L.prevWeight);
    if (k >= 1 && L.prevAction && L.prevAction !== L.action) { L.prevAction.setEffectiveWeight(0); L.prevAction = null; }
    L.weight = L.action ? e : 0;
    const prevLayer = L.prevAction ? (1 - e) * L.prevWeight : 0;
    this.#locomotion(dt, speed, Math.max(0, 1 - (L.action ? e : 0) - prevLayer));
    this.mixer.update(dt);
    this.#blink(dt);
    if (this.headBone && this.headScale !== 1) this.headBone.scale.setScalar(this.headScale);
  }

  #blink(dt) {
    const B = this.blink;
    let v = 0;
    if (B.phase < 0) {
      B.t -= dt;
      if (B.t <= 0) B.phase = 0;
    } else {
      B.phase += dt / 0.16;
      v = B.phase < 0.5 ? B.phase * 2 : Math.max(0, 2 - B.phase * 2);
      if (B.phase >= 1) { B.phase = -1; B.t = 1.5 + Math.random() * 4.5; v = 0; }
    }
    for (const m of this.blinkers) {
      const d = m.morphTargetDictionary;
      m.morphTargetInfluences[d.blinkL] = m.morphTargetInfluences[d.blinkR] = v;
    }
  }

  /** World position of a bone (e.g. 'Bip01_R_Hand'). */
  bonePosition(name, out = new THREE.Vector3()) {
    return this.bones[name].getWorldPosition(out);
  }

  setPose(pos, yaw) {
    this.root.position.copy(pos);
    this.root.quaternion.setFromAxisAngle(_v.set(0, 1, 0), yaw);
  }
}
