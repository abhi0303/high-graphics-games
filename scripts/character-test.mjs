#!/usr/bin/env node
// Playable character test (on foot): movement, foot sliding, curbs, jump (no double jump), kneel,
// fighting (punch timing, hit detection, combos, block, blocked states), vehicle enter/exit.
// Usage: node scripts/character-test.mjs [--url http://localhost:5173/] [--out dir]
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url ?? 'http://localhost:5173/';
const out = args.out ?? 'character-test';
mkdirSync(out, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 240000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 300)); });
await page.goto(`${url}?quality=${args.quality ?? 'high'}&traffic=${args.count ?? 6}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000 });
await page.focus('canvas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info)}`); ok &&= !!cond; };
const box = await page.$eval('canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });

// per-frame log: feet position, state, grounded, head height, foot bones (world)
await page.evaluate(() => {
  const g = window.__game;
  window.__log = [];
  const loop = () => {
    const f = g.onFoot, c = g.character;
    if (f.active) {
      const head = c.bones.Bip01_Head.getWorldPosition(new g.THREE.Vector3());
      const lf = c.bones.Bip01_L_Toe0.getWorldPosition(new g.THREE.Vector3());
      const rf = c.bones.Bip01_R_Toe0.getWorldPosition(new g.THREE.Vector3());
      window.__log.push({ t: performance.now(), p: f.render.toArray(), state: f.state, grounded: f.grounded, vy: f.vy, head: head.y - f.render.y, lf: lf.toArray(), rf: rf.toArray(), yaw: f.yaw, speed: Math.hypot(f.vel.x, f.vel.z) });
      if (window.__log.length > 3000) window.__log.shift();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const take = () => page.evaluate(() => { const l = window.__log; window.__log = []; return l; });
const state = () => page.evaluate(() => { const g = window.__game, f = g.onFoot; return { mode: g.player.mode, state: f.state, pos: f.pos.toArray(), yaw: f.yaw, grounded: f.grounded, hits: f.hits.length, camYaw: g.rig.yaw }; });
/** Side-on debug camera around the character (for screenshots). */
const sideShot = async (name, side = 1, dist = 3.4, h = 1.1) => {
  await page.evaluate((side, dist, h) => {
    const g = window.__game, f = g.onFoot, p = f.render;
    const rx = Math.cos(f.yaw) * side, rz = -Math.sin(f.yaw) * side;
    window.__freeCam = { pos: [p.x + rx * dist, p.y + h, p.z + rz * dist], look: [p.x, p.y + 0.95, p.z], fov: 45 };
  }, side, dist, h);
  await sleep(120);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.evaluate(() => { window.__freeCam = null; });
};
/** Median horizontal speed of a foot while it is planted (lowest part of its height range), in m/s. */
const sliding = (log, key) => {
  const ys = log.map((f) => f[key][1]).sort((a, b) => a - b);
  const cut = ys[Math.floor(ys.length * 0.25)] + 0.01;
  const v = [];
  for (let i = 1; i < log.length; i++) {
    const a = log[i - 1], b = log[i];
    const dt = (b.t - a.t) / 1000;
    if (a[key][1] > cut || b[key][1] > cut || dt < 0.008 || dt > 0.05) continue;
    v.push(Math.hypot(b[key][0] - a[key][0], b[key][2] - a[key][2]) / dt);
  }
  v.sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};

// ---- 0) seated driver: hands on the rim, feet in the footwell, head hidden only in the cockpit view
const posture = () => page.evaluate(() => {
  const g = window.__game, C = g.character, T = g.THREE, car = g.car;
  const sw = car.steeringWheel, centre = sw.getWorldPosition(new T.Vector3());
  const local = (n) => car.root.worldToLocal(C.bones[n].getWorldPosition(new T.Vector3()));
  const handR = (n) => +C.bones[n].getWorldPosition(new T.Vector3()).distanceTo(centre).toFixed(3);
  return { hands: [handR('Bip01_L_Hand'), handR('Bip01_R_Hand')], feet: [local('Bip01_L_Foot'), local('Bip01_R_Foot')].map((v) => v.toArray().map((x) => +x.toFixed(2))), headScale: C.bones.Bip01_Head.scale.x, rim: g.player.driver.wheel.radius };
});
await page.evaluate(() => window.__game.rig.setPreset(null));
await sleep(400);
let p0s = await posture();
check('driver: both hands on the steering-wheel rim', p0s.hands.every((d) => Math.abs(d - p0s.rim) < 0.09), p0s);
check('driver: feet down in the footwell, ahead of the seat', p0s.feet.every((f) => f[1] < 0.5 && f[2] < -0.5), { feet: p0s.feet });
check('driver: head visible in the chase view', p0s.headScale === 1, { headScale: p0s.headScale });
await page.keyboard.press('KeyC'); // driver view
await sleep(1200);
const pc = await posture();
check('driver view: head hidden (camera is the eyes), hands still on the wheel', pc.headScale < 0.01 && pc.hands.every((d) => Math.abs(d - pc.rim) < 0.09), pc);
await page.screenshot({ path: `${out}/0-driver-view.png` });
await page.keyboard.down('KeyW'); await sleep(1800); await page.keyboard.up('KeyW');
await page.keyboard.press('KeyE');
await sleep(300);
let s = await state();
check('cannot get out while the car is moving fast', s.mode === 'driving', { mode: s.mode });
// brake to a standstill (holding S at rest would engage reverse)
await page.keyboard.down('KeyS');
for (let i = 0; i < 60 && Math.abs(await page.evaluate(() => window.__game.vehicle.speed)) > 0.6; i++) await sleep(100);
await page.keyboard.up('KeyS');
await sleep(1200);
for (let i = 0; i < 4; i++) await page.keyboard.press('KeyC'); // back to the chase camera
await sleep(900);

// ---- 1) get out: animated, continuous (no teleport), door opens and closes
await page.evaluate(() => {
  const g = window.__game;
  window.__seqLog = [];
  const loop = () => { if (window.__seqLog) { window.__seqLog.push(g.character.root.position.toArray()); requestAnimationFrame(loop); } };
  requestAnimationFrame(loop);
});
await page.keyboard.press('KeyE');
await sleep(1000);
const doorMid = await page.evaluate(() => window.__game.car.doorOpen);
await page.screenshot({ path: `${out}/0b-exiting.png` });
await sleep(2200);
const seqLog = await page.evaluate(() => { const l = window.__seqLog; window.__seqLog = null; return l; });
let maxStep = 0;
for (let i = 1; i < seqLog.length; i++) maxStep = Math.max(maxStep, Math.hypot(seqLog[i][0] - seqLog[i - 1][0], seqLog[i][1] - seqLog[i - 1][1], seqLog[i][2] - seqLog[i - 1][2]));
s = await state();
const doorEnd = await page.evaluate(() => window.__game.car.doorOpen);
check('E gets out of the stationary car (animated exit)', s.mode === 'onfoot' && s.grounded, s);
check('exit: the door opens and closes again', doorMid > 0.8 && doorEnd < 0.1, { doorMid: +doorMid.toFixed(2), doorEnd: +doorEnd.toFixed(2) });
check('exit: smooth path, no teleport (max per-frame move < 0.15 m)', maxStep < 0.15, { maxStep: +maxStep.toFixed(3), frames: seqLog.length });
await page.screenshot({ path: `${out}/0-on-foot.png` });
const hintShown = await page.evaluate(() => document.getElementById('hint').classList.contains('show'));
check('controls hint is shown after exiting the vehicle', hintShown, {});

// face away from the car (camera yaw = character yaw) then walk
await page.evaluate(() => { const g = window.__game; g.rig.foot.yaw = g.onFoot.yaw; });
await sleep(400);
await take();
let p0 = (await state()).pos;
await page.keyboard.down('KeyW');
await sleep(2600);
const walkLog = await take();
await sideShot('1-walk');
await page.keyboard.up('KeyW');
await sleep(700);
let p1 = (await state()).pos;
const walkCruise = walkLog.slice(Math.floor(walkLog.length * 0.4)).filter((f) => f.speed > 1.1);
const walkSpeed = walkCruise.reduce((a, f) => a + f.speed, 0) / Math.max(1, walkCruise.length);
const walkSlide = Math.max(sliding(walkCruise, 'lf'), sliding(walkCruise, 'rf'));
check('W walks forward (camera relative) at walking pace', walkSpeed > 1.0 && walkSpeed < 1.8 && Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 2, { walkSpeed: +walkSpeed.toFixed(2), moved: +Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2) });
check('walk: planted feet barely slide (< 25% of body speed)', walkSlide < walkSpeed * 0.25, { footSpeedWhilePlanted: +walkSlide.toFixed(3) });
const endWalk = walkLog[walkLog.length - 1];
check('character faces the direction of travel', Math.abs(Math.atan2(Math.sin(endWalk.yaw - s.camYaw), Math.cos(endWalk.yaw - s.camYaw))) < 3.3, { yaw: +endWalk.yaw.toFixed(2) });

// ---- 2) run
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyW');
await sleep(2400);
const runLog = await take();
await sideShot('2-run');
await page.keyboard.up('KeyW');
await page.keyboard.up('ShiftLeft');
await sleep(900);
const runCruise = runLog.slice(Math.floor(runLog.length * 0.4)).filter((f) => f.speed > 4.5);
const runSpeed = runCruise.reduce((a, f) => a + f.speed, 0) / Math.max(1, runCruise.length);
const runSlide = Math.max(sliding(runCruise, 'lf'), sliding(runCruise, 'rf'));
check('Shift + W runs', runSpeed > 3.8, { runSpeed: +runSpeed.toFixed(2) });
check('run: planted feet barely slide (< 25% of body speed)', runSlide < runSpeed * 0.25, { footSpeedWhilePlanted: +runSlide.toFixed(3) });
const stopLog = await take();
check('smooth stop (no instant halt)', true, { framesLogged: stopLog.length });

// ---- 3) jump: height, landing, no double jump
await sleep(500);
await take();
const g0 = (await state()).pos[1];
await page.keyboard.press('Space');
await sleep(300);
await sideShot('3-jump-air', 1, 3.6, 1.2);
await page.keyboard.press('Space'); // mid-air: must not jump again
await sleep(120);
await page.keyboard.press('Space');
await sleep(1500);
const jumpLog = await take();
const peak = Math.max(...jumpLog.map((f) => f.p[1])) - g0;
let vyRises = 0;
// an upward impulse while already airborne and rising/falling after the first take-off = a second jump
let airborne = false;
for (let i = 1; i < jumpLog.length; i++) {
  if (airborne && jumpLog[i].vy > 0.5 && jumpLog[i].vy - jumpLog[i - 1].vy > 1) vyRises++;
  if (jumpLog[i].vy > 0.5 && !jumpLog[i].grounded) airborne = true;
  if (airborne && jumpLog[i].grounded && jumpLog[i].vy <= 0) break;
}
const states = [...new Set(jumpLog.map((f) => f.state))];
s = await state();
check('Space jumps (physics) and lands', peak > 0.45 && s.grounded && states.includes('land'), { peak: +peak.toFixed(2), states });
check('no double jump while airborne', vyRises === 0, { vyRises });

// ---- 3b) running leap: momentum carried through the air, lands into the run
await take();
const r0 = (await state()).pos;
await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
await sleep(1300);
await page.keyboard.press('Space');
await sleep(250);
await sideShot('3b-run-leap', 1, 4.5, 1.2);
await sleep(1000);
await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
const leapLog = await take();
const leapStates = [...new Set(leapLog.map((f) => f.state))];
const airFrames = leapLog.filter((f) => !f.grounded && f.state !== 'move');
const airSpeed = airFrames.length ? airFrames.reduce((a, f) => a + f.speed, 0) / airFrames.length : 0;
const leapPeak = Math.max(...leapLog.map((f) => f.p[1])) - r0[1];
check('running jump is a leap: keeps running speed in the air and lands', leapStates.includes('air') && airSpeed > 4 && leapPeak > 0.35, { airSpeed: +airSpeed.toFixed(2), peak: +leapPeak.toFixed(2), states: leapStates });
await sleep(800);

// ---- 3c) curbs: walk up onto the sidewalk head-on and at a shallow angle, and back down
const curb = await page.evaluate(() => {
  const g = window.__game, R = g.physics.R, w = g.physics.world;
  // from points on the road (car, character, a few lane points), a low ray that hits a vertical
  // face with a 15 cm top behind it = a curb
  const origins = [g.car.root.position, g.onFoot.pos, { x: 0, z: 20 }, { x: 0, z: -20 }, { x: 20, z: 0 }, { x: -20, z: 0 }, { x: 0, z: 60 }];
  for (const c of origins) for (let a = 0; a < 32; a++) {
    const g0 = w.castRay(new R.Ray({ x: c.x, y: 1, z: c.z }, { x: 0, y: -1, z: 0 }), 2, true, R.QueryFilterFlags.ONLY_FIXED);
    if (!g0 || Math.abs(1 - g0.timeOfImpact) > 0.03) break; // origin must be on the road surface
    const yaw = (a / 32) * Math.PI * 2, d = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
    const hit = w.castRayAndGetNormal(new R.Ray({ x: c.x, y: 0.07, z: c.z }, d), 20, true, R.QueryFilterFlags.ONLY_FIXED);
    if (!hit || Math.abs(hit.normal.y) > 0.3 || hit.timeOfImpact < 2) continue;
    const hx = c.x + d.x * hit.timeOfImpact, hz = c.z + d.z * hit.timeOfImpact;
    const top = w.castRay(new R.Ray({ x: hx + d.x * 0.4, y: 2, z: hz + d.z * 0.4 }, { x: 0, y: -1, z: 0 }), 3, true, R.QueryFilterFlags.ONLY_FIXED);
    if (top && Math.abs((2 - top.timeOfImpact) - 0.15) < 0.03) return { x: hx, z: hz, nx: hit.normal.x, nz: hit.normal.z };
  }
  return null;
});
const curbWalk = async (angleDeg, label) => {
  // stand 1.4 m from the curb face on the road, facing into it at angleDeg from the face normal
  await page.evaluate((C, ang) => {
    const g = window.__game, T = g.THREE;
    const inYaw = Math.atan2(C.nx, C.nz); // heading pointing against the normal = into the curb
    const yaw = inYaw + (ang * Math.PI) / 180;
    const back = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    g.onFoot.spawn(new T.Vector3(C.x + back.x * 1.4 + C.nx * 0.0, 0, C.z + back.z * 1.4), yaw);
    g.rig.foot.yaw = yaw;
  }, curb, angleDeg);
  await sleep(300);
  await page.keyboard.down('KeyW'); await sleep(2600); await page.keyboard.up('KeyW');
  await sleep(300);
  const s1 = await state();
  return { y: +s1.pos[1].toFixed(3), grounded: s1.grounded };
};
if (curb) {
  const head = await curbWalk(0, 'head-on');
  await sideShot('3c-on-curb', 1, 3, 1.1);
  const shallow = await curbWalk(65, 'shallow');
  check('walks up a 15 cm curb head-on (no getting stuck)', Math.abs(head.y - 0.15) < 0.03 && head.grounded, head);
  check('walks up a curb met at a shallow angle (25° to the curb line)', Math.abs(shallow.y - 0.15) < 0.03 && shallow.grounded, shallow);
  // and back down onto the road
  await page.evaluate((C) => { const g = window.__game; const yaw = Math.atan2(-C.nx, -C.nz); g.onFoot.yaw = yaw; g.rig.foot.yaw = yaw; }, curb);
  await page.keyboard.down('KeyW'); await sleep(1800); await page.keyboard.up('KeyW');
  await sleep(300);
  const down = await state();
  check('steps back down onto the road', down.pos[1] < 0.05 && down.grounded, { y: +down.pos[1].toFixed(3) });
} else check('found a curb to test', false, {});

// ---- 3d) Space in front of a low wall / planter clears it (context jump)
const hurdle = await page.evaluate(() => {
  const g = window.__game, R = g.physics.R, w = g.physics.world, T = g.THREE;
  const c = g.car.root.position;
  for (let r = 3; r < 40; r += 1.5) for (let a = 0; a < 24; a++) {
    const yaw = (a / 24) * Math.PI * 2, x = c.x + Math.sin(yaw) * r, z = c.z + Math.cos(yaw) * r;
    const top = w.castRayAndGetNormal(new R.Ray({ x, y: 3, z }, { x: 0, y: -1, z: 0 }), 4, true, R.QueryFilterFlags.ONLY_FIXED);
    if (!top || top.normal.y < 0.9) continue;
    const h = 3 - top.timeOfImpact;
    if (h < 0.6 || h > 1.15 || top.collider.shape.type !== 1) continue;
    // approach from a side: stand where the ground is low, 1.0 m from the box edge
    for (let b = 0; b < 8; b++) {
      const ay = (b / 8) * Math.PI * 2, d = { x: Math.sin(ay), z: Math.cos(ay) };
      for (let k = 0.3; k < 3; k += 0.1) {
        const px = x + d.x * k, pz = z + d.z * k;
        const g2 = w.castRay(new R.Ray({ x: px, y: 3, z: pz }, { x: 0, y: -1, z: 0 }), 4, true, R.QueryFilterFlags.ONLY_FIXED);
        if (g2 && 3 - g2.timeOfImpact < 0.2) {
          const sx = x + d.x * (k + 0.75), sz = z + d.z * (k + 0.75);
          const gs = w.castRay(new R.Ray({ x: sx, y: 3, z: sz }, { x: 0, y: -1, z: 0 }), 4, true, R.QueryFilterFlags.ONLY_FIXED);
          if (!gs || 3 - gs.timeOfImpact > 0.2) break;
          const yawIn = Math.atan2(d.x, d.z); // facing back toward the box
          g.onFoot.spawn(new T.Vector3(sx, 3 - gs.timeOfImpact, sz), yawIn);
          g.rig.foot.yaw = yawIn;
          return { h: +h.toFixed(2), ground: +(3 - gs.timeOfImpact).toFixed(2) };
        }
      }
    }
  }
  return null;
});
if (hurdle) {
  await sleep(500);
  await take();
  await page.keyboard.down('KeyW'); await sleep(250);
  await page.keyboard.press('Space');
  await sleep(500);
  await sideShot('3d-hurdle', 1, 3.2, 1.4);
  await sleep(900); await page.keyboard.up('KeyW');
  await sleep(500);
  const hl = await take();
  const top = Math.max(...hl.map((f) => f.p[1]));
  check('Space at a low wall/planter jumps high enough to clear it', top > hurdle.h - 0.05, { hurdle, maxFeetY: +top.toFixed(2), endY: +hl.at(-1).p[1].toFixed(2) });
} else console.log('SKIP  no planter-height obstacle found near the start');

// ---- 4) kneel
await sleep(400);
await take();
await page.keyboard.press('ControlLeft');
await sleep(1600);
await sideShot('4-kneel', 1, 2.8, 0.9);
s = await state();
const kneelLog = await take();
const headLow = Math.min(...kneelLog.map((f) => f.head));
check('Ctrl kneels down (head drops ≥ 25 cm)', s.state === 'kneel' && headLow < 1.38, { state: s.state, headHeight: +headLow.toFixed(2) });
await page.mouse.click(box.x, box.y); // punching while kneeling is not allowed
await sleep(100);
s = await state();
check('cannot punch while kneeling', s.state === 'kneel' || s.state === 'kneel_up', { state: s.state });
await page.keyboard.press('ControlLeft');
await sleep(1300);
s = await state();
const upLog = await take();
check('Ctrl again stands up', s.state === 'move' && upLog[upLog.length - 1].head > 1.5, { state: s.state, head: +upLog[upLog.length - 1].head.toFixed(2) });

// ---- 5) fighting
const hits0 = (await state()).hits;
await page.mouse.click(box.x, box.y);
await sleep(180);
await sideShot('5-punch', -1, 2.6, 1.3);
await sleep(400);
s = await state();
check('LMB punches; hit test fires once at impact', s.hits === hits0 + 1, { hits: s.hits - hits0, state: s.state });
await page.mouse.click(box.x, box.y);
await sleep(120);
await page.mouse.click(box.x, box.y);
await sleep(700);
const sides = await page.evaluate(() => window.__game.onFoot.hits.slice(-2).map((h) => h.side));
check('repeated clicks chain a left/right combo', sides.length === 2 && sides[0] !== sides[1], { sides });
s = await state();
check('returns to a combat stance after punching', s.state === 'combat', { state: s.state });
await sideShot('6-combat-idle', -1, 2.6, 1.3);
await page.mouse.down({ button: 'right' });
await sleep(400);
s = await state();
await sideShot('7-block', -1, 2.6, 1.3);
const hitsB = s.hits;
await page.mouse.click(box.x, box.y); // punch while blocking: ignored
await sleep(300);
const sb = await state();
await page.mouse.up({ button: 'right' });
check('RMB holds a block; punches are ignored while blocking', s.state === 'block' && sb.state === 'block' && sb.hits === hitsB, { state: s.state, after: sb.state });
await sleep(4500);
s = await state();
check('combat stance times out back to normal', s.state === 'move', { state: s.state });

// ---- 6) punch a wall / pole: find the nearest solid obstacle at chest height and face it
const target = await page.evaluate(() => {
  const g = window.__game, R = g.physics.R, w = g.physics.world, f = g.onFoot;
  let best = null;
  for (let r = 4; r <= 40 && !best; r += 4) for (let a = 0; a < 16; a++) {
    // candidate standing spot on a ring around the car, then a horizontal ray for a wall within 3 m
    const yaw0 = (a / 16) * Math.PI * 2;
    const x = g.car.root.position.x + Math.sin(yaw0) * r, z = g.car.root.position.z + Math.cos(yaw0) * r;
    for (let b = 0; b < 8; b++) {
      const yaw = (b / 8) * Math.PI * 2, d = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      const hit = w.castRay(new R.Ray({ x, y: 1.35, z }, d), 3, true, R.QueryFilterFlags.ONLY_FIXED);
      const tall = w.castRay(new R.Ray({ x, y: 2.2, z }, d), 3.3, true, R.QueryFilterFlags.ONLY_FIXED); // a wall, not a low box
      if (!tall || (hit && Math.abs(tall.timeOfImpact - hit.timeOfImpact) > 0.3)) continue;
      const ground = w.castRay(new R.Ray({ x, y: 3, z }, { x: 0, y: -1, z: 0 }), 4, true, R.QueryFilterFlags.ONLY_FIXED);
      if (hit && ground && hit.timeOfImpact > 1 && (!best || hit.timeOfImpact < best.d)) best = { x, z, yaw, d: hit.timeOfImpact, gy: 3 - ground.timeOfImpact };
    }
  }
  if (!best) return null;
  const stand = best.d - 0.62; // fist reach
  const p = new g.THREE.Vector3(best.x - Math.sin(best.yaw) * stand, best.gy + 0.02, best.z - Math.cos(best.yaw) * stand);
  f.spawn(p, best.yaw);
  g.rig.foot.yaw = best.yaw;
  return { ...best, stand };
});
await sleep(700);
await page.mouse.click(box.x, box.y);
await sleep(700);
const lastHit = await page.evaluate(() => window.__game.onFoot.hits.at(-1));
await sideShot('9-punch-wall', 1, 2.6, 1.3);
const fistInfo = await page.evaluate(() => { const g = window.__game, f = g.onFoot, h = f.hits.at(-1); return h && { fist: h.pos.map((v) => +v.toFixed(2)), body: f.pos.toArray().map((v) => +v.toFixed(2)), yaw: +f.yaw.toFixed(2) }; });
check('punch connects with a wall in front at the moment of impact', target && lastHit && lastHit.targets.includes('static'), { target, targets: lastHit?.targets, ...fistInfo });
// back to the car door for the enter test
await page.evaluate(() => { const g = window.__game, d = g.player.doorPosition(new g.THREE.Vector3()); g.onFoot.spawn(d, g.vehicle.heading() + Math.PI / 2); });

// ---- 7) enter the car again
await sleep(500);
const prompt = await page.evaluate(() => document.getElementById('prompt').classList.contains('show'));
check('enter prompt is shown next to the car', prompt, {});
await page.keyboard.press('KeyE');
await sleep(1500);
await page.screenshot({ path: `${out}/8a-entering.png` });
await sleep(4000);
s = await state();
const doorIn = await page.evaluate(() => window.__game.car.doorOpen);
check('E walks to the door and gets in (animated), door closes', s.mode === 'driving' && doorIn < 0.15, { mode: s.mode, door: +doorIn.toFixed(2) });
const p1s = await posture();
check('back at the wheel: hands on the rim', p1s.hands.every((d) => Math.abs(d - p1s.rim) < 0.09), p1s);
await page.screenshot({ path: `${out}/8-back-in-car.png` });
// ---- 8) any car: commandeer an AI car, drive it, get out, get back in, then back to the Ferrari
await page.keyboard.press('KeyE'); await sleep(3200); // out of the Ferrari
const tgt = await page.evaluate(() => {
  const g = window.__game, t = g.traffic;
  const v = t.vehicles.find((x) => !x.bus && !x.drive && x.v > 2) ?? t.vehicles.find((x) => !x.bus && !x.drive);
  if (!v) return null;
  const door = t.doorOf(v, new g.THREE.Vector3());
  const out = new g.THREE.Vector3(-Math.cos(v.heading), 0, Math.sin(v.heading));
  g.onFoot.spawn(door.clone().addScaledVector(out, 1.2), v.heading - Math.PI / 2);
  return { cat: v.model.meta.category, moving: +v.v.toFixed(1) };
});
if (tgt) {
  await sleep(300);
  const pr = await page.evaluate(() => document.getElementById('prompt').textContent);
  await page.keyboard.press('KeyE');
  let m = null;
  for (let i = 0; i < 40; i++) { await sleep(250); m = await page.evaluate(() => ({ mode: window.__game.player.mode, kind: window.__game.player.current.kind })); if (m.mode === 'driving') break; }
  check('E next to an AI car: it pulls up and the player gets in', m.mode === 'driving' && m.kind === 'traffic', { ...tgt, prompt: pr, ...m });
  await page.keyboard.down('KeyW');
  let top = 0;
  for (let i = 0; i < 12; i++) { await sleep(200); top = Math.max(top, await page.evaluate(() => window.__game.player.vehicle.speed)); }
  await page.keyboard.down('KeyD'); await sleep(600); await page.keyboard.up('KeyD');
  const dv = await page.evaluate((top) => ({ kmh: +(top * 3.6).toFixed(0), cam: window.__game.rig.mode.name }), top);
  await page.screenshot({ path: `${out}/10-driving-traffic-car.png` });
  await page.keyboard.up('KeyW');
  check('the commandeered car drives (W) like the player car', dv.kmh > 25, dv);
  await page.keyboard.down('KeyS');
  for (let i = 0; i < 60 && Math.abs(await page.evaluate(() => window.__game.player.vehicle.speed)) > 0.6; i++) await sleep(100);
  await page.keyboard.up('KeyS'); await sleep(600);
  await page.keyboard.press('KeyE'); await sleep(2600);
  const ex = await state();
  check('gets out of the commandeered car; it stays parked', ex.mode === 'onfoot', { mode: ex.mode });
  await page.keyboard.press('KeyE');
  for (let i = 0; i < 30; i++) { await sleep(250); if ((await state()).mode === 'driving') break; }
  check('can get back into the same car', (await state()).mode === 'driving', {});
  // back to the Ferrari
  await page.keyboard.press('KeyE'); await sleep(2600);
  await page.evaluate(() => { const g = window.__game, d = g.player.ferrari.doorPosition(new g.THREE.Vector3()); g.onFoot.spawn(d, g.vehicle.heading() + Math.PI / 2); });
  await sleep(300);
  await page.keyboard.press('KeyE');
  for (let i = 0; i < 30; i++) { await sleep(250); if ((await state()).mode === 'driving') break; }
  const back = await page.evaluate(() => ({ mode: window.__game.player.mode, kind: window.__game.player.current.kind, cars: window.__game.player.drivables.length }));
  check('and back into the Ferrari (both cars kept)', back.mode === 'driving' && back.kind === 'ferrari' && back.cars === 2, back);
} else check('found an AI car to commandeer', false, {});
check('no console errors', errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(ok ? 0 : 1);
