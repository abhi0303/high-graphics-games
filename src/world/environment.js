import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createNoiseTexture } from './noise.js';

/**
 * Sky, sun and atmosphere.
 *
 * The HDRI provides sky lighting + reflections. Its sun disk is located,
 * clamped out of the map (so image-based lighting doesn't leak light into
 * shadowed areas) and replaced by a shadow-casting directional light pointing
 * the same way, so reflections, sky gradient and shadows all agree.
 */
export class Environment {
  /** Desired sun azimuth in world space (radians, 0 = +X, measured toward -Z = north). */
  static SUN_AZIMUTH = THREE.MathUtils.degToRad(-42);
  static SUN_ELEVATION = THREE.MathUtils.degToRad(41);
  static SUN_TO_SKY = 4.2;

  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunDir = new THREE.Vector3();
    this.shadowCenter = new THREE.Vector3();

    const q = CONFIG.quality;
    this.sun = new THREE.DirectionalLight(0xfff1e2, 5.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    this.shadowExtent = 70;
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowExtent; cam.right = this.shadowExtent;
    cam.top = this.shadowExtent; cam.bottom = -this.shadowExtent;
    cam.near = 1; cam.far = 900;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = q.shadowRadius;
    scene.add(this.sun, this.sun.target);

    scene.fog = new THREE.FogExp2(0xc4d2e0, 0.00072);
  }

  async load(assets) {
    const hdr = await assets.hdr(`hdri/${CONFIG.hdri}.hdr`);
    const { sunMapDir, skyAvg, horizon } = processHdr(hdr);
    this.horizon = horizon;
    // Physically motivated calibration: on a clear day the sun delivers ~4x the
    // sky's irradiance on a horizontal surface. Sky irradiance = pi * L_avg, so
    // I_sun * sin(el) = 4 * pi * L_avg. Exposure maps a sunlit white surface to ~1.4.
    const sinEl = Math.sin(Environment.SUN_ELEVATION);
    this.sun.intensity = (Environment.SUN_TO_SKY * Math.PI * skyAvg) / sinEl;
    const whiteLum = (this.sun.intensity * sinEl * 0.8) / Math.PI + skyAvg * 0.8;
    this.exposure = 1.8 / whiteLum;
    this.skyAvg = skyAvg;

    // Rotate the sky so its sun ends up at the azimuth we want for the composition.
    const hdrAz = Math.atan2(-sunMapDir.z, sunMapDir.x);
    const rotY = Environment.SUN_AZIMUTH - hdrAz;
    // For PMREM / cube render targets three applies R(-θ) when sampling, so a
    // positive rotation turns sky features by +θ about Y (azimuth += θ).
    this.scene.backgroundRotation.set(0, rotY, 0);
    this.scene.environmentRotation.set(0, rotY, 0);
    const az = Environment.SUN_AZIMUTH;
    // Keep the HDRI's sun azimuth aligned; use our own elevation for the desired shadow length.
    const el = Environment.SUN_ELEVATION;
    this.sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el)).normalize();

    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromEquirectangular(hdr).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 1.0;
    this.scene.background = hdr;
    this.scene.backgroundIntensity = 1.0;
    this.hdrTexture = hdr;

    // Aerial perspective: fog and a sky-haze dome share the HDRI's own horizon colour,
    // so distant geometry fades into exactly the sky behind it.
    const hz = new THREE.Color().setRGB(horizon[0], horizon[1], horizon[2]).multiplyScalar(1.08);
    this.scene.fog.color.copy(hz);
    this.#hazeDome(hz);
    this.#clouds(hz);
    this.update(new THREE.Vector3());
  }

  /** Transparent gradient dome between the HDRI and the scene: hazier, paler sky toward the horizon. */
  #hazeDome(color) {
    const g = new THREE.SphereGeometry(8600, 64, 32);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const el = Math.asin(THREE.MathUtils.clamp(pos.getY(i) / 8600, -1, 1));
      const t = Math.max(0, el) / (Math.PI / 2);
      const a = el < 0 ? 0.95 : 0.16 + 0.7 * Math.pow(1 - t, 8) + 0.08 * (1 - t);
      col.set([color.r, color.g, color.b, Math.min(a, 0.95)], i * 4);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide });
    const dome = new THREE.Mesh(g, m);
    dome.name = 'haze-dome';
    dome.renderOrder = -2;
    dome.frustumCulled = false;
    this.dome = dome;
    this.scene.add(dome);
  }

  /**
   * Thin, wispy fair-weather clouds: two-scale fBm projected onto a virtual
   * cloud plane, stretched into streaks, brightened toward the sun and faded
   * into the horizon haze. Rendered between the haze dome and the scene.
   */
  #clouds(horizon) {
    const noise = createNoiseTexture(512, 17);
    const g = new THREE.SphereGeometry(8400, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
      uniforms: {
        uNoise: { value: noise },
        uSun: { value: this.sunDir },
        uTime: { value: 0 },
        uLit: { value: new THREE.Color(horizon).multiplyScalar(3.0) },
        uShade: { value: new THREE.Color(horizon).multiplyScalar(1.9) },
        uRot: { value: this.scene.backgroundRotation.y },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uNoise;
        uniform vec3 uSun, uLit, uShade;
        uniform float uTime;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          if (d.y < 0.015) discard;
          vec2 p = d.xz / (d.y + 0.12);
          p = mat2(0.92, 0.39, -0.39, 0.92) * p;
          p += vec2(uTime * 0.0012, uTime * 0.0004);
          float base = texture2D(uNoise, p * 0.07).r;
          float detail = texture2D(uNoise, p * 0.31 + 0.31).g;
          float streak = texture2D(uNoise, vec2(p.x * 0.06, p.y * 0.3) + 0.7).b;
          float n = base * 0.62 + detail * 0.26 + streak * 0.18;
          float dens = smoothstep(0.58, 0.88, n);
          dens *= smoothstep(0.03, 0.35, d.y);                // fade into haze
          dens *= 0.5 + 0.5 * texture2D(uNoise, p * 1.3).a;   // ragged, wispy edges
          float sunAmt = pow(max(dot(d, uSun), 0.0), 6.0);
          vec3 col = mix(uShade, uLit, 0.6 + 0.4 * detail) * (1.0 + sunAmt * 0.6);
          gl_FragColor = vec4(col, dens * 0.72);
        }`,
    });
    const dome = new THREE.Mesh(g, m);
    dome.name = 'clouds';
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    this.cloudDome = dome;
    this.scene.add(dome);
  }

  /** Keep the shadow frustum centred on what the camera is looking at, snapped to texels. */
  update(focus) {
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    // Build light-space basis for texel snapping.
    const z = this.sunDir;
    const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
    const y = z.clone().cross(x);
    const fx = Math.round(focus.dot(x) / texel) * texel;
    const fy = Math.round(focus.dot(y) / texel) * texel;
    const fz = focus.dot(z);
    this.shadowCenter.copy(x).multiplyScalar(fx).addScaledVector(y, fy).addScaledVector(z, fz);
    this.sun.target.position.copy(this.shadowCenter);
    this.sun.position.copy(this.shadowCenter).addScaledVector(this.sunDir, 400);
    this.sun.target.updateMatrixWorld();
  }
}

/**
 * Finds the sun in an equirect HDR, clamps it (and other extreme highlights)
 * out, and returns its direction in map space. Works on half-float data
 * directly: positive half floats sort the same as their bit patterns, so the
 * hot loop never has to decode.
 */
function processHdr(tex) {
  const { data, width, height } = tex.image;
  const isHalf = data instanceof Uint16Array;
  const dec = isHalf ? (v) => THREE.DataUtils.fromHalfFloat(v) : (v) => v;
  const enc = isHalf ? (v) => THREE.DataUtils.toHalfFloat(v) : (v) => v;
  const stride = data.length / (width * height);

  let best = 0, bestIdx = 0;
  const half = (height >> 1) * width;
  for (let p = 0; p < half; p++) {
    const g = data[p * stride + 1];
    if (g > best) { best = g; bestIdx = p; }
  }

  const CLAMP = 12;
  const limit = enc(CLAMP);
  for (let p = 0; p < width * height; p++) {
    const i = p * stride;
    if (data[i] < limit && data[i + 1] < limit && data[i + 2] < limit) continue;
    const r = dec(data[i]), g = dec(data[i + 1]), b = dec(data[i + 2]);
    const s = CLAMP / Math.max(r, g, b);
    data[i] = enc(r * s); data[i + 1] = enc(g * s); data[i + 2] = enc(b * s);
  }
  tex.needsUpdate = true;

  // cos-weighted mean luminance of the upper hemisphere (post-clamp), sampled sparsely
  let sum = 0, wsum = 0;
  for (let y = 0; y < height / 2; y += 4) {
    const v = tex.flipY ? 1 - (y + 0.5) / height : (y + 0.5) / height;
    const w = Math.sin((v - 0.5) * Math.PI) * Math.cos((v - 0.5) * Math.PI);
    if (w <= 0) continue;
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * stride;
      sum += w * (0.2126 * dec(data[i]) + 0.7152 * dec(data[i + 1]) + 0.0722 * dec(data[i + 2]));
      wsum += w;
    }
  }
  const skyAvg = sum / wsum;
  // mean colour of the band 2–9 degrees above the horizon
  const horizon = [0, 0, 0];
  let hn = 0;
  for (let y = 0; y < height / 2; y++) {
    const v = tex.flipY ? 1 - (y + 0.5) / height : (y + 0.5) / height;
    const lat = (v - 0.5) * 180;
    if (lat < 2 || lat > 9) continue;
    for (let x = 0; x < width; x += 8) {
      const i = (y * width + x) * stride;
      horizon[0] += dec(data[i]); horizon[1] += dec(data[i + 1]); horizon[2] += dec(data[i + 2]);
      hn++;
    }
  }
  horizon.forEach((c, k) => { horizon[k] = c / hn; });

  const bx = bestIdx % width, by = Math.floor(bestIdx / width);
  const u = (bx + 0.5) / width;
  const v = tex.flipY ? 1 - (by + 0.5) / height : (by + 0.5) / height;
  const phi = (u - 0.5) * Math.PI * 2;
  const lat = (v - 0.5) * Math.PI;
  const sunMapDir = new THREE.Vector3(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat));
  return { sunMapDir, peak: dec(best), skyAvg, horizon };
}
