import * as THREE from 'three';

/**
 * Window glass with interior mapping.
 *
 * Each window quad carries uv (0..1 across the pane) and aExtra =
 * (seed, roomDepth, paneWidth, paneHeight). The fragment shader ray-casts the
 * view ray into a virtual room box behind the pane and shades floor, ceiling,
 * walls, furniture silhouettes, blinds and ceiling lights procedurally. The
 * result is added as emissive under a physically based glass surface, so
 * sky/sun reflections (IBL + Fresnel) sit on top of a room with real parallax.
 *
 * seed in [0,1): apartment/office room; seed in [2,3): lit shop interior.
 */
export function createWindowMaterial(noiseTex) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.02, 0.025, 0.03),
    roughness: 0.05,
    metalness: 0.0,
    envMapIntensity: 1.0,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: noiseTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aExtra;
        varying vec4 vRoom;
        varying vec2 vPane;
        varying vec3 vWPos;
        varying vec3 vWNormal;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vRoom = aExtra;
        vPane = uv;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uNoise;
        varying vec4 vRoom;
        varying vec2 vPane;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        float h1(float n) { return fract(sin(n * 91.345) * 43758.5453); }
        vec3 interior(out float lum) {
          float type = floor(vRoom.x);
          float s = fract(vRoom.x);
          bool shop = type > 1.5;
          float W = vRoom.z, H = vRoom.w, D = vRoom.y;
          vec3 N = normalize(vWNormal);
          vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
          vec3 V = normalize(vWPos - cameraPosition);
          vec3 rd = vec3(dot(V, T), V.y, -dot(V, N));
          rd.z = max(rd.z, 1e-3);
          float sill = shop ? 0.45 : 0.9;
          float above = shop ? 0.6 : 0.45;
          float mx = shop ? 0.5 : 0.8 + h1(s * 7.0) * 1.2;
          vec3 ro = vec3(vPane.x * W, vPane.y * H, 0.0);
          vec3 bmin = vec3(-mx, -sill, 0.0);
          vec3 bmax = vec3(W + mx, H + above, D);
          vec3 t1 = (bmin - ro) / rd;
          vec3 t2 = (bmax - ro) / rd;
          vec3 tf = max(t1, t2);
          float t = min(min(tf.x, tf.y), tf.z);
          vec3 p = ro + rd * t;
          float depthF = p.z / D;

          // palette per room
          vec3 wallC = mix(vec3(0.78, 0.74, 0.66), vec3(0.62, 0.66, 0.68), h1(s * 3.1));
          wallC = mix(wallC, vec3(0.75, 0.62, 0.5), step(0.82, h1(s * 5.3)));
          vec3 floorC = mix(vec3(0.24, 0.19, 0.15), vec3(0.32, 0.31, 0.3), h1(s * 9.7));
          vec3 ceilC = vec3(0.86);
          vec3 c;
          float lightFall = mix(1.0, 0.35, depthF);
          if (t == tf.z) {
            c = wallC * 0.85;
            // furniture / shelving silhouettes on the back wall
            float fx = p.x / (W + 2.0 * mx);
            if (shop) {
              float shelf = step(0.55, fract(p.y * 2.2)) * step(p.y, H * 0.85);
              vec3 goods = mix(vec3(0.7, 0.2, 0.15), vec3(0.2, 0.4, 0.7), h1(floor(p.x * 3.0) + s * 11.0));
              c = mix(c, goods * 0.8, shelf * 0.75);
            } else {
              float cab = step(p.y, -sill + 0.85 + h1(s * 4.0) * 0.6) * step(0.15 + h1(s * 2.2) * 0.3, fx) * step(fx, 0.55 + h1(s * 6.2) * 0.4);
              c = mix(c, vec3(0.18, 0.14, 0.11), cab * 0.85);
              float pic = step(abs(p.y - H * 0.55), 0.3) * step(abs(fx - 0.3 - h1(s) * 0.4), 0.12);
              c = mix(c, vec3(0.3, 0.35, 0.4), pic * step(0.5, h1(s * 8.0)));
            }
          } else if (t == tf.y) {
            if (rd.y > 0.0) {
              c = ceilC * 0.8;
              // ceiling light panels
              vec2 g = fract(vec2(p.x * 0.45, p.z * 0.45));
              float panel = step(0.2, g.x) * step(g.x, 0.8) * step(0.35, g.y) * step(g.y, 0.65);
              float lit = shop ? 1.0 : step(0.55, h1(s * 13.0));
              c += panel * lit * vec3(2.4, 2.3, 2.1);
            } else {
              c = floorC;
              if (shop) c = mix(vec3(0.55, 0.53, 0.5), vec3(0.4), step(0.5, fract(floor(p.x * 1.6) * 0.5 + floor(p.z * 1.6) * 0.5)));
            }
          } else {
            c = wallC * 0.7;
          }
          c *= lightFall;
          float roomLight = shop ? 0.42 : mix(0.1, 0.22, h1(s * 17.0));
          c *= roomLight;

          // blinds / curtains just behind the glass
          if (!shop) {
            float blindLvl = H * (1.0 - h1(s * 21.0) * 1.3);
            float tb = 0.06 / rd.z;
            vec3 pb = ro + rd * tb;
            if (h1(s * 23.0) > 0.35 && pb.y > blindLvl) {
              float slat = smoothstep(0.35, 0.5, fract(pb.y * 14.0));
              vec3 blindC = mix(vec3(0.82, 0.8, 0.74), vec3(0.62, 0.57, 0.48), h1(s * 29.0));
              c = blindC * mix(0.2, 0.32, slat);
            }
          }
          lum = dot(c, vec3(0.333));
          return c;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float iLum;
        vec3 roomC = interior(iLum);
        // glass grime breaks up the perfect mirror slightly
        float grime = texture2D(uNoise, vWPos.xz * 0.37 + vWPos.y * 0.21).a;
        totalEmissiveRadiance += roomC * 0.9;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.02, 0.16, smoothstep(0.45, 0.85, texture2D(uNoise, vWPos.xy * 0.3 + vWPos.z * 0.2).b));`);
  };
  m.customProgramCacheKey = () => 'window-interior';
  return m;
}
