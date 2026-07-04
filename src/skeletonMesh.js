import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Imported anatomical skeleton (Open3DModel / BodyParts3D, CC-BY-SA — see
// public/models/ATTRIBUTION.md). The GLB carries 144 individually-named bones
// baked in one shared world frame (right-side + axial only; the left side is
// mirrored at bake time). We do NOT use its rig — instead each bone is routed
// to one of our own joint nodes so it poses with the existing skeleton.

// Joint bases that exist per-side as `${base}_L` / `${base}_R`.
export const LIMB_BASES = new Set(['hip', 'knee', 'ankle', 'toes', 'shoulder', 'elbow', 'wrist']);

// Alphanumeric-only lowercasing so matching survives GLTFLoader's node-name
// sanitization ("1st metacarpal bone.r" → "1st_metacarpal_boner").
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Map a bone's atlas name → the joint node it should hang from. Returns
// { node, material } or null to skip. `node` is a limb base (resolved to
// _L/_R by the figure) or a concrete central node (head/neck/chest/spine/pelvis).
export function classifyBone(rawName) {
  const n = norm(rawName);
  const has = (...keys) => keys.some((k) => n.includes(k));
  const material = n.startsWith('costalcart') ? 'cartilage' : 'bone';

  // Skull + teeth + jaw all ride the head (our neck→head is the only skull joint).
  const isTooth = has('incisor', 'canine', 'molar', 'premolar', 'tooth');
  const skull = ['frontal', 'parietal', 'occipital', 'temporal', 'sphenoid', 'ethmoid',
    'vomer', 'nasal', 'maxilla', 'zygomatic', 'lacrimal', 'palatine', 'mandible'];
  if (isTooth || has(...skull)) return { node: 'head', material };

  if (has('cervicalvertebrae', 'atlasc1', 'axisc2')) return { node: 'neck', material };
  if (has('lumbarvertebrae')) return { node: 'spine', material };
  if (has('thoracicvertebrae', 'rib', 'sternum', 'scapula', 'clavicle', 'costalcart')) {
    return { node: 'chest', material };
  }
  if (has('sacrum', 'coccyx', 'hipbone')) return { node: 'pelvis', material };

  if (has('femur')) return { node: 'hip', material };
  if (has('tibia', 'fibula', 'patella')) return { node: 'knee', material };
  // Foot phalanges hang from the toes (MTP) joint; everything mid-foot and
  // proximal (tarsals, metatarsals) rides the ankle. Check foot before hand.
  if (has('fingeroffoot')) return { node: 'toes', material };
  if (has('talus', 'calcaneus', 'navicular', 'cuboid', 'cuneiform', 'metatarsal',
    'sesamoidbonesoffoot')) {
    return { node: 'ankle', material };
  }

  if (has('humerus')) return { node: 'shoulder', material };
  if (has('radius', 'ulna')) return { node: 'elbow', material };
  // Carpals, metacarpals, and hand phalanges follow the wrist.
  if (has('metacarpal', 'scaphoid', 'lunate', 'triquetrum', 'pisiform', 'trapezium',
    'trapezoid', 'capitate', 'hamate', 'sesamoidbonesofhand')
    || (n.includes('phalanx') && n.includes('finger'))) {
    return { node: 'wrist', material };
  }
  return null;
}

// Load the GLB and return per-bone atlas-space geometry plus the atlas extents,
// ready for the figure to scale/mirror/attach. Geometry is stripped to
// position+normal so the pieces merge cleanly under a single bone material.
export async function loadSkeletonBones(url) {
  // The GLB is Draco-compressed; the decoder is self-hosted under public/draco
  // (copied from three's addons) so the tool stays offline-friendly.
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const gltf = await loader.loadAsync(url);
  draco.dispose();
  gltf.scene.updateMatrixWorld(true);
  const bones = [];
  const box = new THREE.Box3();
  // The file carries only right-side + axial bones, grouped under "Bones"
  // (axial, already complete) vs "Bones_right"/"Cartilages_right" (need
  // mirroring to build the left side). Group membership is the reliable side
  // signal — the sanitized ".r" name suffix is not.
  const isRightGroup = (o) => {
    for (let p = o.parent; p; p = p.parent) if (/right/i.test(p.name || '')) return true;
    return false;
  };
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const cls = classifyBone(o.name);
    if (!cls) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld); // bake into the shared atlas frame
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    g.computeBoundingBox();
    box.union(g.boundingBox);
    bones.push({
      name: o.name,
      node: cls.node,
      material: cls.material,
      paired: isRightGroup(o), // right-side bone → also mirror to the left
      geometry: g,
    });
  });
  gltf.scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  return { bones, atlasMinY: box.min.y, atlasHeight: box.max.y - box.min.y };
}

// Flip triangle winding in place (used after a mirror scale so faces stay
// outward). Assumes an indexed geometry, as GLTF exports are.
export function reverseWinding(geometry) {
  const idx = geometry.index;
  if (!idx) return;
  const a = idx.array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t;
  }
  idx.needsUpdate = true;
}
