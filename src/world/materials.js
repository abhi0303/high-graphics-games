import * as THREE from 'three';
import { createNoiseTexture } from './noise.js';

/**
 * Inject GLSL into a built-in material. Adds a world-position varying (vWPos),
 * metric uv varying (vMUv) and the shared noise sampler, then performs chunk
 * replacements on the fragment shader.
 */
export function inject(material, { key, uniforms = {}, fragPars = '', vertPars = '', vertMain = '', replace = {}, after = {} }) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec2 vMUv;\n${vertPars}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
        #endif
        vWPos = (modelMatrix * wp4).xyz;
        vMUv = uv;
        ${vertMain}`);
    let fs = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec2 vMUv;\n${fragPars}`);
    for (const [chunk, code] of Object.entries(replace)) fs = fs.replace(`#include <${chunk}>`, code);
    for (const [chunk, code] of Object.entries(after)) fs = fs.replace(`#include <${chunk}>`, `#include <${chunk}>\n${code}`);
    shader.fragmentShader = fs;
    material.userData.shader = shader;
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|${key}`;
  return material;
}

const NOISE_PARS = /* glsl */ `
uniform sampler2D uNoise;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
`;

/** Two differently scaled + rotated samples blended by low-frequency noise: kills visible tiling. */
const ANTI_TILE_PARS = /* glsl */ `
float atW;
vec2 atA, atB;
const float AT_ROT = 0.6435;
void atSetup(vec2 p, float tile) {
  atA = p / tile;
  atB = rot2(p, AT_ROT) / (tile * 1.37) + vec2(0.37, 0.11);
  atW = smoothstep(0.36, 0.64, texture2D(uNoise, p * 0.021).g);
}
vec4 atSample(sampler2D s) { return mix(texture2D(s, atA), texture2D(s, atB), atW); }
vec3 atNormal(sampler2D s) {
  vec3 a = texture2D(s, atA).xyz * 2.0 - 1.0;
  vec3 b = texture2D(s, atB).xyz * 2.0 - 1.0;
  b.xy = rot2(b.xy, -AT_ROT);
  return normalize(mix(a, b, atW));
}
`;

export class Materials {
  constructor(assets, renderer) {
    this.assets = assets;
    this.renderer = renderer;
    this.noise = createNoiseTexture(256, 3);
    this.noiseUniform = { value: this.noise };
  }

  async init() {
    const a = this.assets;
    const [asphalt, asphaltB, concrete, curb] = await Promise.all([
      a.pbr('asphalt_02', '2k'),
      a.pbr('asphalt_01', '2k'),
      a.pbr('concrete_floor_worn_001', '2k'),
      a.pbr('brushed_concrete', '1k'),
    ]);
    this.tex = { asphalt, asphaltB, concrete, curb };

    this.asphalt = this.#asphalt(asphalt, asphaltB);
    this.sidewalk = this.#sidewalk(concrete);
    this.curb = this.#curb(curb);
    this.paint = this.#paint(asphalt);

    await this.#walls();
    this.#misc();
  }

  /** Road wear canvas (set by Roads once lanes are known). */
  setRoadWear(texture, rect) {
    this.asphaltUniforms.uWear.value = texture;
    this.asphaltUniforms.uWearRect.value.set(rect.x0, rect.z0, 1 / rect.w, 1 / rect.d);
  }

  #asphalt(t, tB) {
    const m = new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.arm, aoMap: t.arm,
      roughness: 1, metalness: 0, normalScale: new THREE.Vector2(1.45, 1.45), aoMapIntensity: 0.9,
      color: new THREE.Color(1.2, 1.18, 1.16),
    });
    this.asphaltUniforms = {
      uNoise: this.noiseUniform,
      uMapB: { value: tB.map },
      uWear: { value: null },
      uWearRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    return inject(m, {
      key: 'asphalt',
      uniforms: this.asphaltUniforms,
      fragPars: NOISE_PARS + ANTI_TILE_PARS + /* glsl */ `
        uniform sampler2D uMapB;
        uniform sampler2D uWear;
        uniform vec4 uWearRect;
        vec4 wearS;
      `,
      replace: {
        map_fragment: /* glsl */ `
          atSetup(vWPos.xz, 3.0);
          vec2 wuv = (vWPos.xz - uWearRect.xy) * uWearRect.zw;
          wearS = (wuv.x > 0.0 && wuv.x < 1.0 && wuv.y > 0.0 && wuv.y < 1.0) ? texture2D(uWear, wuv) : vec4(0.0);
          vec4 sampledDiffuseColor = atSample(map);
          // expand aggregate contrast: light stones vs dark binder, like weathered road asphalt
          float lumA = dot(sampledDiffuseColor.rgb, vec3(0.333));
          sampledDiffuseColor.rgb = max(vec3(0.0), mix(vec3(lumA), sampledDiffuseColor.rgb, 0.55) * (1.0 + (lumA - 0.11) * 3.2));
          // A second, finer asphalt used for patches / resurfaced strips.
          vec3 patchCol = texture2D(uMapB, vWPos.xz / 2.1).rgb * vec3(0.78, 0.79, 0.82);
          sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, patchCol, wearS.b);
          float macro = texture2D(uNoise, vWPos.xz * 0.006).r;
          float mid = texture2D(uNoise, vWPos.xz * 0.05 + 0.3).a;
          sampledDiffuseColor.rgb *= mix(0.84, 1.12, macro) * mix(0.93, 1.05, mid);
          sampledDiffuseColor.rgb *= 1.0 - 0.38 * wearS.r;                 // oil / rubber drip
          sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * 1.16 + 0.012, wearS.g); // polished wheel paths
          sampledDiffuseColor.rgb *= 1.0 - 0.55 * wearS.a;                 // crack sealant
          diffuseColor *= sampledDiffuseColor;
        `,
        roughnessmap_fragment: /* glsl */ `
          float roughnessFactor = roughness;
          vec4 texelRoughness = atSample(roughnessMap);
          roughnessFactor *= mix(texelRoughness.g, 0.82, wearS.b * 0.5);
          roughnessFactor *= 1.0 - 0.18 * wearS.r - 0.1 * wearS.g;
          roughnessFactor = clamp(roughnessFactor, 0.45, 1.0);
        `,
        normal_fragment_maps: /* glsl */ `
          vec3 mapN = atNormal(normalMap);
          mapN.xy *= normalScale * (1.0 - 0.45 * wearS.b) * (1.0 - 0.25 * wearS.g);
          normal = normalize(tbn * mapN);
        `,
        aomap_fragment: /* glsl */ `
          float ambientOcclusion = (atSample(aoMap).r - 1.0) * aoMapIntensity + 1.0;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          #if defined( USE_CLEARCOAT )
            clearcoatSpecularIndirect *= ambientOcclusion;
          #endif
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), ambientOcclusion, material.roughness);
          #endif
        `,
      },
    });
  }

  #sidewalk(t) {
    const m = new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.arm, aoMap: t.arm,
      roughness: 1, metalness: 0, color: new THREE.Color(1.45, 1.42, 1.34), normalScale: new THREE.Vector2(0.9, 0.9),
    });
    return inject(m, {
      key: 'sidewalk',
      uniforms: { uNoise: this.noiseUniform },
      fragPars: NOISE_PARS + ANTI_TILE_PARS + /* glsl */ `
        const float SLAB = 1.524;
        float seam; vec2 slabId; vec2 seamDir; float crack;
      `,
      replace: {
        map_fragment: /* glsl */ `
          atSetup(vWPos.xz, 3.0);
          vec2 sc = vMUv / SLAB;
          slabId = floor(sc);
          vec2 f = fract(sc) - 0.5;
          vec2 dEdge = (0.5 - abs(f)) * SLAB;      // metres to nearest seam on each axis
          float e = min(dEdge.x, dEdge.y);
          seam = 1.0 - smoothstep(0.006, 0.016, e);
          seamDir = dEdge.x < dEdge.y ? vec2(sign(f.x), 0.0) : vec2(0.0, sign(f.y));
          float h = hash12(slabId);
          float h2 = hash12(slabId + 17.3);
          // occasional hairline crack across a slab
          float cn = texture2D(uNoise, vMUv * 0.21 + h * 7.0).b;
          crack = (h2 > 0.72) ? (1.0 - smoothstep(0.0, 0.012, abs(cn - 0.5))) : 0.0;
          vec4 sampledDiffuseColor = atSample(map);
          sampledDiffuseColor.rgb *= mix(0.9, 1.07, h) * vec3(1.0, mix(0.985, 1.0, h2), mix(0.96, 1.0, h2));
          float stain = texture2D(uNoise, vWPos.xz * 0.09).r;
          sampledDiffuseColor.rgb *= mix(1.0, 0.8, smoothstep(0.58, 0.8, stain));
          float spots = texture2D(uNoise, vWPos.xz * 0.9).a;
          sampledDiffuseColor.rgb *= mix(1.0, 0.72, smoothstep(0.72, 0.8, spots));   // gum / drip spots
          sampledDiffuseColor.rgb *= 1.0 - 0.5 * seam - 0.45 * crack;
          diffuseColor *= sampledDiffuseColor;
        `,
        roughnessmap_fragment: /* glsl */ `
          float roughnessFactor = roughness * atSample(roughnessMap).g;
          roughnessFactor = clamp(mix(roughnessFactor, 1.0, seam), 0.55, 1.0);
        `,
        normal_fragment_maps: /* glsl */ `
          vec3 mapN = atNormal(normalMap);
          mapN.xy *= normalScale;
          // bevel into the seam groove
          mapN.xy += seamDir * seam * 0.6 * vec2(1.0, -1.0);
          normal = normalize(tbn * normalize(mapN));
        `,
        aomap_fragment: /* glsl */ `
          float ambientOcclusion = (atSample(aoMap).r - 1.0) * aoMapIntensity + 1.0;
          ambientOcclusion *= 1.0 - 0.6 * seam;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
        `,
      },
    });
  }

  #curb(t) {
    const m = new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.arm, aoMap: t.arm,
      color: new THREE.Color(0.98, 0.97, 0.94), roughness: 1, metalness: 0, vertexColors: true,
    });
    return inject(m, {
      key: 'curb',
      uniforms: { uNoise: this.noiseUniform },
      fragPars: NOISE_PARS + ANTI_TILE_PARS,
      replace: {
        map_fragment: /* glsl */ `
          atSetup(vec2(vWPos.x + vWPos.z, vWPos.y * 3.0 + vWPos.x * 0.3), 1.6);
          vec4 sampledDiffuseColor = atSample(map);
          float grime = 1.0 - smoothstep(0.0, 0.14, vWPos.y);
          float n = texture2D(uNoise, vWPos.xz * 0.15).g;
          sampledDiffuseColor.rgb *= mix(1.0, 0.55, grime * 0.8) * mix(0.85, 1.08, n);
          diffuseColor *= sampledDiffuseColor;
        `,
      },
    });
  }

  /** Road paint: vertex-coloured (white / yellow), follows the asphalt relief, worn by noise. */
  #paint(t) {
    const m = new THREE.MeshStandardMaterial({
      normalMap: t.normalMap, roughness: 0.62, metalness: 0, vertexColors: true,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      normalScale: new THREE.Vector2(0.75, 0.75),
    });
    return inject(m, {
      key: 'paint',
      uniforms: { uNoise: this.noiseUniform, uAsphalt: { value: t.map } },
      fragPars: NOISE_PARS + ANTI_TILE_PARS + 'uniform sampler2D uAsphalt;',
      replace: {
        map_fragment: /* glsl */ `
          atSetup(vWPos.xz, 3.0);
          float wearN = texture2D(uNoise, vWPos.xz * 0.35).b * 0.6 + texture2D(uNoise, vWPos.xz * 0.06).r * 0.4;
          vec3 asp = atSample(uAsphalt).rgb;
          float cavity = 1.0 - dot(asp, vec3(0.333)) * 2.2;          // low (dark) aggregate gaps lose paint first
          float coverage = smoothstep(0.18, 0.48, wearN + 0.25 - cavity * 0.18);
          // feather the stripe edges using the metric uv (v = across stripe, 0..1)
          float edge = smoothstep(0.0, 0.06, vMUv.y) * smoothstep(1.0, 0.94, vMUv.y);
          diffuseColor.a *= coverage * mix(0.85, 1.0, edge);
          diffuseColor.rgb *= mix(0.78, 1.0, wearN) * mix(vec3(1.0), asp * 2.4, 0.18);
        `,
        normal_fragment_maps: /* glsl */ `
          // Stripes have arbitrary uv orientation; use a world-aligned frame so the
          // paint shares the exact relief of the asphalt underneath.
          vec3 mapN = atNormal(normalMap);
          mapN.xy *= normalScale;
          mat3 tbnW = mat3(normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz),
                           normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz), normal);
          normal = normalize(tbnW * mapN);
        `,
      },
    });
  }

  async #walls() {
    const defs = {
      stucco: ['white_stucco', 2.0],
      beige: ['beige_wall_001', 3.0],
      plaster: ['painted_plaster_wall', 2.0],
      yellowPlaster: ['yellow_plaster', 2.0],
      brickRed: ['red_brick_03', 1.4],
      brickLarge: ['large_red_bricks', 2.0],
      brickWhite: ['whitewashed_brick', 2.0],
      cladding: ['exterior_wall_cladding', 2.0],
      corrugated: ['corrugated_iron_02', 2.7],
      shutter: ['painted_metal_shutter', 2.0],
      tiles: ['rectangular_facade_tiles', 2.1],
      concrete: ['concrete_wall_008', 2.7],
      roof: ['bitumen', 6.0],
    };
    const loaded = await Promise.all(Object.values(defs).map(([id]) => this.assets.pbr(id, '1k')));
    this.walls = {};
    Object.keys(defs).forEach((name, i) => {
      const [, tile] = defs[name];
      const t = loaded[i];
      const clone = (tex) => { const c = tex.clone(); c.repeat.set(1 / tile, 1 / tile); c.needsUpdate = true; return c; };
      const m = new THREE.MeshStandardMaterial({
        map: clone(t.map), normalMap: clone(t.normalMap), roughnessMap: clone(t.arm), aoMap: clone(t.arm),
        metalnessMap: name === 'corrugated' || name === 'shutter' ? clone(t.arm) : null,
        metalness: name === 'corrugated' || name === 'shutter' ? 1 : 0,
        roughness: 1, vertexColors: true, aoMapIntensity: 0.7,
      });
      this.walls[name] = this.weather(m, name);
    });
  }

  /** Shared facade weathering: splash dirt at street level, large-scale tint drift, vertical streaks. */
  weather(m, key) {
    return inject(m, {
      key: `weather-${key}`,
      uniforms: { uNoise: this.noiseUniform },
      fragPars: NOISE_PARS,
      after: {
        map_fragment: /* glsl */ `
          {
            float base = 1.0 - smoothstep(0.0, 1.6, vWPos.y);
            float n = texture2D(uNoise, vec2(vWPos.x + vWPos.z, vWPos.y) * 0.04).b;
            float streak = texture2D(uNoise, vec2((vWPos.x - vWPos.z) * 0.35, vWPos.y * 0.015)).a;
            diffuseColor.rgb *= mix(1.0, 0.72, base * 0.75) * mix(0.9, 1.06, n) * mix(1.0, 0.86, smoothstep(0.55, 0.85, streak));
          }
        `,
      },
    });
  }

  #misc() {
    const W = (props) => new THREE.MeshStandardMaterial(props);
    this.galvanized = W({ color: 0x8d9193, metalness: 0.85, roughness: 0.48 });
    this.paintedMetal = W({ color: 0x7c8084, metalness: 0.55, roughness: 0.5 });
    this.darkMetal = W({ color: 0x1c1d1f, metalness: 0.6, roughness: 0.45 });
    this.blackPlastic = W({ color: 0x101112, metalness: 0.0, roughness: 0.55 });
    this.aluminium = W({ color: 0xb4b8bc, metalness: 0.9, roughness: 0.35 });
    this.wire = W({ color: 0x141414, metalness: 0.2, roughness: 0.6 });
    this.concreteSmooth = this.weather(W({ color: 0xb9b5ad, roughness: 0.88, metalness: 0, vertexColors: true }), 'concreteSmooth');
    this.trim = this.weather(W({ color: 0xffffff, roughness: 0.7, metalness: 0, vertexColors: true }), 'trim');
    this.fabric = W({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true, side: THREE.DoubleSide });
    this.rubberMat = W({ color: 0x0c0c0c, roughness: 0.9 });
  }
}
