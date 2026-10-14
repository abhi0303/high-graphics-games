import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createRenderer, PostFX } from './core/renderer.js';
import { Assets } from './core/assets.js';
import { Input } from './core/input.js';
import { Environment } from './world/environment.js';
import { City } from './world/city.js';
import { CAR_START } from './world/layout.js';
import { Physics, Vehicle } from './vehicle/physics.js';
import { Car } from './vehicle/car.js';
import { CameraRig, PRESETS } from './camera/cameraRig.js';
import { Hud } from './ui/hud.js';
import { ReflectionProbe } from './vehicle/reflectionProbe.js';
import { RearViewMirror } from './vehicle/mirror.js';
import { SkidMarks } from './vehicle/skidMarks.js';
import { loadTrafficModels } from './traffic/trafficModels.js';
import { Traffic } from './traffic/traffic.js';
import { Character } from './character/character.js';
import { OnFoot } from './character/onFoot.js';
import { Player } from './character/player.js';
import { Drivable } from './vehicle/drivable.js';
import { ASSET_ROOT } from './config.js';

const loadingEl = document.getElementById('loading');
const fillEl = document.getElementById('loading-fill');
const statusEl = document.getElementById('loading-status');
let stageProgress = 0;
const status = (text, p) => {
  statusEl.textContent = text;
  if (p !== undefined) stageProgress = p;
  fillEl.style.width = `${Math.round(stageProgress * 100)}%`;
};

async function main() {
  if (CONFIG.capture) document.body.classList.add('capture');

  const renderer = createRenderer(document.getElementById('app'));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.25, 9000);

  const assets = new Assets(renderer, (p, url) => status(`Loading ${url.split('/').pop()}`, 0.05 + p * 0.75));
  const physics = await Physics.create(CONFIG.physicsHz);

  status('Sky & sun', 0.02);
  const env = new Environment(scene, renderer);
  const city = new City(scene, assets, physics, renderer);
  const car = new Car(scene, assets);
  const character = new Character(scene, assets);
  await Promise.all([env.load(assets), city.build((t) => status(t)), car.load(), character.load()]);

  const vehicle = new Vehicle(physics, CAR_START);

  // Local reflections for the car: buildings, streets, signals and sky (no foliage / litter).
  const probe = new ReflectionProbe(renderer, scene, 256);
  for (const name of ['buildings', 'skyline', 'props', 'ground', 'sidewalks', 'curbs', 'road-paint', 'hills', 'haze-dome', 'clouds']) {
    scene.children.filter((o) => o.name === name).forEach((o) => ReflectionProbe.include(o));
  }
  car.setEnvMap(probe.texture);
  const skids = new SkidMarks(scene, city.materials.noise);
  const mirror = new RearViewMirror(car, renderer, scene);

  // AI traffic (models listed in public/assets/models/traffic/manifest.json)
  let traffic = null;
  if (CONFIG.traffic > 0) {
    status('Traffic');
    const manifest = await fetch(`${ASSET_ROOT}models/traffic/manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const models = manifest ? await loadTrafficModels(assets, manifest.vehicles.map((v) => v.slug)) : [];
    if (models.length) {
      traffic = new Traffic(scene, physics, models, { signals: city.props, player: vehicle, count: CONFIG.traffic });
      RearViewMirror.include(traffic.group);
    }
  }
  const probePos = new THREE.Vector3();
  const rig = new CameraRig(camera, physics);
  rig.setPreset(PRESETS[CONFIG.view] ?? PRESETS.reference);

  const post = new PostFX(renderer, scene, camera);
  post.grade.set('exposure', env.exposure);
  post.grade.set('whiteBalance', [1.04, 1.0, 0.93]);
  post.grade.set('saturation', 1.02);
  post.grade.set('contrast', 1.05);
  console.info(`sky avg ${env.skyAvg.toFixed(3)}, sun ${env.sun.intensity.toFixed(2)}, exposure ${env.exposure.toFixed(3)}`);
  if (new URLSearchParams(location.search).has('nopost')) {
    // Debug path: plain forward render with built-in tone mapping.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.autoClear = true; // the EffectComposer disables autoClear; a raw render must clear itself
    post.render = () => renderer.render(scene, camera);
  }
  const hud = new Hud();
  const input = new Input(renderer.domElement);
  const onFoot = new OnFoot(physics, character);
  if (traffic) traffic.pedestrian = onFoot; // AI drivers stop for the player on foot
  input.on('KeyH', () => hud.toggleHelp());
  input.on('KeyF', () => hud.toggleStats());
  input.on('KeyU', () => hud.toggleUnits());

  // Let the car settle on its suspension before the first frame.
  const noInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  // (in capture mode traffic stays at its spawn points, away from the reference framing)
  for (let i = 0; i < CONFIG.physicsHz * 1.5; i++) {
    vehicle.update(physics.dt, noInput);
    if (!CONFIG.capture) traffic?.step(physics.dt);
    physics.step();
  }

  // Every car the player can drive is a Drivable (physics + interpolated visual); the Ferrari first.
  const ferrari = new Drivable({ kind: 'ferrari', vehicle, root: car.root, car });
  const player = new Player({ ferrari, traffic, scene, character, onFoot, rig, hud, input });
  input.on('KeyC', () => { rig.setPreset(null); hud.flashCamera(rig.cycle(player.current, character)); });
  input.on('KeyR', () => {
    if (player.mode !== 'driving') return;
    const v = player.vehicle;
    if (player.current === ferrari) v.reset(CAR_START);
    else { const t = v.body.translation(); v.reset({ x: t.x, z: t.z, heading: v.heading() }); } // back on its wheels
  });
  input.on('KeyL', () => hud.flashCamera(car.cycleHeadlights()));

  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  const syncVisuals = (alpha, dt, mouse) => {
    for (const d of player.drivables) d.interpolate(alpha, dt);
    player.sync(alpha, dt);
    // in the driver view the car's paint is barely visible: refresh its reflections less often
    const probed = probe.update(probePos.copy(ferrari.renderPos).add(new THREE.Vector3(0, 0.9, 0)), car.root, rig.isCockpit ? 5 : 3);
    const free = window.__freeCam; // debug hook: { pos: [x,y,z], look: [x,y,z], fov }
    if (free) {
      camera.position.fromArray(free.pos);
      camera.lookAt(new THREE.Vector3().fromArray(free.look));
      if (free.fov && camera.fov !== free.fov) { camera.fov = free.fov; camera.updateProjectionMatrix(); }
    } else rig.update(dt, player.current, player.vehicle, mouse, player.mode === 'driving' ? null : onFoot);
    mirror.update(camera, probed);
    const focus = new THREE.Vector3().copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize(), 38);
    env.update(focus);
    env.dome?.position.copy(camera.position);
    if (env.cloudDome) {
      env.cloudDome.position.copy(camera.position);
      env.cloudDome.material.uniforms.uTime.value += dt;
    }
    city.update(dt, camera);
    traffic?.render(camera);
  };

  status('Compiling shaders', 0.9);
  syncVisuals(1, 1 / 60, null);
  await renderer.compileAsync(scene, camera);
  post.render(1 / 60);

  hud.show();
  loadingEl.classList.add('done');
  setTimeout(() => loadingEl.remove(), 900);

  // Dynamic resolution: only when frame time demands it (never in capture mode).
  // Resizing reallocates the canvas (which clears it), so a change is applied right
  // before a frame is rendered, never after; otherwise a blank frame gets presented.
  // Strong hysteresis prevents ping-ponging between two levels (which read as blinking).
  const res = {
    max: Math.min(window.devicePixelRatio, CONFIG.quality.pixelRatio),
    min: Math.min(window.devicePixelRatio, CONFIG.quality.pixelRatio) * 0.6,
    pr: renderer.getPixelRatio(),
    t: 0, frames: 0, settle: 3, slow: 0, fast: 0, lastDown: -Infinity, clock: 0,
  };
  const adaptResolution = (dt) => {
    if (CONFIG.capture) return;
    res.clock += dt;
    res.t += dt; res.frames++;
    if (res.t < 2) return;
    const fps = res.frames / res.t;
    res.t = 0; res.frames = 0;
    if (res.settle-- > 0) return; // ignore the first seconds (shader warm-up, texture uploads)
    res.slow = fps < 45 ? res.slow + 1 : 0;
    res.fast = fps > 58 ? res.fast + 1 : 0;
    let next = res.pr;
    if (res.slow >= 2) { next = Math.max(res.min, res.pr - 0.125); res.lastDown = res.clock; res.slow = 0; }
    // only climb back after a long stretch of headroom, and never soon after dropping
    else if (res.fast >= 8 && res.clock - res.lastDown > 30 && res.pr < res.max) { next = Math.min(res.max, res.pr + 0.125); res.fast = 0; }
    if (next !== res.pr) {
      res.pr = next;
      renderer.setPixelRatio(next);
      post.setSize(window.innerWidth, window.innerHeight);
      (window.__resEvents ??= []).push({ t: +res.clock.toFixed(1), pr: next, fps: +fps.toFixed(1) });
    }
  };
  hud.resolution = () => res.pr;

  let acc = 0;
  let last = performance.now();
  let frame = 0;
  window.__game = { THREE, scene, camera, renderer, vehicle, rig, post, env, city, car, physics, skids, traffic, mirror, character, onFoot, player };
  if (new URLSearchParams(location.search).has('onfoot')) player.exitVehicle();

  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const controls = CONFIG.capture ? noInput : input.controls();
    acc += dt;
    let steps = 0;
    while (acc >= physics.dt && steps < 12) {
      for (const d of player.drivables) d.vehicle.update(physics.dt, player.vehicleControls(controls, d));
      player.step(physics.dt);
      if (traffic && !CONFIG.capture) traffic.step(physics.dt);
      physics.step();
      for (const d of player.drivables) d.capture();
      acc -= physics.dt;
      steps++;
    }
    if (steps === 12) acc = 0;
    if (steps > 0) skids.update(dt, player.vehicle);
    const mouse = CONFIG.capture ? null : input.consumeMouse();
    syncVisuals(acc / physics.dt, dt, mouse);
    adaptResolution(dt); // before rendering: a resize clears the canvas
    renderer.info.reset();
    post.render(dt);
    hud.update(dt, player.vehicle, renderer);
    frame++;
    if (frame === 30) window.__ready = true;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error(err);
  status(`Error: ${err.message}`);
  window.__error = String(err.stack || err);
});
