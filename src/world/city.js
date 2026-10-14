import { Materials } from './materials.js';
import { Roads } from './roads.js';
import { SignAtlas } from './signs.js';
import { createWindowMaterial } from './windows.js';
import { BuildingFactory, buildMeshes } from './buildings.js';
import { planCity } from './cityPlan.js';
import { Props } from './props.js';
import { Vegetation } from './vegetation.js';
import { Skyline } from './skyline.js';

/** Builds the whole static city and registers its colliders. */
export class City {
  constructor(scene, assets, physics, renderer) {
    this.scene = scene;
    this.assets = assets;
    this.physics = physics;
    this.renderer = renderer;
    this.updatables = [];
  }

  async build(status) {
    status('Materials');
    this.materials = new Materials(this.assets, this.renderer);
    await this.materials.init();
    this.materials.windowGlass = createWindowMaterial(this.materials.noise);

    status('Streets');
    this.roads = new Roads(this.scene, this.materials);
    this.roads.build();
    for (const g of this.roads.colliders) this.physics.trimesh(g);

    status('Buildings');
    this.signs = new SignAtlas(this.assets.maxAnisotropy);
    this.plan = planCity();
    this.factory = new BuildingFactory(this.materials, this.signs);
    this.buildings = buildMeshes(this.factory, this.plan.specs, this.scene, this.physics);

    status('Skyline');
    this.skyline = new Skyline(this.scene, this.materials);
    this.skyline.build();

    status('Street furniture');
    this.props = new Props(this.scene, this.assets, this.materials, this.signs, this.physics, this.plan);
    await this.props.build();
    this.updatables.push(this.props);

    status('Trees');
    this.vegetation = new Vegetation(this.scene, this.assets, this.materials, this.physics, this.plan, this.renderer);
    await this.vegetation.build();
    this.updatables.push(this.vegetation);
  }

  update(dt, camera) {
    for (const u of this.updatables) u.update(dt, camera);
  }
}
