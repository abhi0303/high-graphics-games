#!/usr/bin/env node
// Steering regression test. For every steering key at several speeds (and in reverse)
// it measures, in the car's starting frame:
//   - heading change (positive = turned left / counter-clockwise from above)
//   - lateral displacement (negative = moved toward the car's left)
//   - physics front-wheel steering angle and the visual front-wheel pivot angle
// and checks they all agree with the key pressed. Exits non-zero on failure.
// Usage: node scripts/steering-test.mjs [--url http://localhost:5173/]
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url ?? 'http://localhost:5173/';
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 960, height: 540 }, protocolTimeout: 240000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}?quality=medium&traffic=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000 });
await page.focus('canvas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snap = () => page.evaluate(() => {
  const g = window.__game, v = g.vehicle;
  const p = v.body.translation();
  return {
    x: p.x, z: p.z, h: v.heading(), v: v.speed,
    physSteer: v.ctrl.wheelSteering(0), visSteer: g.car.wheels[0].pivot.rotation.y,
  };
});
// Start on Grand Blvd heading east (heading -90°): 200 m of open road.
const start = () => page.evaluate(() => window.__game.vehicle.reset({ x: -95, z: 5.4, heading: -Math.PI / 2 }));

async function run(label, key, targetKmh, reverse = false) {
  await start();
  await sleep(700);
  const drive = reverse ? 'KeyS' : 'KeyW';
  await page.keyboard.down(drive);
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    const s = await snap();
    if (Math.abs(s.v * 3.6) >= targetKmh) break;
    await sleep(40);
  }
  const a = await snap();
  await page.keyboard.down(key);
  await sleep(380);
  const mid = await snap(); // wheels fully deflected by now
  await sleep(620);
  const b = await snap();
  await page.keyboard.up(key);
  await page.keyboard.up(drive);
  // displacement in the starting frame: forward f = (-sin h, -cos h), left l = (-cos h, sin h)
  const dx = b.x - a.x, dz = b.z - a.z;
  const left = dx * -Math.cos(a.h) + dz * Math.sin(a.h);
  let dh = ((b.h - a.h) * 180) / Math.PI;
  dh = ((dh + 540) % 360) - 180;
  const wantsLeft = key === 'KeyA' || key === 'ArrowLeft';
  // Forward: turning left yaws CCW (+) and moves left. Reversing with left lock yaws CW (-)
  // and the car moves toward its left-rear. The front wheels point left either way.
  const yawOk = reverse ? (wantsLeft ? dh < 0 : dh > 0) : (wantsLeft ? dh > 0 : dh < 0);
  const moveOk = wantsLeft ? left > 0 : left < 0;
  const wheelsOk = wantsLeft ? mid.physSteer > 0.02 && mid.visSteer > 0.02 : mid.physSteer < -0.02 && mid.visSteer < -0.02;
  const pass = yawOk && moveOk && wheelsOk;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} speed ${(a.v * 3.6).toFixed(0).padStart(4)} km/h  Δheading ${dh.toFixed(1).padStart(6)}°  lateral ${(left >= 0 ? 'left ' : 'right')} ${Math.abs(left).toFixed(2)} m  wheels phys ${mid.physSteer.toFixed(3)} visual ${mid.visSteer.toFixed(3)}`);
  return pass;
}

const results = [];
for (const [kmh, tag] of [[15, 'slow'], [40, 'medium'], [80, 'fast']]) {
  for (const key of ['KeyA', 'ArrowLeft', 'KeyD', 'ArrowRight']) results.push(await run(`${key} ${tag}`, key, kmh));
}
for (const key of ['KeyA', 'KeyD']) results.push(await run(`${key} reverse`, key, 10, true));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : 'all steering checks passed');
process.exit(failed ? 1 : 0);
