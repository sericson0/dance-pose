# Skeleton, muscle & body model attribution

`skeleton.glb` is the "Overview skeleton" model from **Open3DModel / AnatomyTOOL**
(https://anatomytool.org/open3dmodel-create), itself derived from the
**BodyParts3D** dataset, © The Database Center for Life Science (DBCLS).

`muscles.glb` is built from the "Upper limb", "Lower limb", and "Muscles of
thorax, abdomen and back" models of the same **Open3DModel / AnatomyTOOL**
collection (https://anatomytool.org/open3dmodel), also derived from
**BodyParts3D**, © DBCLS. It is a derivative: only a curated set of main-mover
muscle bellies is kept (the trunk model contributes the abdominal wall — rectus
abdominis and the obliques), materials are flattened, and the three sources are
merged and re-compressed (see `scripts/build-muscles.mjs`).

**License (skeleton.glb, muscles.glb): Creative Commons Attribution-ShareAlike
4.0 International (CC BY-SA 4.0).**

Because these assets are CC BY-SA, any distribution of this project that includes
them must (a) credit the sources above and (b) be shared under CC BY-SA 4.0 (or a
compatible license). The models are provided "as is"; anatomical correctness is
not guaranteed.

`man.glb` and `woman.glb` (the clothed body view) are the **Microsoft Rocketbox**
avatars `Business_Male_05` and `Business_Female_04`
(https://github.com/microsoft/Microsoft-Rocketbox), © Microsoft Corporation.
They are derivatives: converted from FBX to glTF, textures downsized and
re-encoded, and Draco-compressed (see `scripts/build-body.mjs`).

**License (man.glb, woman.glb): MIT** — see the Rocketbox repository's
LICENSE.md; redistribution requires keeping the copyright notice and license
text. If used in research, Microsoft asks that the accompanying paper be cited
(Gonzalez-Franco et al., *The Rocketbox Library and the Utility of Freely
Available Rigged Avatars*, Frontiers in VR, 2020).

The meshes are used as the skeleton / muscle / body *views* only. TAngle
re-parents each named bone, muscle, and Biped rig bone onto its own joint rig at
load time (see `src/skeletonMesh.js`); the models' own rigs are not used for
posing (the body avatars' skin weights are kept, but their bones are driven by
TAngle's joints).
