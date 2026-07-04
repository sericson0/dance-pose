# Skeleton model attribution

`skeleton.glb` is the "Overview skeleton" model from **Open3DModel / AnatomyTOOL**
(https://anatomytool.org/open3dmodel-create), itself derived from the
**BodyParts3D** dataset, © The Database Center for Life Science (DBCLS).

**License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0).**

Because this asset is CC BY-SA, any distribution of this project that includes it
must (a) credit the sources above and (b) be shared under CC BY-SA 4.0 (or a
compatible license). The model is provided "as is"; anatomical correctness is not
guaranteed.

The mesh is used as the skeleton *view* only. TAngle re-parents each named bone
onto its own joint rig at load time (see `src/skeletonMesh.js`); the model's own
(absent) rig is not used.
