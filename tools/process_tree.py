"""Turn a dense Poly Haven scanned tree into a real-time friendly GLB.

Run headless with Blender:
  Blender -b --python tools/process_tree.py -- <src.gltf> <out.glb> <leaf_keep> <leaf_scale> <twig_keep> <decimate>

The source trees have ~1M leaf triangles made of ~44k separate 24-triangle leaves.
Instead of decimating (which mangles leaf silhouettes) we keep a random subset
of whole leaves and scale each kept leaf about its own centre so the canopy keeps
its coverage. Twigs are thinned the same way; trunk and leaves are additionally
decimated, and the result is exported as a Draco-compressed GLB.
"""
import sys
import bpy
import bmesh
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
LEAF_KEEP, LEAF_SCALE, TWIG_KEEP, DECIMATE = map(float, argv[2:6])
rng = np.random.default_rng(7)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

src = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
bpy.context.view_layer.objects.active = src
src.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.separate(type='MATERIAL')
bpy.ops.object.mode_set(mode='OBJECT')


def components(me):
    """Connected-component label per triangle (vertices welded by position)."""
    nv, nf = len(me.vertices), len(me.polygons)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    tri = np.empty(nf * 3, np.int64)
    me.polygons.foreach_get('vertices', tri)
    tri = tri.reshape(-1, 3)
    _, weld = np.unique(np.round(co / 1e-4).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.ravel()
    t = weld[tri]
    lab = np.arange(weld.max() + 1)
    while True:
        m = lab[t].min(axis=1)
        new = lab.copy()
        for k in range(3):
            np.minimum.at(new, t[:, k], m)
        new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    return co, tri, lab[t[:, 0]], weld, lab


def thin(obj, keep, scale):
    me = obj.data
    co, tri, flab, weld, lab = components(me)
    ids = np.unique(flab)
    kept = set(rng.choice(ids, size=max(1, int(len(ids) * keep)), replace=False).tolist())
    keep_face = np.fromiter((l in kept for l in flab), bool, len(flab))
    if scale != 1.0:
        vlab = lab[weld]
        # centroid per component
        uniq, inv = np.unique(vlab, return_inverse=True)
        cent = np.zeros((len(uniq), 3))
        np.add.at(cent, inv, co)
        cent /= np.bincount(inv)[:, None]
        co = cent[inv] + (co - cent[inv]) * scale
        me.vertices.foreach_set('co', co.astype(np.float32).ravel())
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f, k in zip(bm.faces, keep_face) if not k], context='FACES')
    bm.to_mesh(me)
    bm.free()
    print(f'{obj.name}: kept {len(kept)}/{len(ids)} components, {len(me.polygons)} tris')


def decimate(obj, ratio):
    mod = obj.modifiers.new('dec', 'DECIMATE')
    mod.ratio = ratio
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    print(f'{obj.name}: decimated to {len(obj.data.polygons)} faces')


for obj in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
    name = obj.active_material.name
    if name.endswith('_leaves'):
        thin(obj, LEAF_KEEP, LEAF_SCALE)
        decimate(obj, max(DECIMATE, 0.5))
        obj.name = 'leaves'
    elif name.endswith('_branches'):
        thin(obj, TWIG_KEEP, 1.0)
        decimate(obj, DECIMATE)
        obj.name = 'branches'
    else:
        decimate(obj, max(DECIMATE, 0.25))
        obj.name = 'trunk'

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=7,
    export_image_format='JPEG',
    export_jpeg_quality=88,
    export_apply=True,
)
print('wrote', OUT)
