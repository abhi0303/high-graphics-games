#!/usr/bin/env node
// AI traffic acceptance test (live mode). Samples the simulation for ~25 s and checks:
//  - vehicles keep moving (no global gridlock), at urban speeds
//  - no two vehicles overlap (oriented-box separating-axis test with a small tolerance)
//  - motion is along the vehicle heading (no sideways sliding / teleports)
//  - nobody drives through a red light (on a segment, near the stop line, at speed)
//  - no console errors; reports frame rate
// Usage: node scripts/traffic-test.mjs [--url http://localhost:5173/] [--count 28] [--out dir]
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url ?? 'http://localhost:5173/';
const count = Number(args.count ?? 28);
const out = args.out ?? 'traffic-test';
mkdirSync(out, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 240000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 300)); });
await page.goto(`${url}?quality=high&traffic=${count}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000 });
const err = await page.evaluate('window.__error');
if (err) { console.error(err); process.exit(1); }

const report = await page.evaluate(async () => {
  const t = window.__game.traffic;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const corners = (v) => {
    const f = { x: -Math.sin(v.heading), z: -Math.cos(v.heading) }, r = { x: -f.z, z: f.x };
    return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => ({ x: v.pos.x + f.x * a * v.len / 2 + r.x * b * v.width / 2, z: v.pos.z + f.z * a * v.len / 2 + r.z * b * v.width / 2 }));
  };
  const overlap = (A, B, tol) => {
    const ca = corners(A), cb = corners(B);
    for (const v of [A, B]) {
      for (const ax of [{ x: -Math.sin(v.heading), z: -Math.cos(v.heading) }, { x: Math.cos(v.heading), z: -Math.sin(v.heading) }]) {
        const pa = ca.map((p) => p.x * ax.x + p.z * ax.z), pb = cb.map((p) => p.x * ax.x + p.z * ax.z);
        if (Math.max(...pa) < Math.min(...pb) + tol || Math.max(...pb) < Math.min(...pa) + tol) return false;
      }
    }
    return true;
  };
  const N = t.vehicles.length;
  const start = t.vehicles.map((v) => ({ x: v.pos.x, z: v.pos.z }));
  const dist = new Array(N).fill(0);
  let overlaps = 0, sideways = 0, redRuns = 0, samples = 0, maxSpeed = 0, frames = 0;
  const overlapPairs = new Set();
  const last = t.vehicles.map((v) => ({ x: v.pos.x, z: v.pos.z }));
  const t0 = performance.now();
  let fpsFrames = 0;
  const countFrames = () => { fpsFrames++; if (performance.now() - t0 < 25000) requestAnimationFrame(countFrames); };
  requestAnimationFrame(countFrames);
  while (performance.now() - t0 < 25000) {
    await sleep(100);
    samples++;
    t.vehicles.forEach((v, i) => {
      const dx = v.pos.x - last[i].x, dz = v.pos.z - last[i].z, d = Math.hypot(dx, dz);
      dist[i] += d;
      maxSpeed = Math.max(maxSpeed, v.v);
      if (d > 0.05) {
        const fx = -Math.sin(v.heading), fz = -Math.cos(v.heading);
        const lateral = Math.abs(dx * fz - dz * fx) / d;
        if (lateral > 0.35 || d > 4) sideways++;
      }
      last[i] = { x: v.pos.x, z: v.pos.z };
      if (v.path.kind === 'segment' && v.next) {
        const toStop = v.path.length - v.s - v.len / 2;
        if (window.__game.city.props.phase(v.path.axis) === 'r' && toStop < 0.5 && toStop > -2 && v.v > 3) redRuns++;
      }
    });
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      if (overlap(t.vehicles[i], t.vehicles[j], 0.15)) { overlaps++; overlapPairs.add(`${i}-${j}`); }
    }
  }
  const moved = dist.filter((d) => d > 15).length;
  return {
    vehicles: N, samples, fps: +(fpsFrames / 25).toFixed(1), movedOver15m: moved, meanDistance: +(dist.reduce((a, b) => a + b, 0) / N).toFixed(1),
    maxSpeedKmh: +(maxSpeed * 3.6).toFixed(1), overlapSamples: overlaps, overlapPairs: [...overlapPairs].slice(0, 10), sidewaysSamples: sideways, redLightRuns: redRuns,
    models: [...new Set(t.vehicles.map((v) => v.model.slug))],
  };
});
console.log(JSON.stringify(report, null, 1));
let ok = true;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); ok &&= cond; };
check('most vehicles keep moving (>= 70% travelled > 15 m)', report.movedOver15m >= Math.ceil(report.vehicles * 0.7));
check('urban speeds (max <= 60 km/h)', report.maxSpeedKmh <= 60);
check('no overlapping vehicles', report.overlapSamples === 0);
check('no sideways motion / teleports', report.sidewaysSamples === 0);
check('no red-light running', report.redLightRuns === 0);
check('no console errors', errors.length === 0);
if (errors.length) console.log(errors.slice(0, 5));

// screenshots: chase view and an overview of the main intersection
await page.screenshot({ path: `${out}/chase.png` });
await page.evaluate(() => { window.__freeCam = { pos: [36, 26, 46], look: [0, 0, 0], fov: 55 }; });
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${out}/overview.png` });
await page.evaluate(() => { window.__freeCam = { pos: [-14, 2.2, 30], look: [4, 1.2, -20], fov: 60 }; });
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${out}/street.png` });
await browser.close();
process.exit(ok ? 0 : 1);
