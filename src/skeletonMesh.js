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

// ------------------------------------------------------------------- muscles
// The main-mover muscles come from the same BodyParts3D atlas as the skeleton
// (AnatomyTOOL "Upper limb" / "Lower limb" models, CC-BY-SA — see
// public/models/ATTRIBUTION.md), so they share the skeleton's coordinate frame
// and bake into our joint nodes with the *skeleton's* atlas scale. Only the
// right side + a curated set of surface movers are shipped (see
// scripts/build-muscles.mjs); the left side is mirrored at bake time.

// Each entry maps an atlas muscle's exact name (alphanumeric-normalized) to the
// joint node it should ride. A muscle spans two joints but attaches rigidly to
// one, matching the fallback muscle table in anatomy.js: thigh muscles ride the
// hip, shank muscles the knee, upper-arm the shoulder, forearm the elbow, and
// the shoulder-girdle / rotator-cuff / trunk muscles the chest. Names are the
// "whole" belly, not the part/head decompositions the atlas also carries.
const MUSCLE_NODE = new Map(Object.entries({
  // Thigh + hip → hip.
  hip: [
    'Rectus femoris.r', 'Vastus lateralis muscle.r', 'Vastus medialis muscle.r',
    'Vastus intermedius muscle.r', 'Sartorius muscle.r', 'Gracilis muscle.r',
    'Adductor longus.r', 'Adductor brevis.r', 'Adductor magnus.r', 'Pectineus muscle.r',
    'Gluteus maximus muscle.r', 'Gluteus medius muscle.r', 'Gluteus minimus muscle.r',
    'Iliacus muscle.r', 'Psoas major.r', 'Piriformis muscle.r',
    'Long head of biceps femoris.r', 'Short head of biceps femoris.r',
    'Semitendinosus muscle.r', 'Semimembranosus muscle.r',
  ],
  // Shank + foot movers → knee (holds the tibia/fibula).
  knee: [
    'Lateral head of gastrocnemius.r', 'Medial head of gastrocnemius.r', 'Soleus muscle.r',
    'Tibialis anterior muscle.r', 'Tibialis posterior muscle.r',
    'Fibularis longus muscle.r', 'Fibularis brevis muscle.r',
    'Extensor digitorum longus.r', 'Extensor hallucis longus.r',
    'Flexor digitorum longus.r', 'Flexor hallucis longus.r',
  ],
  // Upper arm → shoulder.
  shoulder: [
    'Deltoid muscle.r', 'Long head of biceps brachii.r', 'Short head of biceps brachii.r',
    'Brachialis muscle.r', 'Coracobrachialis muscle.r',
    'Long head of triceps brachii.r', 'Lateral head of triceps brachii.r',
    'Medial head of triceps brachii.r',
  ],
  // Forearm → elbow.
  elbow: [
    'Brachioradialis muscle.r', 'Anconeus muscle.r', 'Supinator.r', 'Pronator quadratus.r',
    'Flexor carpi radialis.r', 'Extensor digitorum.r',
  ],
  // Shoulder girdle + rotator cuff + trunk → chest.
  chest: [
    'Pectoralis major.r', 'Pectoralis minor muscle.r', 'Trapezius muscle.r',
    'Latissimus dorsi.r', 'Serratus anterior muscle.r',
    'Rhomboid major muscle.r', 'Rhomboid minor muscle.r',
    'Supraspinatus muscle.r', 'Infraspinatus muscle.r',
    'Teres major muscle.r', 'Teres minor muscle.r', 'Subscapularis muscle.r',
  ],
}).flatMap(([node, names]) => names.map((name) => [norm(name), node])));

// Map an atlas muscle name → the joint node it should hang from, or null to
// skip (arteries, nerves, ligaments, intrinsics, and muscles we don't ship).
export function classifyMuscle(rawName) {
  const node = MUSCLE_NODE.get(norm(rawName));
  return node ? { node } : null;
}

// Human-readable muscle label from an atlas name: drop the ".r"/".l" side tag
// and a trailing "muscle" word ("Gluteus maximus muscle.r" → "Gluteus maximus").
export function muscleLabel(rawName) {
  return rawName.replace(/\s*\.[rl]\s*$/i, '').replace(/\s+muscle$/i, '').trim();
}

// Load a muscle atlas GLB and return per-muscle atlas-space geometry, ready for
// the figure to scale (with the skeleton's atlas metrics), mirror, and attach
// individually. Every shipped muscle is a right-side belly, so all are mirrored
// to build the left side.
export async function loadMuscleMeshes(url) {
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const gltf = await loader.loadAsync(url);
  draco.dispose();
  gltf.scene.updateMatrixWorld(true);
  const muscles = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const cls = classifyMuscle(o.name);
    if (!cls) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    muscles.push({ name: o.name, label: muscleLabel(o.name), node: cls.node, geometry: g });
  });
  gltf.scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  return { muscles };
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
