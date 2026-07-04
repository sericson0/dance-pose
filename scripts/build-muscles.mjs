// Build public/models/muscles.glb from the AnatomyTOOL "Upper limb" / "Lower
// limb" BodyParts3D models (CC-BY-SA — see public/models/ATTRIBUTION.md).
//
// Those source GLBs carry ~450 parts each (bones, arteries, nerves, ligaments,
// bursae, …). We keep only the curated main-mover muscles (the ones
// classifyMuscle in src/skeletonMesh.js routes to a joint), drop everything
// else, flatten to a single simple material (the app recolors muscles at
// runtime), merge both limbs into one scene, and Draco-compress the result.
//
// The output shares the atlas coordinate frame with public/models/skeleton.glb,
// so the app bakes these muscles into its joint rig using the *skeleton's*
// atlas scale (see Figure.#buildMeshMuscles).
//
// Usage:  node scripts/build-muscles.mjs [sourceDir] [outFile]
//   sourceDir defaults to "Skeleton and Muscle Models" and must contain
//   lower-limb.glb and upper-limb.glb (extract them from the *-glb.zip files).
//
// Requires (install once, not committed to package.json):
//   npm install --no-save @gltf-transform/core @gltf-transform/extensions \
//     @gltf-transform/functions draco3dgltf

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, draco, weld, mergeDocuments } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { classifyMuscle } from '../src/skeletonMesh.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const srcDir = process.argv[2] || path.join(root, 'Skeleton and Muscle Models');
const outFile = process.argv[3] || path.join(root, 'public', 'models', 'muscles.glb');

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

// Keep only classified muscle meshes; detach every other mesh so prune() can
// reclaim it. Returns how many muscle meshes survived.
function keepMusclesOnly(doc) {
  let kept = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (classifyMuscle(node.getName())) kept++;
    else node.setMesh(null);
  }
  return kept;
}

async function loadTrimmed(file) {
  const doc = await io.read(file);
  const kept = keepMusclesOnly(doc);
  console.log(`  ${path.basename(file)}: kept ${kept} muscle meshes`);
  return { doc, kept };
}

const lower = await loadTrimmed(path.join(srcDir, 'lower-limb.glb'));
const upper = await loadTrimmed(path.join(srcDir, 'upper-limb.glb'));

// Merge upper into lower, then pull every scene's roots under one scene so the
// runtime's single gltf.scene traversal sees all muscles.
const out = lower.doc;
mergeDocuments(out, upper.doc);
const scenes = out.getRoot().listScenes();
const mainScene = out.getRoot().getDefaultScene() || scenes[0];
for (const scene of scenes) {
  if (scene === mainScene) continue;
  for (const child of scene.listChildren()) mainScene.addChild(child);
  scene.dispose();
}
out.getRoot().setDefaultScene(mainScene);

// Flatten to one plain material — the app overrides muscle materials anyway, and
// this sheds the source models' clearcoat/transmission/specular extensions.
const flat = out.createMaterial('muscle').setBaseColorFactor([0.72, 0.28, 0.24, 1]);
for (const mesh of out.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) prim.setMaterial(flat);
}

await out.transform(
  prune(),
  dedup(),
  weld(),
  draco(),
);

// mergeDocuments left one buffer per source; a GLB allows only one, so route
// every accessor to the first buffer and drop the rest.
const buffers = out.getRoot().listBuffers();
for (const acc of out.getRoot().listAccessors()) acc.setBuffer(buffers[0]);
for (const b of buffers.slice(1)) b.dispose();

await io.write(outFile, out);
console.log(`\nWrote ${outFile}  (${lower.kept + upper.kept} muscles total)`);
