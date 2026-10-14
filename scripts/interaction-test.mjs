#!/usr/bin/env node
// Player ↔ traffic interaction test:
//  1. block: park the player in a moving AI vehicle's lane ahead of it; it must stop without touching
//  2. ram:   drive the player into an AI vehicle at speed; physics must stay finite, the AI vehicle
//            must stay on its lane (kinematic, no shove/teleport) and the player must rebound
// Usage: node scripts/interaction-test.mjs [--url http://localhost:5173/] [--out dir]
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url ?? 'http://localhost:5173/';
const out = args.out ?? 'interaction-test';
mkdirSync(out, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 240000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 300)); });
await page.goto(`${url}?quality=medium&traffic=${args.count ?? 16}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000 });
await page.focus('canvas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info)}`); ok &&= cond; };

// pick a vehicle cruising on a long segment
const pickTarget = () => page.evaluate(() => {
  const t = window.__game.traffic;
  const cands = t.vehicles.map((v, i) => ({ v, i })).filter(({ v }) => v.path.kind === 'segment' && v.path.length - v.s > 45 && v.v > 3);
  if (!cands.length) return null;
  const { v, i } = cands[0];
  return { i, x: v.pos.x, z: v.pos.z, heading: v.heading, len: v.len };
});
let target = null;
for (let k = 0; k < 40 && !target; k++) { target = await pickTarget(); if (!target) await sleep(250); }
if (!target) { console.log('FAIL  no cruising vehicle found'); process.exit(1); }

// 1) block: player stopped 24 m ahead, same heading
await page.evaluate((T) => {
  const g = window.__game, f = { x: -Math.sin(T.heading), z: -Math.cos(T.heading) };
  g.vehicle.reset({ x: T.x + f.x * 24, z: T.z + f.z * 24, heading: T.heading });
}, target);
const gaps = [];
for (let k = 0; k < 40; k++) {
  await sleep(200);
  gaps.push(await page.evaluate((i) => {
    const g = window.__game, v = g.traffic.vehicles[i], p = g.vehicle.body.translation();
    const f = { x: -Math.sin(v.heading), z: -Math.cos(v.heading) };
    const along = (p.x - v.pos.x) * f.x + (p.z - v.pos.z) * f.z;
    return { gap: +(along - v.len / 2 - 2.3).toFixed(2), v: +v.v.toFixed(2) };
  }, target.i));
}
await page.evaluate((i) => { const v = window.__game.traffic.vehicles[i]; window.__freeCam = { pos: [v.pos.x + 10, 5, v.pos.z + 10], look: [v.pos.x, 1, v.pos.z], fov: 55 }; }, target.i);
await sleep(300);
await page.screenshot({ path: `${out}/blocked.png` });
await page.evaluate(() => { window.__freeCam = null; });
const minGap = Math.min(...gaps.map((g) => g.gap));
const final = gaps[gaps.length - 1];
check('AI vehicle stops behind a blocking player without contact', minGap > 0.5 && final.v < 0.3, { minGap, final });

// 2) ram: drive into a vehicle that is waiting at a red light, from behind, at speed
await page.evaluate(() => window.__game.vehicle.reset({ x: 0, z: 200, heading: 0 })); // out of the way
await sleep(1500);
const pickStopped = () => page.evaluate(() => {
  const t = window.__game.traffic;
  const cands = t.vehicles.map((v, i) => ({ v, i })).filter(({ v }) => v.path.kind === 'segment' && v.v < 0.2 && v.path.length - v.s < 15 && v.s > 40
    && !t.vehicles.some((o) => o !== v && o.path === v.path && o.s < v.s && o.s > v.s - 40));
  if (!cands.length) return null;
  const { v, i } = cands[0];
  return { i, x: v.pos.x, z: v.pos.z, heading: v.heading, len: v.len };
});
target = null;
for (let k = 0; k < 160 && !target; k++) { target = await pickStopped(); if (!target) await sleep(250); }
const before = await page.evaluate((T) => {
  const g = window.__game, f = { x: -Math.sin(T.heading), z: -Math.cos(T.heading) };
  g.vehicle.reset({ x: T.x - f.x * (T.len / 2 + 22), z: T.z - f.z * (T.len / 2 + 22), heading: T.heading });
  const v = g.traffic.vehicles[T.i];
  return { lane: v.path.index, offsetFromLane: 0 };
}, target);
await sleep(400);
await page.keyboard.down('KeyW');
let impact = null;
for (let k = 0; k < 60; k++) {
  await sleep(80);
  const s = await page.evaluate((i) => {
    const g = window.__game, v = g.traffic.vehicles[i], p = g.vehicle.body.translation(), lv = g.vehicle.body.linvel();
    return { d: Math.hypot(p.x - v.pos.x, p.z - v.pos.z), speed: g.vehicle.speed, finite: [p.x, p.y, p.z, lv.x, lv.y, lv.z].every(Number.isFinite), vx: v.pos.x, vz: v.pos.z, path: v.path.kind };
  }, target.i);
  if (s.d < (target.len / 2 + 3.2) && !impact) impact = s;
  if (!s.finite) { impact = s; break; }
}
await page.keyboard.up('KeyW');
await sleep(1500);
const after = await page.evaluate((i) => {
  const g = window.__game, v = g.traffic.vehicles[i], p = g.vehicle.body.translation(), lv = g.vehicle.body.linvel();
  // distance of the AI vehicle from its lane path (it must not be shoved off it)
  const q = v.pos.clone(), d = v.dir.clone();
  v.path.sample(v.s, q, d);
  return { finite: [p.x, p.y, p.z, lv.x, lv.y, lv.z].every(Number.isFinite), playerY: +p.y.toFixed(2), aiOffLane: +Math.hypot(q.x - v.pos.x, q.z - v.pos.z).toFixed(3), aiSpeed: +v.v.toFixed(2) };
}, target.i);
await page.evaluate((i) => { const v = window.__game.traffic.vehicles[i]; window.__freeCam = { pos: [v.pos.x + 9, 4.5, v.pos.z + 9], look: [v.pos.x, 1, v.pos.z], fov: 55 }; }, target.i);
await sleep(300);
await page.screenshot({ path: `${out}/after-ram.png` });
check('reached the AI vehicle at speed', !!impact, impact && { speedKmh: +(impact.speed * 3.6).toFixed(1) });
check('physics stays finite and player stays upright-ish', after.finite && after.playerY > -0.5 && after.playerY < 2.5, after);
check('AI vehicle stays on its lane (kinematic, not shoved)', after.aiOffLane < 0.6, after);
// 3) pedestrian: the player on foot standing in a lane ahead of a cruising AI vehicle
await page.evaluate(() => { const g = window.__game; g.vehicle.reset({ x: 0, z: 200, heading: 0 }); });
target = null;
for (let k = 0; k < 40 && !target; k++) { target = await pickTarget(); if (!target) await sleep(250); }
if (target) {
  await page.evaluate((T) => {
    const g = window.__game, f = { x: -Math.sin(T.heading), z: -Math.cos(T.heading) };
    g.onFoot.spawn(new g.THREE.Vector3(T.x + f.x * 24, 0, T.z + f.z * 24), T.heading + Math.PI); // facing the car
  }, target);
  const pgaps = [];
  for (let k = 0; k < 40; k++) {
    await sleep(200);
    pgaps.push(await page.evaluate((i) => {
      const g = window.__game, v = g.traffic.vehicles[i], p = g.onFoot.pos;
      const f = { x: -Math.sin(v.heading), z: -Math.cos(v.heading) };
      return { gap: +(((p.x - v.pos.x) * f.x + (p.z - v.pos.z) * f.z) - v.len / 2 - 0.3).toFixed(2), v: +v.v.toFixed(2) };
    }, target.i));
  }
  await page.evaluate((i) => { const v = window.__game.traffic.vehicles[i]; window.__freeCam = { pos: [v.pos.x + 8, 3.5, v.pos.z + 8], look: [v.pos.x, 1, v.pos.z], fov: 55 }; }, target.i);
  await sleep(300);
  await page.screenshot({ path: `${out}/pedestrian.png` });
  await page.evaluate(() => { window.__freeCam = null; window.__game.onFoot.remove(); window.__game.character.root.visible = true; });
  const pmin = Math.min(...pgaps.map((g) => g.gap));
  check('AI vehicle stops for the player on foot', pmin > 0.4 && pgaps.at(-1).v < 0.3, { minGap: pmin, final: pgaps.at(-1) });
} else check('found a cruising vehicle for the pedestrian test', false, {});
check('no console errors', errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(ok ? 0 : 1);
