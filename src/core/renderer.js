import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, Effect, SMAAEffect, SMAAPreset } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { CONFIG } from '../config.js';

/**
 * Exposure → tone map → colour grade, in a single full-screen effect.
 * Tone mapping lives here (not in the renderer) so AO, bloom and grading all
 * operate on HDR / display-referred data in the right order.
 */
const GRADE_FRAG = /* glsl */ `
uniform float exposure;
uniform float saturation;
uniform float contrast;
uniform vec3 whiteBalance;
uniform vec3 lift;
uniform vec3 gain;
uniform float vignette;
uniform int operator;

// Stephen Hill's ACES fit.
const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c) { return clamp(ACESOut * rrtOdt(ACESIn * c), 0.0, 1.0); }

// Khronos PBR Neutral.
vec3 pbrNeutral(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1. - startCompression;
  float newPeak = 1. - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1. - 1. / (desaturation * (peak - newPeak) + 1.);
  return mix(color, newPeak * vec3(1, 1, 1), g);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * exposure * whiteBalance;
  c = operator == 0 ? acesFitted(c) : pbrNeutral(c);

  // Grade in a perceptual-ish space.
  vec3 p = pow(max(c, 0.0), vec3(1.0 / 2.2));
  p = (p - 0.5) * contrast + 0.5;
  p = p * gain + lift * (1.0 - p);
  float l = luma(p);
  p = mix(vec3(l), p, saturation);
  vec2 d = uv - 0.5;
  p *= 1.0 - vignette * dot(d, d) * 1.6;
  c = pow(clamp(p, 0.0, 1.0), vec3(2.2));

  outputColor = vec4(c, inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor(opts = {}) {
    super('GradeEffect', GRADE_FRAG, {
      uniforms: new Map([
        ['exposure', new THREE.Uniform(opts.exposure ?? 1)],
        ['saturation', new THREE.Uniform(opts.saturation ?? 1)],
        ['contrast', new THREE.Uniform(opts.contrast ?? 1)],
        ['whiteBalance', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['lift', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['vignette', new THREE.Uniform(opts.vignette ?? 0.15)],
        ['operator', new THREE.Uniform(opts.operator ?? 0)],
      ]),
    });
  }
  set(name, value) {
    const u = this.uniforms.get(name);
    if (u.value?.isVector3) u.value.fromArray(value);
    else u.value = value;
  }
}

export function createRenderer(container) {
  const q = CONFIG.quality;
  const renderer = new THREE.WebGLRenderer({
    powerPreference: 'high-performance',
    antialias: false,
    stencil: false,
    depth: true,
    preserveDrawingBuffer: CONFIG.capture,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);
  return renderer;
}

export class PostFX {
  constructor(renderer, scene, camera) {
    const q = CONFIG.quality;
    this.renderer = renderer;
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: Math.min(q.msaa, renderer.capabilities.maxSamples),
    });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    if (q.ao) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      this.ao = new N8AOPostPass(scene, camera, size.x, size.y);
      Object.assign(this.ao.configuration, {
        aoRadius: 1.6,
        distanceFalloff: 0.35,
        intensity: 2.2,
        aoSamples: 16,
        denoiseSamples: 8,
        denoiseRadius: 8,
        halfRes: q.aoHalfRes,
        depthAwareUpsampling: true,
        gammaCorrection: false,
        screenSpaceRadius: false,
      });
      this.ao.configuration.color.set(0x050608);
      this.composer.addPass(this.ao);
    }

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 1.4,
      luminanceSmoothing: 0.3,
      intensity: 0.35,
      radius: 0.65,
    });
    this.grade = new GradeEffect();
    const effects = [this.bloom, this.grade];
    this.composer.addPass(new EffectPass(camera, ...effects));
    if (q.msaa === 0) this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
  }

  render(dt) {
    this.composer.render(dt);
  }
}
