import * as THREE from 'three';
import { rng } from './layout.js';

/**
 * Procedurally painted signage atlas (all names fictional). One canvas holds
 * storefront fascia signs, pole-sign panels, street-name blades and
 * billboards so the whole city's signage is a single material.
 */
const FONT_HEAVY = '"Arial Black", "Helvetica Neue", Impact, sans-serif';
const FONT_COND = 'Impact, "Arial Narrow", "Helvetica Neue", sans-serif';
const FONT_SERIF = 'Georgia, "Times New Roman", serif';

export const SHOP_SIGNS = [
  { id: 'auto', text: 'GLASS & BRAKE AUTO REPAIRS', bg: '#f1e7c9', fg: '#b3221b', font: FONT_COND, border: '#2a2a2a' },
  { id: 'pho', text: 'PHO 88 NOODLE HOUSE', bg: '#c8261d', fg: '#ffe9a8', font: FONT_HEAVY },
  { id: 'buffet', text: 'CHINA BUFFET', bg: '#ffe25a', fg: '#c01a12', font: FONT_HEAVY, border: '#c01a12' },
  { id: 'donut', text: 'DONUTS · COFFEE', bg: '#ffffff', fg: '#e0457b', font: FONT_HEAVY, border: '#e0457b' },
  { id: 'liquor', text: 'LIQUOR  DELI  ATM', bg: '#1d3f8f', fg: '#ffffff', font: FONT_COND },
  { id: 'tires', text: 'TIRES & WHEELS', bg: '#151515', fg: '#f2c230', font: FONT_HEAVY },
  { id: 'laundry', text: 'COIN LAUNDRY', bg: '#3b9ad6', fg: '#ffffff', font: FONT_HEAVY },
  { id: 'tacos', text: 'TACOS EL GÜERO', bg: '#2f8a3a', fg: '#ffffff', font: FONT_HEAVY, border: '#e13a2b' },
  { id: 'pawn', text: 'GOLD & PAWN', bg: '#141414', fg: '#e9c35c', font: FONT_SERIF },
  { id: 'phones', text: 'CELL PHONES · REPAIR', bg: '#e8e8e8', fg: '#1a1a1a', font: FONT_COND, border: '#d42020' },
  { id: 'beauty', text: 'BEAUTY SUPPLY', bg: '#f6d2df', fg: '#7a1d48', font: FONT_SERIF },
  { id: 'dental', text: 'FAMILY DENTAL', bg: '#ffffff', fg: '#2365a6', font: FONT_COND },
  { id: 'pizza', text: 'PIZZA  WINGS', bg: '#b51d1d', fg: '#ffffff', font: FONT_HEAVY },
  { id: 'insure', text: 'AUTO INSURANCE', bg: '#f5a623', fg: '#1d1d1d', font: FONT_HEAVY },
  { id: 'market', text: 'SUPER MERCADO', bg: '#0e6b3d', fg: '#ffe600', font: FONT_HEAVY },
  { id: 'smog', text: 'SMOG CHECK', bg: '#ffd400', fg: '#163a8c', font: FONT_HEAVY },
  { id: 'chicken', text: 'CLUCK HOUSE', bg: '#e64a19', fg: '#fff3c4', font: FONT_HEAVY },
  { id: 'motel', text: 'MOTEL', bg: '#22313f', fg: '#ff5a4f', font: FONT_HEAVY },
  { id: 'nails', text: 'NAILS & SPA', bg: '#7b3fa0', fg: '#ffffff', font: FONT_SERIF },
  { id: 'cash', text: 'CHECK CASHING', bg: '#0c7d3b', fg: '#ffffff', font: FONT_HEAVY },
];

export const BILLBOARDS = [
  { id: 'bb-cola', lines: ['ICE COLD', 'FIZZ'], sub: 'Taste the sunshine', bg: ['#d81e2b', '#7e0a12'], fg: '#ffffff' },
  { id: 'bb-bank', lines: ['SUNSET', 'SAVINGS BANK'], sub: '0% fees. Seriously.', bg: ['#0b3d6b', '#0a1d33'], fg: '#ffd166' },
  { id: 'bb-air', lines: ['FLY', 'AERO PACIFIC'], sub: 'LAX ➝ HNL from $199', bg: ['#2bb0e6', '#0a5f9e'], fg: '#ffffff' },
  { id: 'bb-film', lines: ['NIGHT', 'FEVER'], sub: 'Now playing', bg: ['#1b0f2e', '#5a1e6d'], fg: '#ffcf33' },
];

const SLOT_W = 1024;
const SLOT_H = 160;

export class SignAtlas {
  constructor(maxAnisotropy = 8) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 4096;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.slots = new Map();
    this.R = rng(1234);
    this.#paint();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAnisotropy;
    tex.flipY = true;
    this.texture = tex;
    this.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.0, vertexColors: true });
    // lightbox panels glow a little even in daylight
    this.lightbox = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: new THREE.Color(0.35, 0.35, 0.35), roughness: 0.35, metalness: 0.0, vertexColors: true,
    });
  }

  /** uv rect {u0,v0,u1,v1} for a slot id. */
  uv(id) { return this.slots.get(id); }

  #slot(id, x, y, w, h) {
    const W = this.canvas.width, H = this.canvas.height;
    this.slots.set(id, { u0: x / W, u1: (x + w) / W, v0: 1 - (y + h) / H, v1: 1 - y / H, aspect: w / h });
  }

  #paint() {
    const c = this.ctx;
    let x = 0, y = 0;
    const place = (w, h) => {
      if (x + w > this.canvas.width) { x = 0; y += this._rowH; this._rowH = 0; }
      const p = [x, y];
      x += w;
      this._rowH = Math.max(this._rowH ?? 0, h);
      return p;
    };

    for (const s of SHOP_SIGNS) {
      const [px, py] = place(SLOT_W, SLOT_H);
      this.#fascia(px, py, SLOT_W, SLOT_H, s);
      this.#slot(s.id, px, py, SLOT_W, SLOT_H);
    }
    // pole-sign panels (squarer)
    for (const s of SHOP_SIGNS) {
      const [px, py] = place(512, 200);
      this.#fascia(px, py, 512, 200, { ...s, text: s.text.split(/ ·|  |&/)[0].trim() }, true);
      this.#slot(`${s.id}-pole`, px, py, 512, 200);
    }
    for (const b of BILLBOARDS) {
      const [px, py] = place(1024, 340);
      this.#billboard(px, py, 1024, 340, b);
      this.#slot(b.id, px, py, 1024, 340);
    }
    // street name blades
    for (const name of ['Grand Blvd', 'Vine Ave', 'Pine St', 'Hill St', '3rd St', '5th St']) {
      const [px, py] = place(512, 96);
      c.fillStyle = '#1f6b3a';
      c.fillRect(px, py, 512, 96);
      c.strokeStyle = '#f2f2f2';
      c.lineWidth = 5;
      c.strokeRect(px + 6, py + 6, 500, 84);
      c.fillStyle = '#f7f7f7';
      c.font = `bold 58px "Helvetica Neue", Arial, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(name, px + 256, py + 52);
      this.#slot(`street-${name}`, px, py, 512, 96);
    }
    // pedestrian crossing diamond
    {
      const [px, py] = place(256, 256);
      this.#pedSign(px, py, 256);
      this.#slot('ped', px, py, 256, 256);
    }
    // generic grime pass over the whole atlas
    this.#grime();
  }

  #fascia(x, y, w, h, s, compact = false) {
    const c = this.ctx;
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, shade(s.bg, 1.06));
    g.addColorStop(1, shade(s.bg, 0.86));
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
    if (s.border) {
      c.strokeStyle = s.border;
      c.lineWidth = h * 0.07;
      c.strokeRect(x + h * 0.06, y + h * 0.06, w - h * 0.12, h - h * 0.12);
    }
    c.fillStyle = s.fg;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    let size = h * (compact ? 0.42 : 0.6);
    c.font = `${size}px ${s.font}`;
    while (c.measureText(s.text).width > w * 0.9 && size > 10) {
      size *= 0.94;
      c.font = `${size}px ${s.font}`;
    }
    c.shadowColor = 'rgba(0,0,0,0.35)';
    c.shadowBlur = h * 0.02;
    c.shadowOffsetY = h * 0.015;
    c.fillText(s.text, x + w / 2, y + h * 0.54);
    c.shadowColor = 'transparent';
  }

  #billboard(x, y, w, h, b) {
    const c = this.ctx;
    const g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, b.bg[0]);
    g.addColorStop(1, b.bg[1]);
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
    // abstract graphic
    c.globalAlpha = 0.25;
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(x + w * 0.82, y + h * 0.5, h * 0.62, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = b.fg;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.font = `${h * 0.26}px ${FONT_HEAVY}`;
    c.fillText(b.lines[0], x + w * 0.06, y + h * 0.36);
    c.font = `${h * 0.21}px ${FONT_HEAVY}`;
    c.fillText(b.lines[1], x + w * 0.06, y + h * 0.64);
    c.font = `${h * 0.1}px "Helvetica Neue", Arial, sans-serif`;
    c.fillText(b.sub, x + w * 0.06, y + h * 0.84);
  }

  #pedSign(x, y, s) {
    const c = this.ctx;
    c.fillStyle = '#d6d6d0';
    c.fillRect(x, y, s, s);
    c.save();
    c.translate(x + s / 2, y + s / 2);
    c.rotate(Math.PI / 4);
    const k = s * 0.66;
    c.fillStyle = '#111';
    c.fillRect(-k / 2 - 4, -k / 2 - 4, k + 8, k + 8);
    c.fillStyle = '#f6d40e';
    c.fillRect(-k / 2, -k / 2, k, k);
    c.restore();
    // walking figure
    c.fillStyle = '#111';
    const cx = x + s / 2, cy = y + s / 2;
    c.beginPath(); c.arc(cx + 4, cy - 46, 11, 0, Math.PI * 2); c.fill();
    c.lineCap = 'round';
    c.strokeStyle = '#111';
    c.lineWidth = 13;
    c.beginPath(); c.moveTo(cx + 2, cy - 30); c.lineTo(cx - 4, cy + 10); c.stroke();
    c.lineWidth = 10;
    c.beginPath(); c.moveTo(cx - 4, cy + 10); c.lineTo(cx - 22, cy + 46); c.stroke();
    c.beginPath(); c.moveTo(cx - 4, cy + 10); c.lineTo(cx + 18, cy + 46); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - 22); c.lineTo(cx - 24, cy - 2); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - 22); c.lineTo(cx + 22, cy - 6); c.stroke();
  }

  #grime() {
    const c = this.ctx;
    const { width, height } = this.canvas;
    const R = this.R;
    c.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 2600; i++) {
      const x = R() * width, y = R() * height;
      const r = 2 + R() * 26;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.05 + R() * 0.12;
      g.addColorStop(0, `rgba(120,110,95,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // vertical drip streaks
    for (let i = 0; i < 500; i++) {
      const x = R() * width, y = R() * height;
      c.fillStyle = `rgba(110,100,90,${0.05 + R() * 0.08})`;
      c.fillRect(x, y, 1 + R() * 3, 10 + R() * 50);
    }
    c.globalCompositeOperation = 'source-over';
  }
}

function shade(hex, f) {
  const col = new THREE.Color(hex);
  col.multiplyScalar(f);
  return `#${col.getHexString()}`;
}
