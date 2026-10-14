"""Print per-primitive connected-component statistics for a glTF file (run with Blender's bundled python)."""
import json, sys, os
import numpy as np

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

def load(path):
    g = json.load(open(path))
    base = os.path.dirname(path)
    bufs = [np.fromfile(os.path.join(base, b['uri']), dtype=np.uint8) for b in g['buffers']]
    def acc(i):
        a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
        dt = COMP[a['componentType']]; n = NCOMP[a['type']]
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        raw = bufs[bv['buffer']][off: off + a['count'] * n * np.dtype(dt).itemsize]
        return np.frombuffer(raw.tobytes(), dtype=dt).reshape(a['count'], n) if n > 1 else np.frombuffer(raw.tobytes(), dtype=dt)
    return g, acc

def components(idx, nverts, pos=None):
    tri = idx.reshape(-1, 3).astype(np.int64)
    # weld by position so UV seams don't split a leaf
    if pos is not None:
        q = np.round(pos / 1e-4).astype(np.int64)
        _, remap = np.unique(q, axis=0, return_inverse=True)
        tri = remap.ravel()[tri]
        nverts = remap.max() + 1
    lab = np.arange(nverts)
    for it in range(200):
        m = lab[tri].min(axis=1)
        new = lab.copy()
        np.minimum.at(new, tri[:, 0], m); np.minimum.at(new, tri[:, 1], m); np.minimum.at(new, tri[:, 2], m)
        new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    tl = lab[tri[:, 0]]
    return tl, it

if __name__ == '__main__':
    g, acc = load(sys.argv[1])
    for m in g['meshes']:
        for p in m['primitives']:
            pos = acc(p['attributes']['POSITION']); idx = acc(p['indices'])
            tl, it = components(idx, len(pos), pos)
            u, c = np.unique(tl, return_counts=True)
            print(g['materials'][p['material']]['name'], 'tris', len(tl), 'components', len(u), 'iters', it,
                  'tris/comp median', np.median(c), 'max', c.max(), 'bbox', pos.min(0), pos.max(0))
