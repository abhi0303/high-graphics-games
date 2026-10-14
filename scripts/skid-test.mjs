#!/usr/bin/env node
// Tyre-mark behaviour test: light braking must leave nothing, hard braking and the
// handbrake must leave marks, and the ring buffer must stay bounded.
// Usage: node scripts/skid-test.mjs [--url http://localhost:5173/] [--out dir]
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url ?? 'http://localhost:5173/';
const out = args.out ?? 'skid-test';
mkdirSync(out, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 240000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
await page.goto(`${url}?quality=medium&traffic=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000 });
await page.focus('canvas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = () => page.evaluate(() => ({ quads: window.__game.skids.count, kmh: +(window.__game.vehicle.speed * 3.6).toFixed(1) }));
const toSpeed = async (kmh) => {
  await page.keyboard.down('KeyW');
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && (await st()).kmh < kmh) await sleep(40);
  await page.keyboard.up('KeyW');
};
let ok = true;
const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info)}`); ok &&= cond; };

await page.evaluate(() => window.__game.vehicle.reset({ x: -95, z: 5.4, heading: -Math.PI / 2 }));
await sleep(700);
await toSpeed(60);
const a = await st();
await page.keyboard.down('KeyS'); await sleep(150); await page.keyboard.up('KeyS');
await sleep(400);
const b = await st();
check('light brake tap leaves no marks', b.quads === a.quads, { before: a, after: b });

await toSpeed(70);
const c = await st();
await page.keyboard.down('KeyS'); await sleep(1800); await page.keyboard.up('KeyS');
const d = await st();
check('hard braking leaves marks', d.quads - c.quads > 8, { before: c, after: d });
await page.evaluate(() => { window.__freeCam = (() => { const p = window.__game.vehicle.body.translation(); return { pos: [p.x - 14, 9, p.z + 9], look: [p.x - 8, 0, p.z], fov: 55 }; })(); });
await sleep(300);
await page.screenshot({ path: `${out}/hard-brake.png` });
await page.evaluate(() => { window.__freeCam = null; });

await page.evaluate(() => window.__game.vehicle.reset({ x: -60, z: 5.4, heading: -Math.PI / 2 }));
await sleep(700);
await toSpeed(45);
const e = await st();
await page.keyboard.down('KeyW'); await page.keyboard.down('KeyA'); await page.keyboard.down('Space');
await sleep(1300);
await page.keyboard.up('Space'); await page.keyboard.up('KeyA'); await page.keyboard.up('KeyW');
const f = await st();
check('handbrake turn leaves marks', f.quads - e.quads > 8, { before: e, after: f });
await page.evaluate(() => { window.__freeCam = (() => { const p = window.__game.vehicle.body.translation(); return { pos: [p.x + 2, 12, p.z + 14], look: [p.x - 4, 0, p.z - 2], fov: 55 }; })(); });
await sleep(300);
await page.screenshot({ path: `${out}/handbrake.png` });

const cap = await page.evaluate(() => { const s = window.__game.skids; return { count: s.count, drawRange: s.geometry.drawRange.count, capacityQuads: s.pos.length / 12 }; });
check('ring buffer bounded', cap.count <= cap.capacityQuads && cap.drawRange === cap.count * 6, cap);
check('no console errors', errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(ok ? 0 : 1);
