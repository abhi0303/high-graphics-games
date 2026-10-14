#!/usr/bin/env node
// Automated gameplay smoke test: drives the car with real key events and
// reports speed / position / heading, saving a screenshot per phase.
// Usage: node scripts/drive-test.mjs [--url http://localhost:5173/] [--out dir]
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const url = args.url ?? 'http://localhost:5173/';
const out = args.out ?? 'drive-test';
mkdirSync(out, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, protocolTimeout: 240000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}?quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000 });
await page.focus('canvas');

const state = () => page.evaluate(() => {
  const v = window.__game.vehicle;
  const p = v.body.translation();
  return { speedKmh: +(v.speed * 3.6).toFixed(1), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), heading: +(v.heading() * 57.3).toFixed(1) };
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hold = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of keys) await page.keyboard.up(k);
};

const phases = [
  ['idle', [], 1000],
  ['accelerate', ['KeyW'], 3000],
  ['coast', [], 1000],
  ['brake', ['KeyS'], 1500],
  ['turn-left', ['KeyW', 'KeyA'], 2500],
  ['handbrake-turn', ['KeyW', 'KeyD', 'Space'], 1500],
  ['reverse', ['KeyS'], 3000],
  ['camera-cycle', ['KeyC'], 300],
  ['drive-far-cam', ['KeyW'], 2000],
];
console.log('start', await state());
for (const [name, keys, ms] of phases) {
  await hold(keys, ms);
  console.log(name.padEnd(16), JSON.stringify(await state()));
  await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
