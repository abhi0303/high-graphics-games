import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { ASSET_ROOT } from '../config.js';

/**
 * Central asset loader with caching and progress reporting.
 * All paths are relative to public/assets.
 */
export class Assets {
  constructor(renderer, onProgress) {
    this.renderer = renderer;
    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    this.manager = new THREE.LoadingManager();
    this.manager.onProgress = (url, loaded, total) => onProgress?.(loaded / total, url);

    // Explicit decoder path: three's default import.meta.url lookup breaks under Vite's dep pre-bundling.
    const draco = new DRACOLoader(this.manager);
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    this.gltfLoader = new GLTFLoader(this.manager).setDRACOLoader(draco);
    this.textureLoader = new THREE.TextureLoader(this.manager);
    this.hdrLoader = new HDRLoader(this.manager);

    this.cache = new Map();
  }

  #cached(key, make) {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key);
  }

  texture(path, { srgb = false, repeat = true, anisotropy = true } = {}) {
    return this.#cached(`tex:${path}:${srgb}`, () =>
      this.textureLoader.loadAsync(ASSET_ROOT + path).then((t) => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
        if (anisotropy) t.anisotropy = this.maxAnisotropy;
        return t;
      }),
    );
  }

  /** Poly Haven style PBR set: { map, normalMap, arm } (arm = AO / roughness / metalness packed). */
  async pbr(id, res = '1k') {
    const base = `textures/${id}/${id}_`;
    const [map, normalMap, arm] = await Promise.all([
      this.texture(`${base}diff_${res}.jpg`, { srgb: true }),
      this.texture(`${base}nor_gl_${res}.jpg`),
      this.texture(`${base}arm_${res}.jpg`),
    ]);
    return { map, normalMap, arm };
  }

  gltf(path) {
    return this.#cached(`gltf:${path}`, () => this.gltfLoader.loadAsync(ASSET_ROOT + path));
  }

  hdr(path) {
    return this.#cached(`hdr:${path}`, () => this.hdrLoader.loadAsync(ASSET_ROOT + path));
  }
}
