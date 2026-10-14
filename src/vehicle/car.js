import * as THREE from 'three';
import { WHEELS, WHEEL_RADIUS } from './physics.js';

const _q = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Headlight modes cycled with L. Intensities are candela-like (three.js physical lights, decay 2). */
const HEADLIGHT_MODES = [
  { name: 'Low beam', spot: 55, angle: 0.46, aimY: -0.9, aimZ: -18, lens: 6 },
  { name: 'High beam', spot: 190, angle: 0.33, aimY: 0.25, aimZ: -40, lens: 10 },
  { name: 'Off', spot: 0, angle: 0.46, aimY: -0.9, aimZ: -18, lens: 0 },
];
const approach = (cur, target, rate) => cur + (target - cur) * Math.min(1, rate);

/** A new geometry holding only the vertices used by `indices` (all attributes copied). */
function compactGeometry(g, indices) {
  const remap = new Map();
  const order = [];
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    let j = remap.get(indices[i]);
    if (j === undefined) { j = order.length; remap.set(indices[i], j); order.push(indices[i]); }
    idx[i] = j;
  }
  const out = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(g.attributes)) {
    const arr = new a.array.constructor(order.length * a.itemSize);
    for (let i = 0; i < order.length; i++) for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.array[order[i] * a.itemSize + k];
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * Visual car: the Ferrari 458 glTF with re-authored PBR materials (clear-coat
 * paint, tinted glass, rubber, dark machined rims), steerable/spinning wheels
 * driven by the physics vehicle, brake lights and a baked contact-shadow decal.
 */
export class Car {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.root = new THREE.Group();
    this.root.name = 'player-car';
    scene.add(this.root);
    this.wheels = [];
  }

  async load() {
    const [gltf, aoTex] = await Promise.all([
      this.assets.gltf('models/ferrari/ferrari.glb'),
      this.assets.texture('models/ferrari/ferrari_ao.png', { srgb: false, repeat: false }),
    ]);
    const model = gltf.scene;
    this.model = model;

    const paint = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(0.4, 0.012, 0.009),
      metalness: 0.15,
      roughness: 0.38,
      clearcoat: 1.0,
      clearcoatRoughness: 0.025,
      envMapIntensity: 1.0,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x0b0d0f,
      metalness: 0.0,
      roughness: 0.02,
      transparent: true,
      opacity: 0.42,
      envMapIntensity: 1.25,
      specularIntensity: 1,
      depthWrite: false,
    });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.88, metalness: 0 });
    const rim = new THREE.MeshStandardMaterial({ color: 0x1d1e21, roughness: 0.28, metalness: 0.9 });
    const rimLip = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.18, metalness: 1 });
    const brakeDisc = new THREE.MeshStandardMaterial({ color: 0x6b6d70, roughness: 0.35, metalness: 0.95 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.06, metalness: 1 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.32, metalness: 0.35 });
    const plastic = new THREE.MeshStandardMaterial({ color: 0x0e0f10, roughness: 0.6, metalness: 0 });
    // Rear lamps: red side/rear lenses (tail function) and the round lamps (tail + brake).
    this.tailMat = new THREE.MeshPhysicalMaterial({
      color: 0x3a0303, emissive: new THREE.Color(1, 0.02, 0.01), emissiveIntensity: 1.2,
      roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, opacity: 0.92,
    });
    this.brakeMat = this.tailMat.clone();
    const drlMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, emissive: new THREE.Color(0.93, 0.96, 1), emissiveIntensity: 2.4, roughness: 0.25 });
    const headGlass = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.25, depthWrite: false,
    });
    // Cabin (seen up close from the driver's seat): black leather with a soft sheen, Alcantara
    // headliner / pillar trim, dark carpet and red accent stitching. The source model's greys read as
    // primer-grey plastic in the cockpit view.
    const leather = new THREE.MeshPhysicalMaterial({
      color: 0x2b2b2d, roughness: 0.5, metalness: 0, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x5c5c5c), envMapIntensity: 0.45,
    });
    const alcantara = new THREE.MeshStandardMaterial({ color: 0x1e1e20, roughness: 0.92, metalness: 0, envMapIntensity: 0.35 });
    const trimDark = new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.68, metalness: 0.05, envMapIntensity: 0.5 });
    const carpet = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.97, metalness: 0, envMapIntensity: 0.2 });
    const stitch = new THREE.MeshStandardMaterial({ color: 0x6e0d0d, roughness: 0.55, metalness: 0, envMapIntensity: 0.4 });

    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const n = o.material.name;
      switch (n) {
        case 'Body_Color': o.material = paint; break;
        case 'Glass_Gray': o.material = glass; o.castShadow = false; o.renderOrder = 2; break;
        case 'Tires': o.material = rubber; break;
        case 'metal_chrome': o.material = chrome; break;
        case 'Carbon_Fiber': o.material = carbon; break;
        case 'plastic_gray': o.material = plastic; break;
        case 'Taillight_Glass': o.material = o.name === 'brakes' ? this.brakeMat : this.tailMat; break;
        case 'Turn_Signal_LED': o.material = drlMat; o.castShadow = false; break;
        case 'Projector_Glass': o.material = headGlass; o.castShadow = false; break;
        case 'Leather': o.material = leather; break;
        case 'Interior_dark': o.material = alcantara; break;
        case 'Interior_light': o.material = trimDark; break;
        case 'Carpet': o.material = carpet; break;
        case 'Leather_red': o.material = stitch; break;
        case 'metal_gray':
          if (o.name.startsWith('rim')) o.material = rimLip;
          else if (o.name === 'brake') o.material = brakeDisc;
          else if (o.name === 'wheel') o.material = rim;
          else o.material = plastic;
          break;
        default:
          if (o.material.isMeshStandardMaterial) {
            o.material.roughness = Math.max(o.material.roughness, 0.45);
            o.material.envMapIntensity = 0.7;
          }
      }
    });

    // Re-parent wheels under steering pivots so steer, spin and suspension compose cleanly.
    for (const w of WHEELS) {
      const node = model.getObjectByName(w.name);
      const pivot = new THREE.Group();
      pivot.position.copy(node.position);
      model.add(pivot);
      pivot.add(node);
      node.position.set(0, 0, 0);
      this.wheels.push({ node, pivot, baseQuat: node.quaternion.clone(), restY: pivot.position.y, front: w.front });
    }
    this.steeringWheel = model.getObjectByName('steering_wheel');
    this.steeringBase = this.steeringWheel?.quaternion.clone();

    this.root.add(model);
    this.#buildLights(model);
    this.#buildGauges(model);
    this.#buildDoor(model);

    // Baked ambient-occlusion decal under the car (from the three.js example asset).
    const ao = new THREE.Mesh(
      new THREE.PlaneGeometry(0.655 * 4, 1.3 * 4),
      new THREE.MeshBasicMaterial({ map: aoTex, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, depthWrite: false, premultipliedAlpha: true }),
    );
    ao.rotation.x = -Math.PI / 2;
    ao.renderOrder = 2;
    this.aoDecal = ao;
    this.scene.add(ao);
  }

  /**
   * Real headlight beams + emissive lamp emitters, all parented to the car so they
   * follow its motion. Lamp positions are measured from the model's own lamp meshes.
   */
  #buildLights(model) {
    model.updateMatrixWorld(true);
    const toCar = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const cluster = (name, filter) => {
      const mesh = model.getObjectByName(name);
      const o = mesh.isMesh ? mesh : mesh.children.find((c) => c.isMesh);
      const m = toCar.clone().multiply(o.matrixWorld);
      const p = o.geometry.attributes.position, v = new THREE.Vector3();
      const out = { L: new THREE.Box3(), R: new THREE.Box3() };
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m);
        if (filter && !filter(v)) continue;
        out[v.x < 0 ? 'L' : 'R'].expandByPoint(v);
      }
      return out;
    };
    // headlight projector lenses (Projector_Glass) and the outer round rear lamps
    const heads = cluster('lights');
    const rears = cluster('brakes', (v) => Math.abs(v.x) > 0.6);

    const disc = new THREE.CircleGeometry(1, 24);
    this.headLensMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.97, 0.9), emissiveIntensity: 6 });
    this.reverseMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, emissive: new THREE.Color(1, 1, 0.97), emissiveIntensity: 0, roughness: 0.2 });
    this.headSpots = [];
    for (const side of ['L', 'R']) {
      const h = heads[side].getCenter(new THREE.Vector3());
      const lens = new THREE.Mesh(disc, this.headLensMat);
      lens.scale.setScalar(0.034);
      lens.position.set(h.x, h.y, heads[side].min.z - 0.004);
      lens.rotation.y = Math.PI; // CircleGeometry faces +Z; lamps face forward (-Z)
      this.root.add(lens);

      const spot = new THREE.SpotLight(0xfff3e4, 0, 70, HEADLIGHT_MODES[0].angle, 0.6, 2);
      spot.position.set(h.x, h.y, heads[side].min.z - 0.05);
      spot.target.position.set(h.x * 1.25, HEADLIGHT_MODES[0].aimY, HEADLIGHT_MODES[0].aimZ);
      spot.castShadow = false;
      this.root.add(spot, spot.target);
      this.headSpots.push(spot);

      // reverse lamp in the centre of each outer round tail lamp
      const r = rears[side];
      const c = r.getCenter(new THREE.Vector3());
      const rev = new THREE.Mesh(disc, this.reverseMat);
      rev.scale.setScalar(Math.min(r.max.x - r.min.x, r.max.y - r.min.y) * 0.22);
      rev.position.set(c.x, c.y, r.max.z + 0.003);
      this.root.add(rev);
    }
    this.headlightMode = 0;
    this.brakeGlow = 0;
    this.reverseGlow = 0;
    this.#applyHeadlights();
  }

  /**
   * Working tachometer for the driver view: a printed dial laid over the model's plain yellow tach
   * disc (measured from the mesh), a needle driven by a simulated 7-speed gearbox, and a small
   * gear/speed readout that is redrawn only when its text changes.
   */
  #buildGauges(model) {
    const mesh = model.getObjectByName('yellow_trim');
    const o = mesh && (mesh.isMesh ? mesh : mesh.children.find((c) => c.isMesh));
    if (!o) return;
    const toCar = new THREE.Matrix4().copy(this.root.matrixWorld).invert().multiply(o.matrixWorld);
    const p = o.geometry.attributes.position, v = new THREE.Vector3(), bb = new THREE.Box3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(toCar);
      if (v.x < 0 && v.x > -0.6 && v.z > -0.85 && v.z < -0.5 && v.y > 0.6) bb.expandByPoint(v); // the disc behind the wheel
    }
    if (bb.isEmpty()) return;
    const size = bb.getSize(new THREE.Vector3());
    const radius = size.x / 2;
    // the disc leans back: its height/depth extents give the face normal (towards the driver, +Z)
    const normal = new THREE.Vector3(0, size.z, size.y).normalize();

    const S = 512, face = document.createElement('canvas');
    face.width = face.height = S;
    const g = face.getContext('2d');
    const c = S / 2;
    const grad = g.createRadialGradient(c, c * 0.8, S * 0.05, c, c, c);
    grad.addColorStop(0, '#ffe23a');
    grad.addColorStop(1, '#e9b800');
    g.fillStyle = grad;
    g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.fill();
    const ang = (rpm) => (135 + (rpm / 10000) * 270) * (Math.PI / 180);
    // red line 8.5–10k
    g.strokeStyle = '#c4120c'; g.lineWidth = S * 0.06;
    g.beginPath(); g.arc(c, c, c * 0.86, ang(8500), ang(10000)); g.stroke();
    g.strokeStyle = '#111'; g.fillStyle = '#111';
    for (let r = 0; r <= 10000; r += 250) {
      const major = r % 1000 === 0, half = r % 500 === 0;
      const a = ang(r), r0 = c * (major ? 0.72 : half ? 0.8 : 0.85), r1 = c * 0.93;
      g.lineWidth = major ? S * 0.018 : S * 0.008;
      g.beginPath(); g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0); g.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1); g.stroke();
      if (major) {
        g.font = `bold ${S * 0.1}px Arial, Helvetica, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(r / 1000), c + Math.cos(a) * c * 0.56, c + Math.sin(a) * c * 0.56);
      }
    }
    g.font = `${S * 0.045}px Arial, Helvetica, sans-serif`;
    g.fillText('RPM x1000', c, c * 0.62);
    const faceTex = new THREE.CanvasTexture(face);
    faceTex.colorSpace = THREE.SRGBColorSpace;
    faceTex.anisotropy = 8;

    const gauge = new THREE.Group();
    gauge.position.copy(bb.getCenter(new THREE.Vector3())).addScaledVector(normal, 0.0015);
    gauge.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    const dial = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.98, 48),
      // printed face, lit by the scene plus a faint backlight
      new THREE.MeshStandardMaterial({ map: faceTex, emissiveMap: faceTex, emissive: 0xffffff, emissiveIntensity: 0.12, roughness: 0.55 }),
    );
    const needleGeo = new THREE.PlaneGeometry(radius * 0.06, radius * 0.92);
    needleGeo.translate(0, radius * 0.92 / 2 - radius * 0.12, 0);
    const needle = new THREE.Mesh(needleGeo, new THREE.MeshStandardMaterial({ color: 0xd8250f, emissive: 0xff2a0c, emissiveIntensity: 0.6, roughness: 0.4 }));
    needle.position.z = 0.0012;
    const cap = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.12, 24), new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.3, metalness: 0.6 }));
    cap.position.z = 0.0018;
    // digital gear + speed window in the lower half of the dial
    const dig = document.createElement('canvas');
    dig.width = 256; dig.height = 128;
    const digTex = new THREE.CanvasTexture(dig);
    digTex.colorSpace = THREE.SRGBColorSpace;
    const readout = new THREE.Mesh(
      new THREE.PlaneGeometry(radius * 0.7, radius * 0.35),
      new THREE.MeshBasicMaterial({ map: digTex, toneMapped: true }),
    );
    readout.position.set(0, -radius * 0.52, 0.001);
    for (const m of [dial, needle, cap, readout]) { m.castShadow = false; m.receiveShadow = m !== readout; gauge.add(m); }
    this.root.add(gauge);
    this.gauge = { needle, dig, digTex, text: '', rpm: 900, gear: 1 };
  }

  #updateGauges(vehicle, dt) {
    const G = this.gauge;
    if (!G) return;
    // km/h at the 9000 rpm limit in each gear (7-speed dual clutch)
    const TOP = [0, 70, 106, 143, 182, 222, 266, 325];
    const kmh = Math.abs(vehicle.speed) * 3.6;
    if (kmh > TOP[G.gear] * 0.88 && G.gear < 7) G.gear++;
    else if (G.gear > 1 && kmh < TOP[G.gear - 1] * 0.6) G.gear--;
    const load = vehicle.throttle ?? 0;
    const target = Math.min(9200, Math.max(900 + load * 1400 * (kmh < 8 ? 1 : 0), (kmh / TOP[G.gear]) * 9000));
    G.rpm = approach(G.rpm, target, dt * (target > G.rpm ? 9 : 5));
    G.needle.rotation.z = THREE.MathUtils.degToRad(135 - G.rpm * 0.027);
    const gear = vehicle.reversing && vehicle.speed < 0.5 ? 'R' : kmh < 1 ? 'N' : String(G.gear);
    const text = `${gear}|${Math.round(kmh)}`;
    if (text !== G.text) {
      G.text = text;
      const g = G.dig.getContext('2d');
      g.fillStyle = '#060607'; g.fillRect(0, 0, 256, 128);
      g.fillStyle = '#f2f2f2'; g.textBaseline = 'middle';
      g.font = 'bold 92px Arial, Helvetica, sans-serif'; g.textAlign = 'left';
      g.fillText(gear, 18, 66);
      g.font = 'bold 54px Arial, Helvetica, sans-serif'; g.textAlign = 'right';
      g.fillText(String(Math.round(kmh)), 240, 56);
      g.font = '24px Arial, Helvetica, sans-serif';
      g.fillText('km/h', 240, 104);
      G.digTex.needsUpdate = true;
    }
  }

  /**
   * The driver's door is modelled as loose shells inside the merged body/interior meshes (outer
   * panel, inner trim, armrest, sill cap, mirror). Every connected component that lies entirely
   * inside the door volume is moved into its own mesh under a hinge at the door's front edge.
   */
  #buildDoor(model) {
    const VOL = { x0: -1.2, x1: -0.64, y0: 0.1, y1: 1.08, z0: -0.82, z1: 0.62 }; // car-local
    const toCar = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const parts = [];
    const bb = new THREE.Box3();
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry.index || /^(wheel|rim|tire|brake|nuts|centre|steering)/.test(o.name)) return;
      const g = o.geometry, idx = g.index.array, pos = g.attributes.position;
      const m = toCar.clone().multiply(o.matrixWorld);
      // union-find over vertices of each triangle
      const parent = new Int32Array(pos.count).map((_, i) => i);
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      for (let t = 0; t < idx.length; t += 3) {
        const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]);
        parent[b] = a; parent[find(c)] = a;
      }
      // also merge vertices that share a position (UV seams split shells into islands)
      const key = new Map(), v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        const k = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
        const j = key.get(k);
        if (j === undefined) key.set(k, i); else parent[find(i)] = find(j);
      }
      const inside = new Map(); // component root → still fully inside
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        const r = find(i);
        const ok = v.x > VOL.x0 && v.x < VOL.x1 && v.y > VOL.y0 && v.y < VOL.y1 && v.z > VOL.z0 && v.z < VOL.z1;
        inside.set(r, (inside.get(r) ?? true) && ok);
      }
      const keep = [], door = [];
      for (let t = 0; t < idx.length; t += 3) (inside.get(find(idx[t])) ? door : keep).push(idx[t], idx[t + 1], idx[t + 2]);
      if (!door.length) return;
      // door triangles → a new compact mesh in car space; the original keeps the rest
      const dg = compactGeometry(g, door);
      dg.applyMatrix4(m);
      g.setIndex(keep);
      const dm = new THREE.Mesh(dg, o.material);
      dm.name = `door_${o.name}`;
      dm.castShadow = o.castShadow; dm.receiveShadow = o.receiveShadow; dm.renderOrder = o.renderOrder;
      parts.push(dm);
      dg.computeBoundingBox();
      bb.union(dg.boundingBox);
    });
    if (!parts.length) return;
    // hinge: front edge of the door, outer side; the door swings out (rear edge moves to -X)
    const hinge = new THREE.Group();
    hinge.name = 'driver-door';
    hinge.position.set(bb.min.x + 0.04, 0, bb.min.z + 0.02);
    this.root.add(hinge);
    for (const p of parts) { p.position.sub(hinge.position); hinge.add(p); }
    this.door = { hinge, open: 0, target: 0, box: bb.clone(), maxAngle: THREE.MathUtils.degToRad(68) };
  }

  /** Door opening 0 (shut) … 1 (fully open); animated in sync() with a damped swing. */
  setDoor(target) { if (this.door) this.door.target = target; }
  get doorOpen() { return this.door?.open ?? 0; }

  #applyHeadlights() {
    const m = HEADLIGHT_MODES[this.headlightMode];
    this.headSpots.forEach((s) => {
      s.intensity = m.spot;
      s.angle = m.angle;
      s.target.position.y = m.aimY;
      s.target.position.z = m.aimZ;
    });
    this.headLensMat.emissiveIntensity = m.lens;
  }

  /** L key: low beam → high beam → off. Intensity-only changes keep shader programs stable. */
  cycleHeadlights() {
    this.headlightMode = (this.headlightMode + 1) % HEADLIGHT_MODES.length;
    this.#applyHeadlights();
    return `Headlights: ${HEADLIGHT_MODES[this.headlightMode].name}`;
  }

  /** Use a local reflection probe for the reflective car materials. */
  setEnvMap(tex) {
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (m.isMeshStandardMaterial && (m.metalness > 0.5 || m.clearcoat > 0 || m.roughness < 0.2 || m.transparent)) {
        m.envMap = tex;
        m.needsUpdate = true;
      }
    });
  }

  /**
   * Sync visuals. pose: interpolated chassis {position, quaternion};
   * wheelState: per wheel {rotation, steering, suspension}.
   */
  sync(pos, quat, vehicle, dt = 1 / 60, groundY = 0) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    const ctrl = vehicle.ctrl;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const susp = ctrl.wheelSuspensionLength(i) ?? 0.12;
      const conn = WHEEL_RADIUS + 0.16 - 0.04;
      w.pivot.position.y = conn - susp;
      w.pivot.rotation.y = w.front ? vehicle.steer : 0;
      const spin = -(ctrl.wheelRotation(i) ?? 0);
      _q.setFromAxisAngle(X_AXIS, spin);
      w.node.quaternion.copy(_q).multiply(w.baseQuat);
    }
    if (this.steeringWheel) {
      this.steeringWheel.quaternion.copy(this.steeringBase);
      this.steeringWheel.rotateOnAxis(Y_AXIS, -vehicle.steer * 4);
    }
    // LED lamps: fast but not instantaneous
    const lightsOn = HEADLIGHT_MODES[this.headlightMode].spot > 0;
    this.brakeGlow = approach(this.brakeGlow, vehicle.braking ? 1 : 0, dt * 25);
    this.reverseGlow = approach(this.reverseGlow, vehicle.reversing ? 1 : 0, dt * 25);
    this.tailMat.emissiveIntensity = (lightsOn ? 1.6 : 0.5) + 2.5 * this.brakeGlow;
    this.brakeMat.emissiveIntensity = (lightsOn ? 2.0 : 0.6) + 16 * this.brakeGlow;
    this.reverseMat.emissiveIntensity = 9 * this.reverseGlow;
    this.#updateGauges(vehicle, dt);
    if (this.door) {
      const D = this.door;
      // a door swings with momentum and a soft stop rather than linearly
      D.open = approach(D.open, D.target, dt * (D.target > D.open ? 3.2 : 4.0));
      const e = D.open * D.open * (3 - 2 * D.open);
      D.hinge.rotation.y = -D.maxAngle * e;
    }

    // contact AO stays flat on the ground under the chassis
    this.aoDecal.position.set(pos.x, groundY + 0.012, pos.z);
    this.aoDecal.rotation.set(-Math.PI / 2, 0, vehicle.heading());
  }
}
