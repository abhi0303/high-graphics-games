"""World-space retargeting helpers for tools/build_character.py (run inside Blender).

retarget(src_obj, char_obj, pairs, frames, offsets, root, scale) bakes a new action on char_obj:
  for every frame, each target bone gets the world rotation of its source bone (times a constant
  per-bone offset); bone lengths stay the character's own; the root bone also gets the source
  position (scaled). Parents are solved before children, so the result is exact.
"""
import bpy, mathutils, math

Matrix, Vector = mathutils.Matrix, mathutils.Vector


def ordered_bones(arm_obj, names):
    """Names sorted parent-first."""
    depth = {}
    for b in arm_obj.data.bones:
        d, p = 0, b.parent
        while p: d += 1; p = p.parent
        depth[b.name] = d
    return sorted(names, key=lambda n: depth[n])


def rot3(m):
    return m.to_3x3().normalized()


def retarget(src_obj, char_obj, pairs, frames, offsets=None, root=None, scale=1.0, name='clip', root_offset=None, pre=None, root_fn=None):
    """pairs: {target_bone: source_bone}. offsets: {target_bone: 3x3 Matrix} (world-space, right-multiplied).
    root: target root bone name receiving translation. Returns the new action."""
    scene = bpy.context.scene
    offsets = offsets or {}
    tb = char_obj.data.bones
    order = ordered_bones(char_obj, list(pairs.keys()))
    char_world = char_obj.matrix_world.copy()
    char_world_inv = char_world.inverted()
    act = bpy.data.actions.new(name)
    char_obj.animation_data_create()
    char_obj.animation_data.action = act
    pbs = char_obj.pose.bones
    for pb in pbs:
        pb.rotation_mode = 'QUATERNION'
    # rest matrices (armature space) and parent-relative rest
    rest = {b.name: b.matrix_local.copy() for b in tb}
    rest_rel = {}
    for b in tb:
        rest_rel[b.name] = (rest[b.parent.name].inverted() @ rest[b.name]) if b.parent else rest[b.name]
    prev_q = {}
    for fi, f in enumerate(frames):
        scene.frame_set(int(f), subframe=f - int(f))
        posed = {}  # target armature-space matrices solved this frame
        for t in order:
            s = pairs[t]
            sw = src_obj.matrix_world @ src_obj.pose.bones[s].matrix  # source world
            R = rot3(sw)
            if pre is not None: R = pre @ R
            if t in offsets: R = R @ offsets[t]
            b = tb[t]
            # world rotation → armature space rotation
            Ra = rot3(char_world_inv) @ R
            if b.parent and b.parent.name in posed:
                par = posed[b.parent.name]
            elif b.parent:
                # unmapped parent: use its current pose (rest unless keyed)
                par = pbs[b.parent.name].matrix.copy()
            else:
                par = None
            if t == root:
                if root_fn is not None:
                    p = root_fn(fi, sw.to_translation())
                else:
                    p = sw.to_translation() * scale
                    if root_offset is not None: p = p + root_offset
                pos = char_world_inv @ p
            else:
                pos = ((par if par is not None else Matrix.Identity(4)) @ rest_rel[t]).to_translation()
            M = Matrix.Translation(pos) @ Ra.to_4x4()
            posed[t] = M
            basis = (rest_rel[t].inverted() @ (par.inverted() @ M)) if par is not None else (rest[t].inverted() @ M)
            loc, q, _ = basis.decompose()
            # keep quaternion continuity
            if t in prev_q and prev_q[t].dot(q) < 0: q.negate()
            prev_q[t] = q
            pb = pbs[t]
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=fi + 1, group=t)
            if t == root:
                pb.location = loc
                pb.keyframe_insert('location', frame=fi + 1, group=t)
    return act


# ---------------------------------------------------------------- CMU (cgspeed BVH) → Rocketbox Biped

MAP = {
    'Bip01 Pelvis': 'Hips', 'Bip01 Spine': 'LowerBack', 'Bip01 Spine1': 'Spine', 'Bip01 Spine2': 'Spine1',
    'Bip01 Neck': 'Neck1', 'Bip01 Head': 'Head',
    'Bip01 L Clavicle': 'LeftShoulder', 'Bip01 L UpperArm': 'LeftArm', 'Bip01 L Forearm': 'LeftForeArm', 'Bip01 L Hand': 'LeftHand',
    'Bip01 R Clavicle': 'RightShoulder', 'Bip01 R UpperArm': 'RightArm', 'Bip01 R Forearm': 'RightForeArm', 'Bip01 R Hand': 'RightHand',
    'Bip01 L Thigh': 'LeftUpLeg', 'Bip01 L Calf': 'LeftLeg', 'Bip01 L Foot': 'LeftFoot', 'Bip01 L Toe0': 'LeftToeBase',
    'Bip01 R Thigh': 'RightUpLeg', 'Bip01 R Calf': 'RightLeg', 'Bip01 R Foot': 'RightFoot', 'Bip01 R Toe0': 'RightToeBase',
}
CHAR_FORWARD = Vector((0, -1, 0))


def import_bvh(path):
    before = set(bpy.data.objects)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=0.0564, frame_start=1, use_fps_scale=False,
                            update_scene_fps=False, update_scene_duration=False, rotate_mode='NATIVE',
                            axis_forward='-Z', axis_up='Y')
    src = [o for o in bpy.data.objects if o not in before and o.type == 'ARMATURE'][0]
    return src


def world(obj, bone):
    return obj.matrix_world @ obj.pose.bones[bone].matrix


def facing(src, frame):
    """Unit forward vector (horizontal) of the source body at a frame, from hip joints."""
    bpy.context.scene.frame_set(frame)
    l = world(src, 'LeftUpLeg').to_translation() - world(src, 'RightUpLeg').to_translation()
    l.z = 0; l.normalize()
    f = l.cross(Vector((0, 0, 1)))
    return f.normalized()


def yaw_to(f_from, f_to=CHAR_FORWARD):
    a = math.atan2(f_from.x * f_to.y - f_from.y * f_to.x, f_from.dot(f_to))
    return Matrix.Rotation(a, 3, 'Z')


# limb direction = joint → child joint, on both skeletons (bone axes differ between the rigs)
CHAR_CHILD = {
    'Bip01 Spine': 'Bip01 Spine1', 'Bip01 Spine1': 'Bip01 Spine2', 'Bip01 Spine2': 'Bip01 Neck', 'Bip01 Neck': 'Bip01 Head',
    'Bip01 L Clavicle': 'Bip01 L UpperArm', 'Bip01 L UpperArm': 'Bip01 L Forearm', 'Bip01 L Forearm': 'Bip01 L Hand', 'Bip01 L Hand': 'Bip01 L Finger2',
    'Bip01 R Clavicle': 'Bip01 R UpperArm', 'Bip01 R UpperArm': 'Bip01 R Forearm', 'Bip01 R Forearm': 'Bip01 R Hand', 'Bip01 R Hand': 'Bip01 R Finger2',
    'Bip01 L Thigh': 'Bip01 L Calf', 'Bip01 L Calf': 'Bip01 L Foot', 'Bip01 L Foot': 'Bip01 L Toe0',
    'Bip01 R Thigh': 'Bip01 R Calf', 'Bip01 R Calf': 'Bip01 R Foot', 'Bip01 R Foot': 'Bip01 R Toe0',
}
SRC_CHILD = {
    'LowerBack': 'Spine', 'Spine': 'Spine1', 'Spine1': 'Neck', 'Neck1': 'Head',
    'LeftShoulder': 'LeftArm', 'LeftArm': 'LeftForeArm', 'LeftForeArm': 'LeftHand', 'LeftHand': 'LeftFingerBase',
    'RightShoulder': 'RightArm', 'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand', 'RightHand': 'RightFingerBase',
    'LeftUpLeg': 'LeftLeg', 'LeftLeg': 'LeftFoot', 'LeftFoot': 'LeftToeBase',
    'RightUpLeg': 'RightLeg', 'RightLeg': 'RightFoot', 'RightFoot': 'RightToeBase',
}


def tpose_offsets(src, char, frame=1):
    """Per-bone world-space offsets so R_char = pre @ R_src @ offset. The character is posed into the
    source's frame-1 T-pose by swinging each limb (joint → child joint) onto the source limb direction."""
    scene = bpy.context.scene
    pre = yaw_to(facing(src, frame))
    scene.frame_set(frame)
    src_rot = {t: pre @ rot3(world(src, s)) for t, s in MAP.items()}
    src_dir = {}
    for t, s in MAP.items():
        if s in SRC_CHILD:
            d = world(src, SRC_CHILD[s]).to_translation() - world(src, s).to_translation()
            if d.length > 1e-6: src_dir[t] = (pre @ d).normalized()
    cw3 = rot3(char.matrix_world)
    tb = char.data.bones
    rest = {b.name: b.matrix_local.copy() for b in tb}
    rest_rel = {b.name: (rest[b.parent.name].inverted() @ rest[b.name]) if b.parent else rest[b.name] for b in tb}
    posed = {}
    char_rot = {}
    for t in ordered_bones(char, list(MAP.keys())):
        b = tb[t]
        if b.parent:
            par = posed.get(b.parent.name, rest[b.parent.name])
            A = par @ rest_rel[t]
        else:
            A = rest[t]
        R = rot3(A)
        if t not in CHAR_CHILD:
            R = rot3(rest[t])  # leaf bones (head, toes) keep their absolute rest orientation
        elif t in src_dir:
            local = rest_rel[CHAR_CHILD[t]].to_translation()
            cur = (R @ local).normalized()
            target = (cw3.inverted() @ src_dir[t]).normalized()
            R = cur.rotation_difference(target).to_matrix() @ R
        posed[t] = Matrix.Translation(A.to_translation()) @ R.to_4x4()
        char_rot[t] = cw3 @ R
    return pre, {t: src_rot[t].inverted() @ char_rot[t] for t in MAP}


def leg_length(obj, thigh, calf, foot, src=False):
    if src:
        bpy.context.scene.frame_set(1)
        a, b, c = (world(obj, n).to_translation() for n in (thigh, calf, foot))
    else:
        bones = obj.data.bones
        a, b, c = ((obj.matrix_world @ bones[n].head_local) for n in (thigh, calf, foot))
    return (b - a).length + (c - b).length
