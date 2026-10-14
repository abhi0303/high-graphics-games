# Asset attribution

## Car

- **Ferrari 458 Italia** by [vicent091036](https://sketchfab.com/vicent091036) on Sketchfab
  (<https://skfb.ly/6Rwr8>), licensed **CC BY 4.0**, used via the redistributed copy in the
  [three.js examples](https://github.com/mrdoob/three.js/tree/r176/examples/models/gltf)
  (`ferrari.glb`, `ferrari_ao.png`). Its materials are re-authored at runtime in `src/vehicle/car.js`.
  Check the Sketchfab page for the licence terms before any commercial use.

## Traffic vehicles (CC BY 4.0, via the Objaverse snapshot of Sketchfab)

Downloaded from the [Objaverse](https://huggingface.co/datasets/allenai/objaverse) dataset and
standardised with `tools/process_vehicle.py`, which does the following:

- reorientation and rescaling to real-world size;
- splitting out the wheels;
- decimation and texture downscaling;
- LOD generation;
- recolouring of the paint material at runtime.

These are modified versions of the originals. Some models depict real car makes, whose names and
badges are trademarks of their owners.

| File | Model | Author | Licence | Source |
| --- | --- | --- | --- | --- |
| bus_4ef317 | Public Bus Transportation Vehicle City Transit | N Skeba | CC BY | https://sketchfab.com/3d-models/4ef3179268ee4de8bf12e9f4905bbde9 |
| bus_1d3201 | Marcopolo Gran Viale | FrankFkN | CC BY | https://sketchfab.com/3d-models/1d32015c67f8404e8f0d92ddbebf9574 |
| bus_fc497f | Bus | Mentalist | CC BY | https://sketchfab.com/3d-models/fc497f8e331a4a82895a2d8ee62a8ef8 |
| sedan_331a59 | Cadillac CT6 3D Model | IPfuentes | CC BY | https://sketchfab.com/3d-models/331a5931230440078a0cc4e42901f7d7 |
| sedan_4b468d | Mercedes-Benz E-class W124 (unfinished) | OverLord | CC BY | https://sketchfab.com/3d-models/4b468dbe4b6d4ca994bc7066b90781e2 |
| sedan_4db0bc | SAAB 9-5 blue sedan of 1997-2001 | blendffnike | CC BY | https://sketchfab.com/3d-models/4db0bcbc183a452eb3ef692cce2fe36f |
| sedan_55aa80 | Chevrolet Malibu Premier 2022 | Type_S | CC BY | https://sketchfab.com/3d-models/55aa80115ee04aa79c802f3baf454326 |
| sedan_26b14a | Nissan Sylphy ev 2018 | Davidson | CC BY | https://sketchfab.com/3d-models/26b14a10024e4a3ca5f27af75b0d6d88 |
| hatchback_9482f2 | Mercedes-Benz A45 AMG 2018 | Lexyc16 | CC BY | https://sketchfab.com/3d-models/9482f251f9c34a6e91d7777db5934cfc |
| taxi_d4c035 | 2008 Baird Silver Coronet Taxicab | Andrew Duong | CC BY | https://sketchfab.com/3d-models/d4c035d5857f4b49baf2ee27f7051a16 |
| suv_f541e4 | Chevy Suburban 2015 (Secret Service) | David_Holiday | CC BY | https://sketchfab.com/3d-models/f541e4f42e9144b2adfcc6cb2eb645dd |
| suv_0ca035 | Mazda CX-5 | tnnv | CC BY | https://sketchfab.com/3d-models/0ca0354c7b2a41bbb84c835ff046e8e5 |
| suv_d08204 | Range Rover Sport (2018) | Weitstern | CC BY | https://sketchfab.com/3d-models/d0820434bec045a2b141a4e1f71d192e |
| van_f69de1 | Mercedes Benz Sprinter 2006 | Max | CC BY | https://sketchfab.com/3d-models/f69de1315bb049c8946d57f6006acd73 |

## Player character and animation

- **Character:** *Male_Adult_05* from the [Microsoft Rocketbox Avatar Library](https://github.com/microsoft/Microsoft-Rocketbox)
  (MIT License, Copyright (c) 2020 Microsoft). It was converted by `tools/build_character.py`:
  - materials were re-authored, with specular maps turned into roughness;
  - only the blink blendshapes were kept;
  - the result was exported as `public/assets/models/character/character.glb`.
- **Motion capture (Rocketbox):** idle, walk, run, sit idle, sit down and stand up clips from the
  same repository's `Assets/Animations` (MIT). They were retargeted, and the root travel was removed
  from the cycles.
- **Motion capture (CMU):** standing hop (91_43 "jump small forward"), running leap and falling
  (127_25 "run jump over"), kneel (23_03) and boxing (13_17, 14_01) from the
  [CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu), using the cgspeed BVH
  conversion (via the [una-dinosauria/cmu-mocap](https://github.com/una-dinosauria/cmu-mocap)
  mirror). It is free for research and commercial use. *The data used in this project was obtained
  from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.* The clips were
  retargeted, trimmed and loop-closed, and fists were added for boxing.

## Poly Haven (CC0, public domain): <https://polyhaven.com>

HDRIs:
- [kloofendal_43d_clear_puresky](https://polyhaven.com/a/kloofendal_43d_clear_puresky) (default sky)
- [kloofendal_48d_partly_cloudy_puresky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) (`?sky=` alternative)

Textures (diffuse, OpenGL normal, AO/roughness/metal):
asphalt_02, asphalt_01, concrete_floor_worn_001, brushed_concrete, concrete_wall_008, beige_wall_001,
painted_plaster_wall, white_stucco, yellow_plaster, red_brick_03, large_red_bricks, whitewashed_brick,
exterior_wall_cladding, corrugated_iron_02, painted_metal_shutter, rectangular_facade_tiles,
concrete_tile_facade, bitumen. The utility-pole wood texture comes from modular_electricity_poles.

Models, decimated with Blender by `npm run process-assets`:
island_tree_01 (trees and bushes), utility_box_01, utility_box_02, exterior_aircon_unit,
water_manhole_cover, shrub_01, shrub_04, trashbag, fire_hydrant, concrete_road_barrier, old_tyre,
barrel_03, wooden_crate_02, plastic_crate_01, cardboard_box_01.

## Original / procedural (this project)

Generated in code at load time:

- road network, sidewalks, curbs, markings and the wear map
- every building, window interior and rooftop
- traffic signals, street lights, wooden utility poles and wires, the billboard and pole-sign
  structures, chain-link fence, bins, benches and litter
- fan palms, the skyline towers and their facade textures, the freeway, hills, clouds and haze
- the signage atlas, which uses fictional names only
- the cabin's tachometer face, the rear-view mirror rendering and the hinged driver's door, which is
  split from the Ferrari model at load time

The asset-processing scripts in `tools/` and `scripts/` are part of this project.
