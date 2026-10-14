"""Decimate a glTF prop and export a Draco GLB (run with Blender in background mode).

  Blender -b --python tools/decimate_prop.py -- <src.gltf> <out.glb> <ratio> [name_filter]

name_filter keeps only mesh objects whose name contains the given substring
(e.g. "aged" to keep the weathered variant of a multi-variant asset), and
re-centres the kept objects on the origin at ground level.
"""
import sys
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT, RATIO = argv[0], argv[1], float(argv[2])
FILTER = argv[3] if len(argv) > 3 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if FILTER:
    for o in meshes:
        if FILTER not in o.name:
            bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    # re-centre horizontally
    xs = [o.matrix_world.translation.x for o in meshes]
    zs = [o.matrix_world.translation.y for o in meshes]
    cx, cz = sum(xs) / len(xs), sum(zs) / len(zs)
    for o in meshes:
        if o.parent is None:
            o.location.x -= cx
            o.location.y -= cz

before = sum(len(o.data.polygons) for o in meshes)
for o in meshes:
    if RATIO < 1.0 and len(o.data.polygons) > 300:
        mod = o.modifiers.new('dec', 'DECIMATE')
        mod.ratio = RATIO
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
after = sum(len(o.data.polygons) for o in meshes)
print(f'{SRC}: {before} -> {after} faces')

bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB',
    export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
    export_image_format='JPEG', export_jpeg_quality=88, export_apply=True,
)
