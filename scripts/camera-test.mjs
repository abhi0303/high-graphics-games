#!/usr/bin/env node
// Driver (first-person) camera test:
//  - C cycles Chase → Driver → … and every switch blends smoothly (no per-frame jumps, no path through the bodywork)
//  - the driver eye stays locked to the seat (moves with the chassis) and the near plane is restored outside it
//  - driving controls behave identically in the driver view (steer sign, throttle)
//  - mouse-look turns the head within limits and recentres
// Usage: node scripts/camera-test.mjs [--url http://localhost:5173/] [--out dir]
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url ?? 'http://localhost:5173/';
const out = args.out ?? 'camera-test';
mkdirSync(out, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 240000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 300)); });
await page.goto(`${url}?quality=${args.quality ?? 'high'}&traffic=${args.count ?? 12}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000 });
await page.focus('canvas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info)}`); ok &&= cond; };

// per-frame camera log in the car's local frame (and world frame), sampled after each render
await page.evaluate(() => {
  const g = window.__game;
  window.__camLog = [];
  const loop = () => {
    const c = g.camera, root = g.car.root;
    const local = root.worldToLocal(c.position.clone());
    window.__camLog.push({ t: performance.now(), w: c.position.toArray(), l: local.toArray(), fov: c.fov, near: c.near, blend: !!g.rig.blend, mode: g.rig.mode.name });
    if (window.__camLog.length > 4000) window.__camLog.shift();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const takeLog = () => page.evaluate(() => { const l = window.__camLog; window.__camLog = []; return l; });

// Is a camera point (car-local) inside the car's geometry? Cast 14 rays and count how many first hit a
// back face: from inside a closed shell (bodywork, seat, dashboard) nearly all of them do.
const countInside = (points) => page.evaluate((pts) => {
  const g = window.__game, THREE = g.THREE, root = g.car.root;
  root.updateMatrixWorld(true);
  const meshes = [], sides = [];
  root.traverse((o) => { if (o.isMesh && !o.material.transparent) { meshes.push(o); sides.push(o.material.side); o.material.side = THREE.DoubleSide; } });
  const dirs = [];
  for (const d of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[1,1,1],[1,1,-1],[1,-1,1],[1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,1],[-1,-1,-1]]) dirs.push(new THREE.Vector3(...d).normalize());
  const rc = new THREE.Raycaster(); rc.far = 6;
  const nW = new THREE.Vector3(), q = root.getWorldQuaternion(new THREE.Quaternion());
  let inside = 0; const worst = [];
  for (const p of pts) {
    const o = root.localToWorld(new THREE.Vector3(...p));
    let back = 0;
    for (const d of dirs) {
      const dw = d.clone().applyQuaternion(q);
      rc.set(o, dw);
      const h = rc.intersectObjects(meshes, false)[0];
      if (h && h.face) { nW.copy(h.face.normal).transformDirection(h.object.matrixWorld); if (nW.dot(dw) > 0) back++; }
    }
    if (back >= 10) { inside++; if (worst.length < 3) worst.push(p.map((v) => +v.toFixed(2))); }
  }
  meshes.forEach((m, i) => { m.material.side = sides[i]; });
  return { inside, worst };
}, points);

/** Press C and verify the blend is continuous and stays out of the bodywork. */
async function switchMode(label, shotsAt = []) {
  await takeLog();
  await page.keyboard.press('KeyC');
  const t0 = Date.now();
  for (const ms of shotsAt) {
    await sleep(Math.max(0, ms - (Date.now() - t0)));
    await page.screenshot({ path: `${out}/${label}-mid-${ms}.png` });
  }
  await sleep(1300 - (Date.now() - t0));
  const log = await takeLog();
  const blend = log.filter((f) => f.blend);
  let maxStep = 0, maxDt = 0, clip = 0;
  for (let i = 1; i < log.length; i++) {
    // world-frame step minus the car's own motion = camera motion relative to the car
    const a = log[i - 1].l, b = log[i].l;
    maxStep = Math.max(maxStep, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    maxDt = Math.max(maxDt, log[i].t - log[i - 1].t);
  }
  const ins = await countInside(log.map((f) => f.l));
  clip = ins.inside;
  const last = log[log.length - 1];
  const blendMs = blend.length > 1 ? blend[blend.length - 1].t - blend[0].t : 0;
  return { mode: last.mode, frames: log.length, blendFrames: blend.length, blendMs: Math.round(blendMs), maxStepPerFrame: +maxStep.toFixed(3), maxFrameMs: +maxDt.toFixed(1), clipFrames: clip, clipAt: ins.worst, final: last.l.map((v) => +v.toFixed(3)), near: last.near, fov: +last.fov.toFixed(1) };
}

// make sure we start in Chase without the reference preset
await page.evaluate(() => { const g = window.__game; g.rig.setPreset(null); });
await sleep(800);
await page.screenshot({ path: `${out}/0-chase.png` });

// 1) Chase → Driver
const toDriver = await switchMode('to-driver', [180, 380, 560]);
await page.screenshot({ path: `${out}/1-driver-parked.png` });
const EYE = await page.evaluate(() => window.__game.rig.mode.eye);
const eyeOk = Math.hypot(toDriver.final[0] - EYE[0], toDriver.final[1] - EYE[1], toDriver.final[2] - EYE[2]) < 0.06 && EYE[0] < 0 && EYE[1] > 0.95 && EYE[1] < 1.2;
check('C switches Chase → Driver', toDriver.mode === 'Driver', toDriver);
// time-based: the blend lasts its 0.75 s whatever the frame rate (a snap would be 1 frame)
check('transition is blended over ~0.75 s (no snap)', toDriver.blendFrames >= 8 && toDriver.blendMs > 550, { blendFrames: toDriver.blendFrames, blendMs: toDriver.blendMs });
// 0.75 s blend over ≈ 7 m: average 0.16 m per 60 Hz frame; anything above ~0.5 m in a frame would read as a jump
check('no per-frame jumps during the blend', toDriver.maxStepPerFrame < 0.5 * Math.max(1, toDriver.maxFrameMs / 16.7), toDriver);
check('camera never passes through the bodywork', toDriver.clipFrames === 0, { clipFrames: toDriver.clipFrames });
check('driver eye ends in the driver seat (left-hand drive, seated eye height)', eyeOk, { final: toDriver.final });
check('near plane is reduced inside the cabin', toDriver.near <= 0.1, { near: toDriver.near });
const eyeInside = await countInside([EYE]);
check('driver eye is not inside the seat or bodywork', eyeInside.inside === 0, eyeInside);

// 2) Driving in driver view: same controls as the chase view
await takeLog();
const h0 = await page.evaluate(() => window.__game.vehicle.heading());
await page.keyboard.down('KeyW');
await sleep(2200);
await page.screenshot({ path: `${out}/2-driver-accelerating.png` });
await page.keyboard.down('KeyA');
await sleep(700);
const steerState = await page.evaluate(() => ({ steer: window.__game.vehicle.steer, speed: window.__game.vehicle.speed, heading: window.__game.vehicle.heading(), head: window.__game.rig.head.off.toArray() }));
await page.screenshot({ path: `${out}/3-driver-turning-left.png` });
await page.keyboard.up('KeyA');
await sleep(500);
await page.keyboard.up('KeyW');
await page.keyboard.down('KeyS');
await sleep(450);
const brakeState = await page.evaluate(() => ({ speed: window.__game.vehicle.speed, head: window.__game.rig.head.off.toArray() }));
await page.screenshot({ path: `${out}/4-driver-braking.png` });
await sleep(1500);
await page.keyboard.up('KeyS');
const driveLog = await takeLog();
let dEye = 0;
for (const f of driveLog) dEye = Math.max(dEye, Math.hypot(f.l[0] - EYE[0], f.l[1] - EYE[1], f.l[2] - EYE[2]));
const driveInside = await countInside(driveLog.filter((_, i) => i % 3 === 0).map((f) => f.l));
let dh = steerState.heading - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
check('A steers left in the driver view (positive steer, heading increases)', steerState.steer > 0.05 && dh > 0.02, { steer: +steerState.steer.toFixed(3), dHeading: +dh.toFixed(3), speedKmh: +(steerState.speed * 3.6).toFixed(1) });
check('W accelerates in the driver view', steerState.speed > 5, { speed: steerState.speed });
check('head stays within a few cm of the seat while driving (synced with chassis)', dEye < 0.09, { maxOffsetM: +dEye.toFixed(3) });
check('head never enters the seat or bodywork while driving', driveInside.inside === 0, driveInside);
check('head moves forward under braking', brakeState.head[2] < -0.004, { headZ: +brakeState.head[2].toFixed(4) });

// 3) mouse look: drag right → head turns right, clamped; recentres when released while driving
const box = await page.$eval('canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(box.x, box.y);
await page.mouse.down();
for (let i = 0; i < 12; i++) { await page.mouse.move(box.x + 40 * (i + 1), box.y); await sleep(16); }
await page.mouse.up();
await sleep(150);
const look = await page.evaluate(() => window.__game.rig.head.yaw);
await page.screenshot({ path: `${out}/5-driver-look-right.png` });
for (let i = 0; i < 20; i++) { await page.mouse.down(); await page.mouse.move(box.x + 600, box.y); await page.mouse.move(box.x, box.y); await page.mouse.up(); }
const lookMax = await page.evaluate(() => Math.abs(window.__game.rig.head.yaw));
check('mouse look turns the head right', look < -0.3, { yaw: +look.toFixed(3) });
check('mouse look is clamped', lookMax <= 1.9 + 1e-6, { yaw: +lookMax.toFixed(3) });
await page.keyboard.down('KeyW');
await sleep(3500);
await page.keyboard.up('KeyW');
const recentred = await page.evaluate(() => window.__game.rig.head.yaw);
check('head look recentres while driving with the mouse idle', Math.abs(recentred) < 0.35, { yaw: +recentred.toFixed(3) });

// 4) cycle through the remaining modes back to Chase: every switch blended, near plane restored
for (let i = 0; i < 4; i++) {
  const r = await switchMode(`cycle-${i}`, i === 0 ? [250, 500] : []);
  check(`switch → ${r.mode} is smooth`, r.blendFrames >= 8 && r.blendMs > 550 && r.maxStepPerFrame < 0.9 * Math.max(1, r.maxFrameMs / 16.7) && r.clipFrames === 0, r);
  if (r.mode !== 'Driver') check(`near plane restored in ${r.mode}`, Math.abs(r.near - 0.25) < 1e-6, { near: r.near });
}
const back = await page.evaluate(() => window.__game.rig.mode.name);
check('C cycles back to Chase', back === 'Chase', { back });
await page.screenshot({ path: `${out}/6-back-to-chase.png` });
check('no console errors', errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(ok ? 0 : 1);
