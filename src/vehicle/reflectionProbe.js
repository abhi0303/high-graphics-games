import * as THREE from 'three';

export const PROBE_LAYER = 1;

/**
 * Dynamic local reflection probe for the player car. A cube camera renders
 * only objects on PROBE_LAYER (buildings, skyline, ground, signals, sky) at
 * low resolution; three converts the cube to a PMREM on demand
 * (needsPMREMUpdate) so rough and glossy materials both get correct blur.
 */
export class ReflectionProbe {
  constructor(renderer, scene, size = 256) {
    this.renderer = renderer;
    this.scene = scene;
    this.target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.camera = new THREE.CubeCamera(0.4, 3000, this.target);
    this.camera.layers.set(PROBE_LAYER);
    this.texture = this.target.texture;
    this.frame = 0;
    this.lastPos = new THREE.Vector3(Infinity, 0, 0);
  }

  /** Mark an object tree as visible to the probe. */
  static include(object) {
    object.traverse((o) => o.layers.enable(PROBE_LAYER));
  }

  /** Re-render the probe every `every` frames while the car moves; returns true if it rendered. */
  update(position, hide, every = 3) {
    this.frame++;
    const moved = this.lastPos.distanceToSquared(position) > 0.04;
    if (!moved || this.frame % every !== 0) return false;
    this.lastPos.copy(position);
    const r = this.renderer;
    const autoShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    hide.visible = false;
    this.camera.position.copy(position);
    this.camera.update(r, this.scene);
    hide.visible = true;
    r.shadowMap.autoUpdate = autoShadow;
    this.texture.needsPMREMUpdate = true;
    return true;
  }
}
