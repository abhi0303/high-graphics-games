"""Standardise a downloaded vehicle model (GLB/glTF) for the traffic system.

Run headless with Blender:
  Blender -b --python tools/process_vehicle.py -- <src.glb> <out_dir> <slug> <config.json>

Output contract (consumed by src/traffic/*):
  <out_dir>/<slug>.glb       LOD0, Draco, Y-up, vehicle FRONT faces -Z (three.js), metres,
                             origin on the ground (y = 0 at tyre contact) centred between axles.
                             Nodes: one or more body meshes + 'wheel_fl','wheel_fr','wheel_rl','wheel_rr'
                             whose origins are the wheel centres; wheels spin about local X.
                             The main body-paint material is renamed 'paint' (recolourable).
  <out_dir>/<slug>_lod1.glb  Same structure, far cheaper.
  <out_dir>/<slug>.json      Dimensions, wheel centres/radius, lamp positions (three.js space).
  <preview_dir>/<slug>_*.png Front-3/4, rear-3/4, side and top renders for verification.

Config (JSON) keys, all optional except category:
  category            bus | sedan | hatchback | suv | minivan | van | pickup | taxi | truck
  target_length       bumper-to-bumper length in metres (defaults per category)
  forward             Blender-space direction the vehicle FRONT points to in the source after
                      import: "+x" | "-x" | "+y" | "-y" | "auto" (longest horizontal axis, sign guessed)
  flip                true to turn the result 180 degrees (if the front ended up at the back)
  drop_objects        list of substrings; matching objects are deleted (e.g. interior, driver)
  drop_materials      list of substrings; faces with matching materials are deleted
  paint_material      substring of the body-paint material name (else: largest-area coloured material)
  lod0_tris, lod1_tris  triangle budgets
  tex_max, tex_max_lod1 texture size caps
  wheels              optional manual wheel centres in OUTPUT three.js space {fl:[x,y,z],...} plus
                      "radius": r, used when automatic detection fails
  headlights, taillights  optional [[x,y,z],[x,y,z]] overrides in three.js space
  no_preview          true to skip renders
"""
import sys, json, math, os
import bpy, bmesh
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT_DIR, SLUG = argv[0], argv[1], argv[2]
CFG = json.load(open(argv[3])) if len(argv) > 3 else {}
PREVIEW_DIR = CFG.get('preview_dir', os.path.join(OUT_DIR, '..', 'previews'))
CAT = CFG.get('category', 'sedan')
DEFAULT_LEN = {'bus': 12.0, 'sedan': 4.8, 'hatchback': 4.2, 'suv': 4.8, 'minivan': 5.1, 'van': 5.6, 'pickup': 5.6, 'taxi': 4.9, 'truck': 7.5}
BUDGET = {'bus': (90000, 14000), 'truck': (70000, 12000)}.get(CAT, (45000, 8000))
LOD0, LOD1 = CFG.get('lod0_tris', BUDGET[0]), CFG.get('lod1_tris', BUDGET[1])
TEX0, TEX1 = CFG.get('tex_max', 1024), CFG.get('tex_max_lod1', 256)
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)
log = lambda *a: print('[vehicle]', *a, flush=True)

# ------------------------------------------------------------------ import
bpy.ops.wm.read_factory_settings(use_empty=True)
if SRC.lower().endswith(('.glb', '.gltf')):
    bpy.ops.import_scene.gltf(filepath=SRC)
elif SRC.lower().endswith('.fbx'):
    bpy.ops.import_scene.fbx(filepath=SRC)
elif SRC.lower().endswith('.obj'):
    bpy.ops.wm.obj_import(filepath=SRC)
else:
    raise SystemExit('unsupported source format')

scene = bpy.context.scene
for o in list(scene.objects):
    if o.type not in ('MESH', 'EMPTY'):
        bpy.data.objects.remove(o, do_unlink=True)

def meshes():
    return [o for o in scene.objects if o.type == 'MESH']

def select(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)

# bake parenting/instancing into plain world-space meshes
select(meshes())
bpy.ops.object.make_single_user(object=True, obdata=True, material=False)
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(scene.objects):
    if o.type == 'EMPTY':
        bpy.data.objects.remove(o, do_unlink=True)

# ------------------------------------------------------------------ drop unwanted parts
for o in list(meshes()):
    if any(s.lower() in o.name.lower() for s in CFG.get('drop_objects', [])):
        bpy.data.objects.remove(o, do_unlink=True)
drop_mats = [s.lower() for s in CFG.get('drop_materials', [])]
if drop_mats:
    for o in meshes():
        bad = [i for i, slot in enumerate(o.material_slots) if slot.material and any(s in slot.material.name.lower() for s in drop_mats)]
        if not bad:
            continue
        bm = bmesh.new(); bm.from_mesh(o.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in bad], context='FACES')
        bm.to_mesh(o.data); bm.free()
for o in list(meshes()):
    if len(o.data.polygons) == 0:
        bpy.data.objects.remove(o, do_unlink=True)

def world_bbox(objs):
    lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return lo, hi

def tri_count(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)

# ------------------------------------------------------------------ orient, scale, place
lo, hi = world_bbox(meshes())
dims = hi - lo
fwd = CFG.get('forward', 'auto')
if fwd == 'auto':
    fwd = '+y' if dims.y >= dims.x else '+x'
angle = {'+y': 0.0, '-y': math.pi, '+x': math.pi / 2, '-x': -math.pi / 2}[fwd]   # rotate front onto +Y
if CFG.get('flip'):
    angle += math.pi
R = Matrix.Rotation(angle, 4, 'Z')
for o in meshes():
    o.data.transform(R)
lo, hi = world_bbox(meshes())
dims = hi - lo
length = dims.y
target = CFG.get('target_length', DEFAULT_LEN.get(CAT, 4.8))
s = target / length if not CFG.get('keep_scale') else 1.0
centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
M = Matrix.Scale(s, 4) @ Matrix.Translation(-centre)
for o in meshes():
    o.data.transform(M)
    o.data.update()
lo, hi = world_bbox(meshes())
dims = hi - lo
log(f'oriented {fwd}{" flipped" if CFG.get("flip") else ""}, scale {s:.4f}, dims L{dims.y:.2f} W{dims.x:.2f} H{dims.z:.2f}')

# ------------------------------------------------------------------ wheel detection
def to_blender(p):   # three.js (x, y, z) -> Blender (x, -z, y)
    return Vector((p[0], -p[2], p[1]))
def to_three(v):
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]

H, W, L = dims.z, dims.x, dims.y
# 1) split every mesh into loose parts
select(meshes())
for o in list(meshes()):
    select([o])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='LOOSE')
    bpy.ops.object.mode_set(mode='OBJECT')
parts = meshes()
log('loose parts', len(parts))

def part_info(o):
    a, b = world_bbox([o])
    return {'o': o, 'lo': a, 'hi': b, 'c': (a + b) / 2, 'd': b - a}
infos = [part_info(o) for o in parts]

manual = CFG.get('wheels')
wheel_defs = {}
if manual:
    r = manual['radius']
    for k in ('fl', 'fr', 'rl', 'rr'):
        wheel_defs[k] = {'c': to_blender(manual[k]), 'r': r}
else:
    # tyres: touch the ground, roughly round in the side view, on the outer side
    tyres = [i for i in infos
             if i['lo'].z < 0.06 * H + 0.02 and abs(i['d'].y - i['d'].z) < 0.25 * max(i['d'].y, i['d'].z)
             and 0.35 < i['d'].z < 1.4 and i['d'].x < 0.75 and abs(i['c'].x) > 0.18 * W]
    groups = {'fl': [], 'fr': [], 'rl': [], 'rr': []}
    for t in tyres:
        k = ('f' if t['c'].y > 0 else 'r') + ('l' if t['c'].x < 0 else 'r')
        groups[k].append(t)
    if all(groups.values()):
        for k, g in groups.items():
            a = Vector((min(t['lo'].x for t in g), min(t['lo'].y for t in g), min(t['lo'].z for t in g)))
            b = Vector((max(t['hi'].x for t in g), max(t['hi'].y for t in g), max(t['hi'].z for t in g)))
            c = (a + b) / 2
            r = max(t['d'].z for t in g) / 2
            wheel_defs[k] = {'c': c, 'r': r, 'lo': a, 'hi': b}
    else:
        log('automatic tyre detection failed:', {k: len(v) for k, v in groups.items()}, '- trying vertex-level split needs manual "wheels" config')

wheel_objs = {}
if len(wheel_defs) == 4:
    claimed = {k: [] for k in wheel_defs}
    for i in infos:
        for k, wd in wheel_defs.items():
            c, r = wd['c'], wd['r']
            half_w = max(0.2, (wd['hi'].x - wd['lo'].x) / 2 + 0.06) if 'hi' in wd else 0.3
            m = r * 1.08   # part's side-view bbox must sit inside the wheel's square, near its track
            inside = (i['lo'].y >= c.y - m and i['hi'].y <= c.y + m and i['lo'].z >= c.z - m and i['hi'].z <= c.z + m
                      and abs(i['c'].x - c.x) <= half_w)
            if inside:
                claimed[k].append(i['o'])
                break
    # parts that straddle wheel and body (merged meshes): cut out the wheel cylinder at face level
    for k, wd in wheel_defs.items():
        if claimed[k]:
            continue
        c, r = wd['c'], wd['r']
        for i in infos:
            if not (i['lo'].z < c.z and i['hi'].z > c.z and i['lo'].y < c.y < i['hi'].y):
                continue
            o = i['o']
            inside_face = lambda ce: math.hypot(ce.y - c.y, ce.z - c.z) <= r * 1.0 and abs(ce.x - c.x) <= 0.25
            n_sel = sum(1 for p in o.data.polygons if inside_face(p.center))
            if n_sel < 20:
                continue
            select([o]); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT')
            bpy.ops.object.mode_set(mode='OBJECT')
            for p in o.data.polygons:
                p.select = inside_face(p.center)
            bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.separate(type='SELECTED'); bpy.ops.object.mode_set(mode='OBJECT')
            sel = range(n_sel)
            new = [x for x in meshes() if x not in parts]
            parts.extend(new)
            claimed[k].extend(new)
            log(f'{k}: split {len(sel)} faces out of merged mesh {o.name}')
            break
    for k, objs in claimed.items():
        if not objs:
            continue
        select(objs)
        bpy.ops.object.join()
        w = bpy.context.view_layer.objects.active
        w.name = f'wheel_{k}'
        c = wheel_defs[k]['c']
        w.data.transform(Matrix.Translation(-c))
        w.location = c
        wheel_objs[k] = w
log('wheels found', sorted(wheel_objs))

# ------------------------------------------------------------------ body: join by material set
body = [o for o in meshes() if o not in wheel_objs.values()]
select(body)
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = 'body'
# weld duplicate verts created by the loose-part split (keeps normals via sharp edges)
if CFG.get('weld', False):
    select([body]); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001); bpy.ops.object.mode_set(mode='OBJECT')

# paint material
def mat_area(o):
    area = {}
    for p in o.data.polygons:
        m = o.material_slots[p.material_index].material if o.material_slots else None
        if m:
            area[m] = area.get(m, 0) + p.area
    return area
paint = None
key = CFG.get('paint_material')
areas = mat_area(body)
if key:
    paint = next((m for m in areas if key.lower() in m.name.lower()), None)
if paint is None and not CFG.get('no_paint'):
    def colourful(m):
        bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if m.use_nodes else None
        if not bsdf: return False
        tex = bsdf.inputs['Base Color'].is_linked
        col = bsdf.inputs['Base Color'].default_value
        alpha = bsdf.inputs['Alpha'].default_value
        return not tex and alpha > 0.95 and max(col[:3]) > 0.08
    cands = sorted(((a, m) for m, a in areas.items() if colourful(m)), key=lambda t: -t[0])
    paint = cands[0][1] if cands else None
if paint:
    paint.name = 'paint'
log('paint material', paint.name if paint else None)

# ------------------------------------------------------------------ budgets
def decimate_to(o, target):
    t = tri_count([o])
    if t <= target:
        return
    # keep a copy as normal source: decimation alone leaves blotchy, crumpled paint shading
    transfer = CFG.get('normal_transfer', False)  # A/B tested: transferring normals onto the decimated mesh caused blotches
    src = o.copy(); src.data = o.data.copy(); scene.collection.objects.link(src)
    mod = o.modifiers.new('dec', 'DECIMATE')
    mod.ratio = max(0.02, target / t)
    mod.use_collapse_triangulate = True
    select([o]); bpy.ops.object.modifier_apply(modifier=mod.name)
    try:
        if not transfer: raise RuntimeError('disabled')
        dt = o.modifiers.new('nrm', 'DATA_TRANSFER')
        dt.object = src
        dt.use_loop_data = True
        dt.data_types_loops = {'CUSTOM_NORMAL'}
        dt.loop_mapping = 'POLYINTERP_NEAREST'
        select([o]); bpy.ops.object.modifier_apply(modifier=dt.name)
    except Exception as e:
        log('normal transfer skipped:', e)
    bpy.data.objects.remove(src, do_unlink=True)

wheel_budget = CFG.get('wheel_tris', 1800 if CAT != 'bus' else 3500)
for w in wheel_objs.values():
    decimate_to(w, wheel_budget)
decimate_to(body, max(4000, LOD0 - tri_count(list(wheel_objs.values()))))
log('LOD0 tris', tri_count(meshes()))

def cap_textures(maxdim):
    for img in bpy.data.images:
        if img.size[0] > maxdim or img.size[1] > maxdim:
            sc = maxdim / max(img.size)
            img.scale(max(1, int(img.size[0] * sc)), max(1, int(img.size[1] * sc)))

def export(path):
    select(meshes())
    kw = dict(filepath=path, export_format='GLB', use_selection=True,
              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
              export_image_quality=85, export_apply=True, export_yup=True)
    try:
        bpy.ops.export_scene.gltf(export_image_format=CFG.get('image_format', 'WEBP'), **kw)
    except Exception as e:   # e.g. greyscale PNGs Blender cannot write as WebP
        log('WEBP export failed, falling back to AUTO:', e)
        bpy.ops.export_scene.gltf(export_image_format='AUTO', **kw)

# ------------------------------------------------------------------ metadata
lo, hi = world_bbox(meshes())
wheels_three = {k: to_three(w.location) for k, w in wheel_objs.items()}
radius = max((wheel_defs[k]['r'] for k in wheel_objs), default=0.35)
front_y, rear_y = hi.y, lo.y
lamp_h = min(0.95, max(0.55, radius * 1.9)) if CAT != 'bus' else 0.75
meta = {
    'slug': SLUG, 'category': CAT,
    'length': round(hi.y - lo.y, 3), 'width': round(hi.x - lo.x, 3), 'height': round(hi.z - lo.z, 3),
    'wheels': wheels_three, 'wheelRadius': round(radius, 3),
    'wheelbase': round(abs(wheel_objs['fl'].location.y - wheel_objs['rl'].location.y), 3) if len(wheel_objs) == 4 else None,
    'track': round(abs(wheel_objs['fl'].location.x - wheel_objs['fr'].location.x), 3) if len(wheel_objs) == 4 else None,
    'headlights': CFG.get('headlights') or [[-(hi.x - lo.x) * 0.36, lamp_h, -front_y + 0.05], [(hi.x - lo.x) * 0.36, lamp_h, -front_y + 0.05]],
    'taillights': CFG.get('taillights') or [[-(hi.x - lo.x) * 0.4, lamp_h + 0.1, -rear_y - 0.05], [(hi.x - lo.x) * 0.4, lamp_h + 0.1, -rear_y - 0.05]],
    'paintMaterial': 'paint' if paint else None,
    'source': CFG.get('source', {}),
}

# ------------------------------------------------------------------ previews (LOD0)
def render_previews():
    if CFG.get('no_preview'):
        return
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items.keys() else 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 720, 405
    sc.render.film_transparent = False
    world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.55, 0.65, 0.8, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    ground = bpy.context.view_layer.objects.active
    gm = bpy.data.materials.new('ground'); gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.18, 0.18, 0.18, 1)
    ground.data.materials.append(gm)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4; sun.rotation_euler = (math.radians(50), 0, math.radians(30)); sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 40
    Lm = max(L, 4.0)
    views = {
        'front34': Vector((-0.9 * Lm, 0.95 * Lm, 0.32 * Lm)),   # front-left (front = +Y, left = -X)
        'rear34': Vector((0.9 * Lm, -0.95 * Lm, 0.32 * Lm)),
        'side': Vector((-1.6 * Lm, 0, 0.18 * Lm)),
        'top': Vector((0, 0.001, 1.8 * Lm)),
    }
    target = Vector((0, 0, H * 0.45))
    for name, pos in views.items():
        cam.location = pos
        d = target - pos
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(PREVIEW_DIR, f'{SLUG}_{name}.png')
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(ground, do_unlink=True)
    bpy.data.objects.remove(sun, do_unlink=True)
    bpy.data.objects.remove(cam, do_unlink=True)

cap_textures(TEX0)
meta['tris'] = {'lod0': tri_count(meshes())}
export(os.path.join(OUT_DIR, f'{SLUG}.glb'))
try:
    render_previews()
except Exception as e:  # previews are a convenience; never fail the export on them
    log('preview render failed:', e)

# LOD1
for o in meshes():
    decimate_to(o, max(300, int(LOD1 * tri_count([o]) / max(1, meta['tris']['lod0']))))
cap_textures(TEX1)
meta['tris']['lod1'] = tri_count(meshes())
export(os.path.join(OUT_DIR, f'{SLUG}_lod1.glb'))
json.dump(meta, open(os.path.join(OUT_DIR, f'{SLUG}.json'), 'w'), indent=1)
log('done', json.dumps(meta))
