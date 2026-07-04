# Skeleton & muscle model attribution

`skeleton.glb` is the "Overview skeleton" model from **Open3DModel / AnatomyTOOL**
(https://anatomytool.org/open3dmodel-create), itself derived from the
**BodyParts3D** dataset, © The Database Center for Life Science (DBCLS).

`muscles.glb` is built from the "Upper limb" and "Lower limb" models of the same
**Open3DModel / AnatomyTOOL** collection (https://anatomytool.org/open3dmodel),
also derived from **BodyParts3D**, © DBCLS. It is a derivative: only a curated
set of main-mover muscle bellies is kept, materials are flattened, and the two
limbs are merged and re-compressed (see `scripts/build-muscles.mjs`).

**License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0).**

Because these assets are CC BY-SA, any distribution of this project that includes
them must (a) credit the sources above and (b) be shared under CC BY-SA 4.0 (or a
compatible license). The models are provided "as is"; anatomical correctness is
not guaranteed.

The meshes are used as the skeleton / muscle *views* only. TAngle re-parents each
named bone and muscle onto its own joint rig at load time (see
`src/skeletonMesh.js`); the models' own (absent) rigs are not used.
