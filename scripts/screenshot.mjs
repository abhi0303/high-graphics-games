#!/usr/bin/env node
// Renders the game in headless Chrome (real GPU) and saves screenshots.
// Usage: node scripts/screenshot.mjs [--url http://localhost:5173] [--view reference] [--out shot.png]
//        [--w 2160 --h 1220] [--wait 4000] [--quality high] [--extra "&sky=..."]
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const url = args.url ?? 'http://localhost:5173/';
const view = args.view ?? 'reference';
const out = args.out ?? `screenshot-${view}.png`;
const w = Number(args.w ?? 2160);
const h = Number(args.h ?? 1220);
const wait = Number(args.wait ?? 3000);
const quality = args.quality ?? 'ultra';

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', `--window-size=${w},${h}`],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
  protocolTimeout: 240000,
});
const page = await browser.newPage();
page.on('console', (m) => { if (['error', 'warning', 'info'].includes(m.type())) console.log(`[${m.type()}]`, m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const full = `${url}?capture&view=${view}&quality=${quality}${args.extra ?? ''}`;
const t0 = Date.now();
await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__ready === true || window.__error', { timeout: 240000, polling: 250 });
const err = await page.evaluate('window.__error');
if (err) { console.error('Game error:', err); await browser.close(); process.exit(1); }
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await new Promise((r) => setTimeout(r, wait));
const info = await page.evaluate(() => {
  const g = window.__game;
  const i = g.renderer.info;
  const gl = g.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { calls: i.render.calls, tris: i.render.triangles, gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?' };
});
console.log('render info', info);
if (args.eval) console.log('eval:', await page.evaluate(args.eval));
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
