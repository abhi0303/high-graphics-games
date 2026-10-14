import * as THREE from 'three';
import { ROADS } from '../world/layout.js';

/**
 * Lane network for AI traffic, derived from the same road layout the streets are
 * built from (world/layout.js), so lanes always sit on the painted lanes.
 *
 * - Segments: one per lane per direction between two consecutive intersections of the
 *   inner 3×3 grid (dead-end stubs toward the map edge are not used, so every route
 *   loops forever and no vehicle ever has to be teleported).
 * - Connectors: smooth cubic Béziers across each intersection for straight, right and
 *   left movements, from the stop bar of the approach to just past the far crosswalk.
 *
 * Driving is on the right. Distances along paths are in metres.
 */

// Offsets measured from the intersection centre along the road (match roads.js markings).
const STOP_PAST_EDGE = 6.4; // stop bar sits hz + 6.1 from the centre; front bumper stops just before it
const EXIT_PAST_EDGE = 5.0; // beyond the far crosswalk

export class Path {
  constructor(points, meta) {
    this.points = points;
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + points[i].distanceTo(points[i - 1]));
    this.length = this.cum[this.cum.length - 1];
    Object.assign(this, meta);
  }

  /** Position and unit tangent at distance s (clamped). */
  sample(s, outPos, outDir) {
    const c = this.cum;
    s = Math.min(Math.max(s, 0), this.length);
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid; else hi = mid;
    }
    const a = this.points[lo], b = this.points[hi];
    const t = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
    outPos.lerpVectors(a, b, t);
    outDir.subVectors(b, a).normalize();
    return outPos;
  }

  /** Curvature-limited speed (m/s) for the tightest part of the path. */
  maxSpeed(lateralAccel) {
    if (this.kind !== 'turn') return Infinity;
    return Math.sqrt(lateralAccel * this.radius);
  }
}

function laneOffsets(road) {
  const out = [];
  let o = 0.18;
  for (const w of road.lanes) { out.push(o + w / 2); o += w; }
  return out;
}

function bezier(p0, p1, p2, p3, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push(new THREE.Vector3()
      .addScaledVector(p0, u * u * u).addScaledVector(p1, 3 * u * u * t)
      .addScaledVector(p2, 3 * u * t * t).addScaledVector(p3, t * t * t));
  }
  return pts;
}

/** Intersection of the lines p + t·d and q + s·e in the XZ plane. */
function lineHit(p, d, q, e) {
  const den = d.x * e.z - d.z * e.x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / den;
  return p.clone().addScaledVector(d, t);
}

export function buildLaneGraph() {
  const segments = [];
  const intersections = [];
  const xs = ROADS.ns.map((r) => r.x);
  const zs = ROADS.ew.map((r) => r.z);
  const nsRoad = (x) => ROADS.ns.find((r) => r.x === x);
  const ewRoad = (z) => ROADS.ew.find((r) => r.z === z);

  for (const ns of ROADS.ns) for (const ew of ROADS.ew) {
    intersections.push({ x: ns.x, z: ew.z, hx: ns.width / 2, hz: ew.width / 2, ns, ew, approaches: [], exits: [], connectors: [] });
  }
  const X = (x, z) => intersections.find((i) => i.x === x && i.z === z);

  // ---------------------------------------------------------------- segments
  const addSeg = (road, axis, lane, nLanes, dir, a, b, from, to, offset) => {
    // dir: +1 travels toward increasing coordinate, -1 toward decreasing
    const P = (along) => (axis === 'ns' ? new THREE.Vector3(road.x + offset, 0, along) : new THREE.Vector3(along, 0, road.z + offset));
    const seg = new Path([P(a), P(b)], {
      kind: 'segment', axis, road, lane, nLanes, dir, from, to,
      heading: axis === 'ns' ? (dir < 0 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 0, 1)) : (dir > 0 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0)),
      speedLimit: road.name === 'Grand Blvd' ? 15.5 : road.name === 'Vine Ave' ? 13.5 : 12,
      outgoing: [],
      index: segments.length,
    });
    segments.push(seg);
    from.exits.push(seg);
    to.approaches.push(seg);
    return seg;
  };

  for (const road of ROADS.ns) {
    const offs = laneOffsets(road);
    for (let i = 0; i < zs.length - 1; i++) {
      const A = X(road.x, zs[i]), B = X(road.x, zs[i + 1]); // A north (smaller z), B south
      offs.forEach((o, k) => {
        // northbound (toward -z) on the east half, from B to A
        addSeg(road, 'ns', k, offs.length, -1, B.z - (B.hz + EXIT_PAST_EDGE), A.z + (A.hz + STOP_PAST_EDGE), B, A, +o);
        // southbound (toward +z) on the west half, from A to B
        addSeg(road, 'ns', k, offs.length, +1, A.z + (A.hz + EXIT_PAST_EDGE), B.z - (B.hz + STOP_PAST_EDGE), A, B, -o);
      });
    }
  }
  for (const road of ROADS.ew) {
    const offs = laneOffsets(road);
    for (let i = 0; i < xs.length - 1; i++) {
      const W = X(xs[i], road.z), E = X(xs[i + 1], road.z);
      offs.forEach((o, k) => {
        // eastbound (+x) on the south half (z + o), from W to E
        addSeg(road, 'ew', k, offs.length, +1, W.x + (W.hx + EXIT_PAST_EDGE), E.x - (E.hx + STOP_PAST_EDGE), W, E, +o);
        // westbound (-x) on the north half (z - o), from E to W
        addSeg(road, 'ew', k, offs.length, -1, E.x - (E.hx + EXIT_PAST_EDGE), W.x + (W.hx + STOP_PAST_EDGE), E, W, -o);
      });
    }
  }

  // ---------------------------------------------------------------- connectors
  const turnOf = (hin, hout) => {
    const cross = hin.x * hout.z - hin.z * hout.x; // y of hin × hout
    if (hin.dot(hout) > 0.9) return 'straight';
    return cross > 0 ? 'right' : 'left';            // +y cross = clockwise from above = right turn
  };
  for (const I of intersections) {
    for (const a of I.approaches) {
      const p0 = a.points[a.points.length - 1];
      for (const e of I.exits) {
        const move = turnOf(a.heading, e.heading);
        if (a.heading.dot(e.heading) < -0.9) continue; // no U-turns
        // lane discipline: right turns from the outermost lane into the outermost lane,
        // left turns from the innermost into the innermost, straight keeps its lane
        if (move === 'straight' && e.lane !== a.lane) continue;
        if (move === 'right' && (a.lane !== a.nLanes - 1 || e.lane !== e.nLanes - 1)) continue;
        if (move === 'left' && (a.lane !== 0 || e.lane !== 0)) continue;
        const p3 = e.points[0];
        let pts;
        let radius = Infinity;
        if (move === 'straight') {
          pts = [p0.clone(), p3.clone()];
        } else {
          const c = lineHit(p0, a.heading, p3, e.heading) ?? p0.clone().lerp(p3, 0.5);
          const k = 0.5523;
          pts = bezier(p0, p0.clone().lerp(c, k), p3.clone().lerp(c, k), p3);
          radius = Math.min(p0.distanceTo(c), p3.distanceTo(c));
        }
        const con = new Path(pts, {
          kind: move === 'straight' ? 'straight' : 'turn', move, radius, from: a, to: e, intersection: I,
          axis: a.axis, speedLimit: move === 'straight' ? a.speedLimit : move === 'right' ? 5.5 : 7.5,
        });
        a.outgoing.push(con);
        I.connectors.push(con);
      }
    }
  }
  // Lanes that would otherwise dead-end (e.g. a middle lane where "straight" leads off the grid)
  // may turn from where they are so every approach has at least one way on.
  for (const I of intersections) {
    for (const a of I.approaches) {
      if (a.outgoing.length) continue;
      const p0 = a.points[a.points.length - 1];
      for (const e of I.exits) {
        if (a.heading.dot(e.heading) < -0.9) continue;
        const move = turnOf(a.heading, e.heading);
        if (move === 'straight') continue;
        const target = move === 'right' ? e.nLanes - 1 : 0;
        if (e.lane !== target) continue;
        const p3 = e.points[0];
        const c = lineHit(p0, a.heading, p3, e.heading);
        const pts = bezier(p0, p0.clone().lerp(c, 0.5523), p3.clone().lerp(c, 0.5523), p3);
        const con = new Path(pts, { kind: 'turn', move, radius: Math.min(p0.distanceTo(c), p3.distanceTo(c)), from: a, to: e, intersection: I, axis: a.axis, speedLimit: move === 'right' ? 5.5 : 7.5 });
        a.outgoing.push(con);
        I.connectors.push(con);
      }
    }
  }
  // Oncoming approach (same road, opposite direction) for permissive left-turn yielding.
  for (const I of intersections) {
    for (const a of I.approaches) {
      a.oncoming = I.approaches.filter((b) => b.axis === a.axis && b.heading.dot(a.heading) < -0.9);
    }
  }
  return { segments, intersections };
}
