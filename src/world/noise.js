import * as THREE from 'three';

/**
 * Tileable value-noise fBm texture generated at startup. Four channels hold
 * independent octave mixes, used by shaders for large-scale material variation
 * (stains, tint drift, wear) so repeating photo textures don't read as tiles.
 */
export function createNoiseTexture(size = 256, seed = 1) {
  const data = new Uint8Array(size * size * 4);
  const lattice = (n, s) => {
    const g = new Float32Array(n * n);
    let a = s * 9301 + 49297;
    for (let i = 0; i < g.length; i++) {
      a = (a * 16807) % 2147483647;
      g[i] = (a % 10000) / 10000;
    }
    return g;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (g, n, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const i = (a, b) => g[((b % n + n) % n) * n + ((a % n + n) % n)];
    const top = i(xi, yi) * (1 - xf) + i(xi + 1, yi) * xf;
    const bot = i(xi, yi + 1) * (1 - xf) + i(xi + 1, yi + 1) * xf;
    return top * (1 - yf) + bot * yf;
  };
  const channels = [
    [4, 8, 16, 32],
    [3, 6, 12, 24],
    [8, 16, 32, 64],
    [2, 4, 8, 16],
  ];
  const grids = channels.map((octs, c) => octs.map((n, o) => lattice(n, seed * 31 + c * 7 + o)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        let v = 0, amp = 0.5, total = 0;
        channels[c].forEach((n, o) => {
          v += sample(grids[c][o], n, (x / size) * n, (y / size) * n) * amp;
          total += amp;
          amp *= 0.5;
        });
        data[(y * size + x) * 4 + c] = Math.round((v / total) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
