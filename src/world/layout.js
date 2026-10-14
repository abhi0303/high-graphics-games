/**
 * City layout: the single source of truth for streets, blocks and the hero
 * intersection. World axes: +X east, -Z north, +Y up, metres.
 *
 * The playable map is a 3×3 street grid. The main intersection (origin) is
 * where "Vine Ave" (north–south, 20 m) crosses "Grand Blvd" (east–west, 24 m),
 * reproducing the reference shot: the car waits northbound at the south leg.
 */

export const MAP_HALF = 185;
export const SIDEWALK_W = 4.6;
export const CURB_H = 0.15;
export const CORNER_R = 6.5;

/** Lane plan per road half (from centre line outwards), in metres. */
export const ROADS = {
  ns: [
    { name: 'Pine St', x: -112, width: 15, lanes: [3.4], parking: 3.75 },
    { name: 'Vine Ave', x: 0, width: 20, lanes: [3.35, 3.35], parking: 3.15, turnLane: true },
    { name: 'Hill St', x: 112, width: 15, lanes: [3.4], parking: 3.75 },
  ],
  ew: [
    { name: '3rd St', z: -112, width: 15, lanes: [3.4], parking: 3.75 },
    { name: 'Grand Blvd', z: 0, width: 24, lanes: [3.6, 3.6, 3.6], parking: 0.85 },
    { name: '5th St', z: 112, width: 15, lanes: [3.4], parking: 3.75 },
  ],
};

/** Edges of every city block (curb lines) in world space. */
export function computeBlocks() {
  const xs = edges(ROADS.ns.map((r) => [r.x, r.width]));
  const zs = edges(ROADS.ew.map((r) => [r.z, r.width]));
  const blocks = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < zs.length; j++) {
      const [x0, x1] = xs[i];
      const [z0, z1] = zs[j];
      blocks.push({
        id: `${i}-${j}`,
        i, j,
        x0, x1, z0, z1,
        cx: (x0 + x1) / 2,
        cz: (z0 + z1) / 2,
        w: x1 - x0,
        d: z1 - z0,
        // which sides face a street (outer map edge has no street)
        streets: { w: i > 0, e: i < xs.length - 1, n: j > 0, s: j < zs.length - 1 },
      });
    }
  }
  return blocks;
}

function edges(roads) {
  const out = [];
  let prev = -MAP_HALF - 40;
  for (const [c, w] of roads) {
    out.push([prev, c - w / 2]);
    prev = c + w / 2;
  }
  out.push([prev, MAP_HALF + 40]);
  return out;
}

export const INTERSECTIONS = ROADS.ns.flatMap((ns) => ROADS.ew.map((ew) => ({ ns, ew, x: ns.x, z: ew.z })));

/** The hero placement of the player car, matching the reference shot. */
export const CAR_START = { x: 7.9, z: 20.0, heading: 0.3 };

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * f());
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  return f;
}
