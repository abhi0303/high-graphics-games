import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Accumulates procedural geometry grouped by material key and emits one merged
 * BufferGeometry per key. Primitives are emitted in a local frame set with
 * setTransform(); UVs are metric (1 unit = 1 m) and planar-projected in that
 * local frame, so adjacent pieces of one facade share a continuous texture.
 */
export class GeoBuilder {
  constructor() {
    this.groups = new Map();
    this.matrix = new THREE.Matrix4();
    this.normalMatrix = new THREE.Matrix3();
    this.color = [1, 1, 1];
    this.uvOffset = [0, 0];
  }

  setTransform(matrix) {
    this.matrix.copy(matrix);
    this.normalMatrix.getNormalMatrix(matrix);
    return this;
  }

  setColor(c) {
    if (Array.isArray(c)) this.color = c;
    else { const col = new THREE.Color(c); this.color = [col.r, col.g, col.b]; }
    return this;
  }

  #group(key) {
    let g = this.groups.get(key);
    if (!g) {
      g = { pos: [], nor: [], uv: [], col: [], idx: [], extra: null, count: 0 };
      this.groups.set(key, g);
    }
    return g;
  }

  /** Raw vertex push in local space. */
  #vert(g, p, n, uv, extra) {
    _v.set(p[0], p[1], p[2]).applyMatrix4(this.matrix);
    _n.set(n[0], n[1], n[2]).applyMatrix3(this.normalMatrix).normalize();
    g.pos.push(_v.x, _v.y, _v.z);
    g.nor.push(_n.x, _n.y, _n.z);
    g.uv.push(uv[0] + this.uvOffset[0], uv[1] + this.uvOffset[1]);
    g.col.push(this.color[0], this.color[1], this.color[2]);
    if (extra) {
      if (!g.extra) g.extra = { size: extra.length, data: new Array(g.count * extra.length).fill(0) };
      g.extra.data.push(...extra);
    } else if (g.extra) {
      for (let i = 0; i < g.extra.size; i++) g.extra.data.push(0);
    }
    return g.count++;
  }

  /**
   * Quad from 4 corners (counter-clockwise seen from the front) with explicit uvs.
   * extra: optional per-vertex attribute (array) shared by all 4 corners.
   */
  quad(key, a, b, c, d, n, uvs, extra) {
    const g = this.#group(key);
    const i0 = this.#vert(g, a, n, uvs[0], extra);
    this.#vert(g, b, n, uvs[1], extra);
    this.#vert(g, c, n, uvs[2], extra);
    this.#vert(g, d, n, uvs[3], extra);
    g.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }

  /**
   * Vertical rectangle in the plane facing +Z (local), spanning x0..x1, y0..y1 at depth z.
   * Use with a transform to orient. Metric UV = (x, y).
   */
  wallZ(key, x0, x1, y0, y1, z, flip = false) {
    if (flip) {
      this.quad(key, [x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], [0, 0, -1],
        [[-x1, y0], [-x0, y0], [-x0, y1], [-x1, y1]]);
    } else {
      this.quad(key, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1],
        [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    }
  }

  /** Vertical rectangle facing +X (local) at x, spanning z0..z1 and y0..y1. */
  wallX(key, z0, z1, y0, y1, x, flip = false) {
    if (flip) {
      this.quad(key, [x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], [-1, 0, 0],
        [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
    } else {
      this.quad(key, [x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], [1, 0, 0],
        [[-z1, y0], [-z0, y0], [-z0, y1], [-z1, y1]]);
    }
  }

  /** Horizontal rectangle at height y facing up (or down). */
  floorY(key, x0, x1, z0, z1, y, down = false) {
    if (down) {
      this.quad(key, [x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, -1, 0],
        [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
    } else {
      this.quad(key, [x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0],
        [[x0, -z1], [x1, -z1], [x1, -z0], [x0, -z0]]);
    }
  }

  /**
   * Axis-aligned box (in the local frame) from min to max corner.
   * faces: string of faces to emit, any of "xXyYzZ" (lower = negative side).
   */
  box(key, min, max, faces = 'xXyYzZ') {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    if (faces.includes('Z')) this.wallZ(key, x0, x1, y0, y1, z1);
    if (faces.includes('z')) this.wallZ(key, x0, x1, y0, y1, z0, true);
    if (faces.includes('X')) this.wallX(key, z0, z1, y0, y1, x1);
    if (faces.includes('x')) this.wallX(key, z0, z1, y0, y1, x0, true);
    if (faces.includes('Y')) this.floorY(key, x0, x1, z0, z1, y1);
    if (faces.includes('y')) this.floorY(key, x0, x1, z0, z1, y0, true);
  }

  /** Append an existing (non-indexed or indexed) BufferGeometry transformed by the current matrix. */
  geometry(key, geom, uvScale = 1) {
    const g = this.#group(key);
    const pos = geom.attributes.position;
    const nor = geom.attributes.normal;
    const uv = geom.attributes.uv;
    const base = g.count;
    for (let i = 0; i < pos.count; i++) {
      this.#vert(g, [pos.getX(i), pos.getY(i), pos.getZ(i)], [nor.getX(i), nor.getY(i), nor.getZ(i)],
        uv ? [uv.getX(i) * uvScale, uv.getY(i) * uvScale] : [0, 0]);
    }
    if (geom.index) for (let i = 0; i < geom.index.count; i++) g.idx.push(base + geom.index.getX(i));
    else for (let i = 0; i < pos.count; i++) g.idx.push(base + i);
  }

  build() {
    const out = new Map();
    for (const [key, g] of this.groups) {
      if (!g.count) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
      if (g.extra) geom.setAttribute('aExtra', new THREE.Float32BufferAttribute(g.extra.data, g.extra.size));
      geom.setIndex(g.count > 65535 ? new THREE.Uint32BufferAttribute(g.idx, 1) : new THREE.Uint16BufferAttribute(g.idx, 1));
      geom.computeBoundingSphere();
      geom.computeBoundingBox();
      out.set(key, geom);
    }
    return out;
  }
}
