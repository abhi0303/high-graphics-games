"""Build the playable character GLB (run with Blender 4.4+ in background mode).

  blender -b --factory-startup --python tools/build_character.py -- \
      <rocketbox_avatar.fbx> <avatar_textures_dir> <rocketbox_anims_dir> <cmu_bvh_dir> <out.glb>

Character: Microsoft Rocketbox "Male_Adult_05" (MIT licence), Biped rig with facial blendshapes.
Animation: Rocketbox motion-capture clips (same rig, MIT) and CMU Graphics Lab mocap (cgspeed BVH
conversion; free for commercial use), retargeted in world space onto the Biped skeleton.
Writes <out.glb> plus <out>.json with clip timings used by the game (hit frames, take-off, ...).
"""
import bpy, bmesh, sys, os, math, json
import numpy as np
import mathutils

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from retarget_lib import retarget, rot3, MAP, import_bvh, tpose_offsets, leg_length, world, facing, yaw_to

Vector, Matrix, Quaternion = mathutils.Vector, mathutils.Matrix, mathutils.Quaternion
argv = sys.argv[sys.argv.index('--') + 1:]
AVATAR, TEXDIR, RBDIR, CMUDIR, OUT = argv[:5]
FPS = 30
KEEP_SHAPES = {'AK_09_EyeBlinkLeft': 'blinkL', 'AK_10_EyeBlinkRight': 'blinkR'}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
bpy.ops.import_scene.fbx(filepath=AVATAR)
arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
arm.name = 'character'
mesh = [o for o in bpy.data.objects if o.type == 'MESH'][0]
mesh.name = 'body'
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
for o in list(bpy.data.objects):
    if o not in (arm, mesh): bpy.data.objects.remove(o, do_unlink=True)

# ---------------------------------------------------------------- shape keys: keep the blinks only
keys = mesh.data.shape_keys.key_blocks
for k in list(keys)[1:]:
    if k.name not in KEEP_SHAPES:
        mesh.shape_key_remove(k)
for old, new in KEEP_SHAPES.items():
    if old in mesh.data.shape_keys.key_blocks: mesh.data.shape_keys.key_blocks[old].name = new

# ---------------------------------------------------------------- materials (glTF metal/rough PBR)
def load(name):
    p = os.path.join(TEXDIR, name)
    img = bpy.data.images.load(p)
    return img

def spec_to_rough(spec_img, name, lo, hi, size=1024):
    """Rocketbox specular maps (grey = shine) → roughness (shiny = smooth)."""
    w, h = spec_img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    spec_img.pixels.foreach_get(px)
    s = px.reshape(h, w, 4)[..., 0]
    s = np.clip(s / max(1e-4, float(np.percentile(s, 99.5))), 0, 1)  # dark maps with a few hot pixels
    r = hi - (hi - lo) * s
    out = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    out.colorspace_settings.name = 'Non-Color'  # before writing: changing it regenerates the buffer
    o = np.ones((h, w, 4), dtype=np.float32)
    o[..., 0] = o[..., 1] = o[..., 2] = r
    out.pixels.foreach_set(o.ravel())
    out.scale(size, size)
    out.pack()
    return out

def make_material(mat, color, normal, rough=None, alpha=False):
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    c = nt.nodes.new('ShaderNodeTexImage'); c.image = color
    nt.links.new(c.outputs['Color'], bsdf.inputs['Base Color'])
    if alpha:
        nt.links.new(c.outputs['Alpha'], bsdf.inputs['Alpha'])
        mat.blend_method = 'CLIP' if hasattr(mat, 'blend_method') else None
        mat.alpha_threshold = 0.5 if hasattr(mat, 'alpha_threshold') else None
    if normal:
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = normal; normal.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(n.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if rough:
        r = nt.nodes.new('ShaderNodeTexImage'); r.image = rough
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(r.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 0.6
    bsdf.inputs['Metallic'].default_value = 0.0

prefix = None
for m in mesh.data.materials:
    if m.name.endswith('_body'): prefix = m.name[:-5]
for m in mesh.data.materials:
    kind = m.name[len(prefix) + 1:]
    if kind == 'body':
        make_material(m, load(f'{prefix}_body_color.tga'), load(f'{prefix}_body_normal.tga'),
                      spec_to_rough(load(f'{prefix}_body_specular.tga'), 'body_rough', 0.55, 0.92))
        m.name = 'clothes'
    elif kind == 'head':
        make_material(m, load(f'{prefix}_head_color.tga'), load(f'{prefix}_head_normal.tga'),
                      spec_to_rough(load(f'{prefix}_head_specular.tga'), 'skin_rough', 0.38, 0.72))
        m.name = 'skin'
    elif kind == 'opacity':
        make_material(m, load(f'{prefix}_opacity_color.tga'), None, None, alpha=True)
        m.name = 'hair'
for img in bpy.data.images:
    if img.size[0] > 2048: img.scale(2048, 2048)

# ---------------------------------------------------------------- helpers
pbs = arm.pose.bones
for pb in pbs: pb.rotation_mode = 'QUATERNION'
BONES = [b.name for b in arm.data.bones]
FACE = set()
for b in arm.data.bones:
    p = b.parent
    while p:
        if p.name == 'Bip01 Head': FACE.add(b.name); break
        p = p.parent
BODY = [n for n in BONES if n not in FACE]
REST_PELVIS = (arm.matrix_world @ arm.data.bones['Bip01 Pelvis'].head_local)
CLIPS = {}
META = {}

def finalize(act, name, loop=False, close=0):
    act.name = name
    act.use_fake_user = True
    if close: loop_close(act, close)
    n = int(act.frame_range[1])
    CLIPS[name] = act
    META.setdefault(name, {})['duration'] = round((n - 1) / FPS, 4)
    META[name]['loop'] = loop
    return act

def fcurves_by_bone(act):
    out = {}
    for fc in act.fcurves:
        if not fc.data_path.startswith('pose.bones["'): continue
        b = fc.data_path.split('"')[1]
        out.setdefault(b, {}).setdefault(fc.data_path.split('.')[-1], {})[fc.array_index] = fc
    return out

def loop_close(act, frames):
    """Blend the last `frames` keys toward the first key so the clip loops seamlessly."""
    n = int(act.frame_range[1])
    for b, chans in fcurves_by_bone(act).items():
        for prop, comps in chans.items():
            if prop == 'rotation_quaternion' and len(comps) == 4:
                first = Quaternion([comps[i].evaluate(1) for i in range(4)])
                for f in range(n - frames, n + 1):
                    w = (f - (n - frames)) / frames
                    w = w * w * (3 - 2 * w)
                    q = Quaternion([comps[i].evaluate(f) for i in range(4)])
                    if q.dot(first) < 0: q.negate()
                    r = q.slerp(first, w)
                    for i in range(4):
                        kp = [k for k in comps[i].keyframe_points if int(round(k.co.x)) == f]
                        if kp: kp[0].co.y = r[i]
            else:
                for i, fc in comps.items():
                    first = fc.evaluate(1)
                    for k in fc.keyframe_points:
                        f = int(round(k.co.x))
                        if f >= n - frames:
                            w = (f - (n - frames)) / frames
                            w = w * w * (3 - 2 * w)
                            k.co.y = k.co.y * (1 - w) + first * w
    for fc in act.fcurves: fc.update()

def set_key(act, bone, q, frame):
    pb = pbs[bone]
    dp = f'pose.bones["{bone}"].rotation_quaternion'
    for i in range(4):
        fc = act.fcurves.find(dp, index=i) or act.fcurves.new(dp, index=i, action_group=bone)
        fc.keyframe_points.insert(frame, q[i], options={'FAST'})

def copy_local(dst, src_act, bones, src_frame):
    """Overwrite `bones` in dst with the local rotations of src_act at src_frame (same rig)."""
    sf = fcurves_by_bone(src_act)
    n = int(dst.frame_range[1])
    for b in bones:
        if b not in sf or 'rotation_quaternion' not in sf[b]: continue
        comps = sf[b]['rotation_quaternion']
        q = Quaternion([comps[i].evaluate(src_frame) for i in range(4)])
        dp = f'pose.bones["{b}"].rotation_quaternion'
        for fc in [f for f in dst.fcurves if f.data_path == dp]: dst.fcurves.remove(fc)
        for f in range(1, n + 1): set_key(dst, b, q, f)

# ---------------------------------------------------------------- fists for boxing clips
def fist_rotations():
    """Local rotations curling each finger into a fist (axis = across the knuckles, sign toward the palm)."""
    out = {}
    for side in ('L', 'R'):
        B = arm.data.bones
        hb = B[f'Bip01 {side} Hand']
        across = (B[f'Bip01 {side} Finger1'].head_local - B[f'Bip01 {side} Finger4'].head_local).normalized()
        thumb = B[f'Bip01 {side} Finger0'].head_local
        for sign in (1, -1):
            # pick the sign that brings the middle fingertip toward the thumb base (palm side)
            tip0 = B[f'Bip01 {side} Finger22'].head_local - B[f'Bip01 {side} Finger2'].head_local
            tip = Matrix.Rotation(sign * 1.2, 3, across) @ tip0
            base = B[f'Bip01 {side} Finger2'].head_local
            if (base + tip - thumb).length < (base + tip0 - thumb).length:
                break
        for fi in range(1, 5):
            for seg, ang in ((f'{fi}', 1.35), (f'{fi}1', 1.6), (f'{fi}2', 1.1)):
                bn = f'Bip01 {side} Finger{seg}'
                axis = rot3(B[bn].matrix_local).inverted() @ across
                out[bn] = Quaternion(axis, sign * ang)
        fwd = (B[f'Bip01 {side} Finger2'].head_local - hb.head_local).normalized()
        for seg, ang in (('01', 0.6), ('02', 0.8)):
            bn = f'Bip01 {side} Finger{seg}'
            axis = rot3(B[bn].matrix_local).inverted() @ fwd
            out[bn] = Quaternion(axis, -sign * ang if side == 'L' else sign * ang)
    return out
FIST = fist_rotations()

def apply_fist(act, weight=1.0):
    n = int(act.frame_range[1])
    for b, q in FIST.items():
        qq = Quaternion().slerp(q, weight)
        dp = f'pose.bones["{b}"].rotation_quaternion'
        for fc in [f for f in act.fcurves if f.data_path == dp]: act.fcurves.remove(fc)
        for f in range(1, n + 1): set_key(act, b, qq, f)

# ---------------------------------------------------------------- Rocketbox clips (same rig)
def rocketbox(file, name, frames=None, loop=False, close=0, xyz=False, speed=1.0, inplace=False):
    """inplace: locomotion cycles whose forward travel is baked into the root (Rocketbox 'xy' clips): the
    linear travel is removed (sway kept) and stored as the clip's natural ground speed."""
    before = set(bpy.data.objects); acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=os.path.join(RBDIR, file))
    new = [o for o in bpy.data.objects if o not in before]
    src = [o for o in new if o.type == 'ARMATURE'][0]
    act = max([a for a in bpy.data.actions if a not in acts_before], key=lambda a: len(a.fcurves))
    src.animation_data.action = act
    f0, f1 = (int(act.frame_range[0]), int(act.frame_range[1])) if frames is None else frames
    pairs = {b: b for b in BODY if b in src.pose.bones}
    scene.frame_set(f0)
    p0 = (src.matrix_world @ src.pose.bones['Bip01 Pelvis'].matrix).to_translation()
    scene.frame_set(f1)
    p1 = (src.matrix_world @ src.pose.bones['Bip01 Pelvis'].matrix).to_translation()
    fr = [f0 + i * speed for i in range(int((f1 - f0) / speed) + 1)]
    n = len(fr)
    def root_fn(i, p):
        if xyz: return Vector((p.x - p0.x, p.y - p0.y, p.z))
        if inplace:
            u = i / max(1, n - 1)
            return Vector((p.x - (p0.x + (p1.x - p0.x) * u), p.y - (p0.y + (p1.y - p0.y) * u), p.z))
        return Vector((p.x, p.y, p.z))
    out = retarget(src, arm, pairs, fr, root='Bip01 Pelvis', root_fn=root_fn, name=name)
    for a in [a for a in bpy.data.actions if a not in acts_before and a is not out]: bpy.data.actions.remove(a)
    for o in new: bpy.data.objects.remove(o, do_unlink=True)
    print('rocketbox', name, file, (f0, f1), 'frames', len(fr))
    finalize(out, name, loop, close)
    if inplace:
        travel = Vector((p1.x - p0.x, p1.y - p0.y)).length
        META[name]['speed'] = round(travel / META[name]['duration'], 4)
    return out

# ---------------------------------------------------------------- CMU clips (retargeted)
def cmu(file, name, f0, f1, loop=False, close=0, root='inplace', align='hips', align_frame=None, speed=1.0, yaw_extra=0.0, events=None):
    """root: 'inplace' (keep height), 'nolift' (clip only lowering: jumps), 'fixed' (constant height).
    align: 'hips' (body faces forward at align_frame) or ('arm', side, frame) (punch goes forward)."""
    before = set(bpy.data.objects)
    src = import_bvh(os.path.join(CMUDIR, file))
    pre_t, offsets = tpose_offsets(src, arm)
    ratio = leg_length(arm, 'Bip01 L Thigh', 'Bip01 L Calf', 'Bip01 L Foot') / leg_length(src, 'LeftUpLeg', 'LeftLeg', 'LeftFoot', src=True)
    # facing of the clip itself
    reach_frame = None
    if isinstance(align, tuple) and align[0] == 'travel':
        # moving clips (run-ups, forward jumps): the direction the hips travel points forward
        scene.frame_set(align[1]); a = world(src, 'Hips').to_translation()
        scene.frame_set(align[2]); b = world(src, 'Hips').to_translation()
        d = b - a; d.z = 0
        clip_yaw = yaw_to(d.normalized())
    elif isinstance(align, tuple):
        # punches: the arm direction at full extension (max shoulder→hand reach in [lo, hi]) points forward
        _, side, lo, hi = align
        best = -1
        for f in range(lo, hi + 1):
            scene.frame_set(f)
            d = world(src, f'{side}Hand').to_translation() - world(src, f'{side}Arm').to_translation(); d.z = 0
            if d.length > best: best, reach_frame, dbest = d.length, f, d.normalized()
        clip_yaw = yaw_to(dbest)
    else:
        clip_yaw = yaw_to(facing(src, align_frame or f0))
    if yaw_extra: clip_yaw = Matrix.Rotation(yaw_extra, 3, 'Z') @ clip_yaw
    # The T-pose offsets were computed with pre_t (T-pose facing → forward); the clip is rotated by clip_yaw instead.
    scene.frame_set(1)
    stand = world(src, 'Hips').to_translation().z
    rest_z = REST_PELVIS.z
    def root_fn(i, p):
        dz = (p.z - stand) * ratio
        if root == 'nolift': dz = min(0.0, dz)
        elif root == 'fixed': dz = 0.0
        return Vector((0.0, 0.0, rest_z + dz))
    fr = [f0 + i * 4 * speed for i in range(int((f1 - f0) / (4 * speed)) + 1)]  # 120 Hz → 30 Hz
    # offsets map a forward-facing source to the character; any world yaw of the source (clip_yaw) turns
    # the whole result by that yaw, so the clip's own facing at align_frame ends up forward
    out = retarget(src, arm, MAP, fr, offsets=offsets, root='Bip01 Pelvis', pre=clip_yaw, root_fn=root_fn, name=name)
    for o in [o for o in bpy.data.objects if o not in before]:
        if o.animation_data and o.animation_data.action: bpy.data.actions.remove(o.animation_data.action)
        bpy.data.objects.remove(o, do_unlink=True)
    print('cmu', name, file, (f0, f1), 'frames', len(fr))
    finalize(out, name, loop, close)
    if events:
        ev = {}
        for k, v in events.items():
            if v == 'reach':
                ev[k] = round((reach_frame - f0) / (120 * speed), 4)
            elif isinstance(v, tuple) and v[0] == 'reach':
                # moment of full extension: the punching hand furthest from the chest (on the character)
                hand, chest = f'Bip01 {v[1]} Hand', 'Bip01 Spine2'
                best, bf = -1, 1
                # around the moment of peak fist speed (source frame v[2]): up to 0.05 s before, 0.15 s after
                lo = max(1, int((v[2] - 6 - f0) / (4 * speed)) + 1); hi = min(len(fr), int((v[2] + 18 - f0) / (4 * speed)) + 1)
                for i in range(lo, hi + 1):
                    scene.frame_set(i)
                    h = arm.matrix_world @ arm.pose.bones[hand].head
                    c = arm.matrix_world @ arm.pose.bones[chest].head
                    d = (h - c); d.z = 0
                    if d.length > best: best, bf = d.length, i
                ev[k] = round((bf - 1) / FPS, 4)
                META[name]['reach'] = round(best, 3)
            else:
                ev[k] = round((v - f0) / (120 * speed), 4)
        META[name]['events'] = ev
    return out

# ---------------------------------------------------------------- clip list
rocketbox('st_m_idle_neutral_01.fbx', 'idle', loop=True, close=12)
rocketbox('xy_m_walk_neutral_01.fbx', 'walk', loop=True, inplace=True)
rocketbox('xy_m_run_fast_01.fbx', 'run', loop=True, inplace=True)
rocketbox('st_m_sit_chair_idle_neutral_01.fbx', 'sit', frames=(1, 181), loop=True, close=15)
# driving: the seated idle with the fingers closed around the rim (arms/legs/head are placed by IK in game)
drive = CLIPS['sit'].copy()
finalize(drive, 'drive', loop=True)
apply_fist(drive, 0.72)
rocketbox('xyz_m_sit_down_chair_01.fbx', 'sit_down', xyz=True)
rocketbox('xyz_m_sit_stand_up_chair_01.fbx', 'stand_up', xyz=True)

# jump: a small forward hop when standing or walking (CMU 91_43 "jump small forward") and a leap when
# running (CMU 127_25 "run jump over"), each as take-off / flight / landing; plus a falling loop
HOP = ('travel', 90, 160)
cmu('91_43.bvh', 'jump_start', 86, 100, root='nolift', align=HOP, events={'takeoff': 96})
cmu('91_43.bvh', 'jump_air', 100, 150, root='fixed', align=HOP)
cmu('91_43.bvh', 'land', 150, 206, root='nolift', align=HOP)
LEAP = ('travel', 20, 60)
cmu('127_25.bvh', 'run_jump', 48, 64, root='nolift', align=LEAP, events={'takeoff': 62})
cmu('127_25.bvh', 'run_air', 64, 134, root='fixed', align=LEAP)
cmu('127_25.bvh', 'run_land', 134, 178, root='nolift', align=LEAP)
cmu('127_25.bvh', 'fall', 100, 128, loop=True, close=8, root='fixed', align=LEAP)
# kneel (CMU 23_03, subject B kneels on one knee)
cmu('23_03.bvh', 'kneel_down', 62, 250, root='inplace')
cmu('23_03.bvh', 'kneel', 250, 490, loop=True, close=20, root='inplace', align_frame=62)
cmu('23_03.bvh', 'kneel_up', 520, 680, root='inplace', align_frame=62)
# boxing (CMU 13_17 / 14_01): guard, right cross, left jab, cover
cmu('13_17.bvh', 'punch_r', 206, 270, root='inplace', align=('reach', 'Right', 226, 250), events={'hit': 'reach'})
cmu('14_01.bvh', 'punch_l', 1808, 1866, root='inplace', align=('reach', 'Left', 1826, 1846), events={'hit': 'reach'})
cmu('14_01.bvh', 'combat_idle', 1700, 1790, loop=True, close=16, root='inplace', align_frame=1745)
cmu('13_17.bvh', 'block', 1424, 1456, loop=True, close=10, root='inplace', align_frame=1440)
for n in ('punch_r', 'punch_l', 'combat_idle', 'block'): apply_fist(CLIPS[n])

# kneeling arms: relaxed arms from the idle (the mocap subject reaches out to someone)
ARMS = [b for b in BODY if any(k in b for k in (' L Clavicle', ' R Clavicle', 'UpperArm', 'Forearm', ' Hand', 'Finger'))]
for n in ('kneel_down', 'kneel', 'kneel_up'):
    copy_local(CLIPS[n], CLIPS['idle'], ARMS, 30)

# ---------------------------------------------------------------- export
arm.animation_data.action = CLIPS['idle']
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True,
    export_image_format='WEBP', export_image_quality=88,
    export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
    export_frame_step=1, export_anim_single_armature=True, export_def_bones=False,
    export_morph=True, export_morph_normal=False, export_skins=True, export_all_influences=False,
    export_apply=False, export_yup=True,
)
meta = {'fps': FPS, 'pelvisHeight': round(REST_PELVIS.z, 4), 'clips': META,
        'height': round(max((mesh.matrix_world @ v.co).z for v in mesh.data.vertices), 4)}
with open(os.path.splitext(OUT)[0] + '.json', 'w') as f: json.dump(meta, f, indent=1)
print('WROTE', OUT, json.dumps(meta)[:2000])
