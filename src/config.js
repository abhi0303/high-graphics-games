// Global tunables. Quality can be forced with ?quality=ultra|high|medium.
const params = new URLSearchParams(location.search);

const PRESETS = {
  ultra: { pixelRatio: 2, shadowMapSize: 4096, shadowRadius: 2.5, msaa: 4, ao: true, aoHalfRes: false, treeLodDistance: 45 },
  high: { pixelRatio: 1.5, shadowMapSize: 4096, shadowRadius: 2.5, msaa: 4, ao: true, aoHalfRes: true, treeLodDistance: 38 },
  medium: { pixelRatio: 1, shadowMapSize: 2048, shadowRadius: 2, msaa: 2, ao: true, aoHalfRes: true, treeLodDistance: 28 },
};

const qualityName = params.get('quality') ?? 'high';

export const CONFIG = {
  qualityName,
  quality: PRESETS[qualityName] ?? PRESETS.high,
  /** Screenshot / automated capture mode: hides HUD, freezes camera on the reference composition. */
  capture: params.has('capture'),
  /** Optional named camera preset for capture mode (see CameraRig.PRESETS). */
  view: params.get('view') ?? 'reference',
  hdri: params.get('sky') ?? 'kloofendal_43d_clear_puresky_4k',
  debug: params.has('debug'),
  /** Number of AI vehicles (0 disables traffic). */
  traffic: params.has('traffic') ? Number(params.get('traffic')) : 28,
  physicsHz: 120,
};

export const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/`;
