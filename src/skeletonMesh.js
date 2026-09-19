import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Imported anatomical skeleton (Open3DModel / BodyParts3D, CC-BY-SA — see
// public/models/ATTRIBUTION.md). The GLB carries 144 individually-named bones
// baked in one shared world frame (right-side + axial only; the left side is
// mirrored at bake time). We do NOT use its rig — instead each bone is routed
// to one of our own joint nodes so it poses with the existing skeleton.

// Joint bases that exist per-side as `${base}_L` / `${base}_R`.
export const LIMB_BASES = new Set(['hip', 'knee', 'ankle', 'toes', 'scapula', 'shoulder', 'elbow', 'wrist']);

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
  // Shoulder-girdle bones ride the scapula node (a limb base, resolved per-side)
  // so they move when the scapula is articulated; the rest of the thorax rides
  // the chest. Check girdle before the thoracic group.
  if (has('scapula', 'clavicle')) return { node: 'scapula', material };
  if (has('thoracicvertebrae', 'rib', 'sternum', 'costalcart')) {
    return { node: 'chest', material };
  }
  if (has('sacrum', 'coccyx', 'hipbone')) return { node: 'pelvis', material };

  // The patella rides the FEMUR, not the shin. It is a sesamoid in the
  // quadriceps tendon that glides in the femoral trochlear groove, so it stays
  // with the thigh as the knee bends — it does NOT swing round with the tibia.
  // Grouped with tibia/fibula it slid ~1.8 cm off the distal femur and turned
  // ~22° inside the femur's own frame through knee flexion, which is what made
  // the knee cap visibly slide in the hip-flexion clip (that row drives the
  // knee to 110° alongside the hip). Measured by scripts/dev-verify-knee.mjs.
  if (has('femur', 'patella')) return { node: 'hip', material };
  if (has('tibia', 'fibula')) return { node: 'knee', material };
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
// joint node it *rides* (its primary/anchor bone): thigh muscles the hip, shank
// muscles the knee, upper-arm the shoulder, forearm the elbow, and the
// shoulder-girdle / rotator-cuff / trunk muscles the chest. Names are the
// "whole" belly, not the part/head decompositions the atlas also carries.
const MUSCLE_NODE = new Map(Object.entries({
  // Thigh + hip → hip.
  hip: [
    // Long tendons of the thigh, shipped for the same reason as the Achilles:
    // the quadriceps bellies stop 5-7 cm ABOVE the knee joint line (and 2-4 cm
    // above the top of the patella), so without the quadriceps/patellar unit
    // there is nothing spanning the knee and the group had to be stretched
    // across the gap to reach the shin.
    'Quadriceps common tendon and patellar ligament.r',
    'Common tendon of biceps femoris.r', 'Semimembranosus muscle tendon.r',
    'Pes anserinus common tendon.r',
    'Rectus femoris.r', 'Vastus lateralis muscle.r', 'Vastus medialis muscle.r',
    'Vastus intermedius muscle.r', 'Sartorius muscle.r', 'Gracilis muscle.r',
    'Adductor longus.r', 'Adductor brevis.r', 'Adductor magnus.r', 'Pectineus muscle.r',
    'Gluteus maximus muscle.r', 'Gluteus medius muscle.r', 'Gluteus minimus muscle.r',
    'Iliacus muscle.r', 'Psoas major.r', 'Piriformis muscle.r',
    'Long head of biceps femoris.r', 'Short head of biceps femoris.r',
    'Semitendinosus muscle.r', 'Semimembranosus muscle.r',
    // Gastrocnemius originates on the FEMORAL CONDYLES, so it rides the femur
    // and crosses the KNEE — the joint it was previously not modelled across at
    // all. It sat on `knee` (the tibia) with an ankle insert, which welded its
    // femoral head to the shin: measured, that origin slid 108 mm off the
    // condyles at 145° of flexion and 80 mm at only 90°, so it was wrong in
    // every bent-knee tango pose, not just the clip. Two nodes cannot express a
    // two-joint muscle, but they no longer have to: the CALCANEAL TENDON is now
    // shipped and spans the ankle, which is exactly the division of labour the
    // real unit has.
    'Lateral head of gastrocnemius.r', 'Medial head of gastrocnemius.r',
  ],
  // Shank + foot movers → knee (holds the tibia/fibula).
  knee: [
    // The Achilles. Without it the calf ended ~13 cm short of the ankle pivot,
    // which is both a visible bare-bone gap down the back of the shin and the
    // reason the triceps surae had no tissue on the far side of the joint to
    // anchor with. A tendon is the part of the unit that actually crosses, so
    // shipping it is what lets the belly stay put and the TENDON do the moving.
    'Calcaneal tendon.r',
    'Soleus muscle.r',
    'Tibialis anterior muscle.r', 'Tibialis posterior muscle.r',
    'Fibularis longus muscle.r', 'Fibularis brevis muscle.r',
    'Extensor digitorum longus.r', 'Extensor hallucis longus.r',
    'Flexor digitorum longus.r', 'Flexor hallucis longus.r',
  ],
  // Foot → ankle. The long toe-extensor tendons are the only part of the
  // digital chain that crosses the MTP, and a belly can only span two joints
  // here, so the MUSCLE stays knee→ankle and its TENDON rides ankle→toes. That
  // is what makes the toe clips show something moving: before, the toes rotated
  // 70° inside tendons that stopped dead at the ankle.
  ankle: [
    'Extensor digitorum longus tendons.r',
  ],
  // Upper arm → shoulder.
  shoulder: [
    'Common tendon of biceps brachii.r', 'Common tendon of triceps brachii.r',
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
  // Trunk-anchored arm muscles → chest. Only the two that really do originate
  // on the axial skeleton: pectoralis major (sternum, clavicle, ribs) and
  // latissimus dorsi (thoracolumbar fascia, spine, iliac crest).
  chest: [
    'Pectoralis major.r', 'Latissimus dorsi.r',
  ],
  // Shoulder girdle sheets + rotator cuff → the SCAPULA. Every one of these
  // attaches to the shoulder blade, and `scapula_L/R` is a real rig joint that
  // four movement clips drive — but they all used to ride `chest`, so the blade
  // slid out from under motionless muscle and the girdle clips animated none of
  // the prime movers their own callouts name (measured: 0.0 mm world motion for
  // all five sheets, 44-83 mm of cuff detachment at only ±25° of scapular
  // travel). The sheets insert toward `chest` (their axial origin), the cuff
  // toward `shoulder` (its humeral insertion) — see MUSCLE_INSERT.
  scapula: [
    'Trapezius muscle.r', 'Serratus anterior muscle.r', 'Pectoralis minor muscle.r',
    'Rhomboid major muscle.r', 'Rhomboid minor muscle.r',
    'Supraspinatus muscle.r', 'Infraspinatus muscle.r',
    'Teres major muscle.r', 'Teres minor muscle.r', 'Subscapularis muscle.r',
  ],
  // Abdominal wall (from muscles-thorax-abdomen.glb, same atlas) → the PELVIS
  // node, their caudal attachment (iliac crest / pubis). They skin up to the
  // chest (their rib attachment) and shear along the whole lumbar span, so a
  // chest-vs-pelvis twist (tango dissociation) stretches them — see
  // TRUNK_SHEETS + the `spread` skinning path in figure.js. Each ".r" belly is a
  // right half (split at the linea alba) and mirrors to the left.
  pelvis: [
    'Rectus abdominal muscle.r', 'External abdominal oblique muscle.r',
    'Internal abdominal oblique muscle.r',
  ],
}).flatMap(([node, names]) => names.map((name) => [norm(name), node])));

// Broad trunk sheets: the abdominal wall bellies span the whole lumbar region
// (pelvis → chest) instead of lying on one bone and crossing at a tendon, so
// they get the full-length `spread` skin in figure.js (progressive shear top to
// bottom) rather than the limb muscles' single-joint split. Trunk axial rotation
// happens almost entirely at the thoracic (chest) joint, so anchoring the caudal
// end to the pelvis is what lets a dissociation twist actually stretch them.
// They still highlight with the Torso part (`ride: 'spine'`), not the pelvis.
const TRUNK_SHEETS = new Set([
  'Rectus abdominal muscle.r', 'External abdominal oblique muscle.r',
  'Internal abdominal oblique muscle.r',
].map(norm));

// Girdle sheets now RIDE the scapula (so the blade carries them), but they are
// back/chest-wall muscles and must keep highlighting with the Torso part. Without
// this they would follow their node into `arm_L`/`arm_R` (PART_OF_NODE maps
// scapula_* to the arm), so "Highlight torso" would lose the trapezius and
// "Highlight left arm" would light the whole upper back. The rotator cuff is
// deliberately NOT here: it is a shoulder muscle and belongs with the arm.
const GIRDLE_SHEETS = new Set([
  'Trapezius muscle.r', 'Serratus anterior muscle.r', 'Pectoralis minor muscle.r',
  'Rhomboid major muscle.r', 'Rhomboid minor muscle.r',
].map(norm));

// A muscle crosses one (or two) joints, so it deforms as those joints move:
// vertices near the primary (`node`) attachment follow that bone, vertices near
// the far attachment follow the `insert` bone, and the belly stretches/bends
// between them (two-bone skinning in figure.js). This table names the *far*
// attachment for every belly whose other end lands on a bone our rig
// articulates; muscles omitted here are treated as effectively single-bone and
// stay rigid on `node`. `insert` bases resolve per-side to match the muscle.
const MUSCLE_INSERT = new Map(Object.entries({
  // Thigh muscles reaching the shank (quadriceps, sartorius, gracilis,
  // hamstrings) → they follow the knee at their distal end.
  knee: [
    // The thigh's long tendons cross the knee to the tibia, which is exactly
    // what their bellies do not reach.
    'Quadriceps common tendon and patellar ligament.r',
    'Common tendon of biceps femoris.r', 'Semimembranosus muscle tendon.r',
    'Pes anserinus common tendon.r',
    'Rectus femoris.r', 'Vastus lateralis muscle.r', 'Vastus medialis muscle.r',
    'Vastus intermedius muscle.r', 'Sartorius muscle.r', 'Gracilis muscle.r',
    'Long head of biceps femoris.r', 'Short head of biceps femoris.r',
    'Semitendinosus muscle.r', 'Semimembranosus muscle.r',
    // Gastrocnemius crosses the KNEE (femoral origin → shank); the Achilles
    // above carries its ankle half.
    'Lateral head of gastrocnemius.r', 'Medial head of gastrocnemius.r',
  ],
  // Hip muscles anchored to the pelvis/sacrum above the joint (adductors,
  // glutes, iliopsoas, piriformis) → their proximal end follows the pelvis.
  pelvis: [
    'Adductor longus.r', 'Adductor brevis.r', 'Adductor magnus.r', 'Pectineus muscle.r',
    'Gluteus maximus muscle.r', 'Gluteus medius muscle.r', 'Gluteus minimus muscle.r',
    'Iliacus muscle.r', 'Psoas major.r', 'Piriformis muscle.r',
  ],
  // Shank muscles crossing to the foot (triceps surae + the ankle/toe movers)
  // → their distal end follows the ankle. Gastrocnemius is the classic
  // two-joint muscle: it rides the knee and inserts across the ankle.
  ankle: [
    'Calcaneal tendon.r',
    'Soleus muscle.r',
    'Tibialis anterior muscle.r', 'Tibialis posterior muscle.r',
    'Fibularis longus muscle.r', 'Fibularis brevis muscle.r',
    'Extensor digitorum longus.r', 'Extensor hallucis longus.r',
    'Flexor digitorum longus.r', 'Flexor hallucis longus.r',
  ],
  // Upper-arm muscles reaching the forearm (biceps/triceps/brachialis) → distal
  // end follows the elbow, so the biceps stretches as the elbow flexes.
  elbow: [
    'Common tendon of biceps brachii.r', 'Common tendon of triceps brachii.r',
    'Long head of biceps brachii.r', 'Short head of biceps brachii.r', 'Brachialis muscle.r',
    'Long head of triceps brachii.r', 'Lateral head of triceps brachii.r',
    'Medial head of triceps brachii.r',
  ],
  // Girdle-anchored arm muscles that ride the shoulder (deltoid, coracobrachialis)
  // → their proximal end follows the chest/scapula. Plus the abdominal wall,
  // whose upper (rib) end follows the chest so the belly stretches/shears as the
  // torso flexes or twists over the pelvis (the pelvis node it rides is the near
  // end; the twist itself lives at the chest joint).
  chest: [
    // The girdle sheets run from the blade to the axial skeleton: trapezius and
    // the rhomboids to the spine/occiput, serratus anterior and pectoralis minor
    // to the ribs. Riding `scapula` and inserting toward `chest` is what lets
    // them actually shorten when the blade elevates, protracts or retracts.
    'Trapezius muscle.r', 'Serratus anterior muscle.r', 'Pectoralis minor muscle.r',
    'Rhomboid major muscle.r', 'Rhomboid minor muscle.r',
    'Rectus abdominal muscle.r', 'External abdominal oblique muscle.r',
    'Internal abdominal oblique muscle.r',
  ],
  // Deltoid (acromion, lateral clavicle, scapular spine) and coracobrachialis
  // (coracoid process) are anchored to the BLADE, not the ribcage — they ride
  // the humerus and reach back to the scapula.
  scapula: [
    'Deltoid muscle.r', 'Coracobrachialis muscle.r',
  ],
  // Muscles crossing the glenohumeral joint from the trunk side (pectoralis
  // major, latissimus, rotator cuff, teres) plus the elbow muscles anchored on
  // the humerus (brachioradialis, anconeus) → their far end follows the shoulder.
  shoulder: [
    'Pectoralis major.r', 'Latissimus dorsi.r',
    'Supraspinatus muscle.r', 'Infraspinatus muscle.r',
    'Teres major muscle.r', 'Teres minor muscle.r', 'Subscapularis muscle.r',
    'Brachioradialis muscle.r', 'Anconeus muscle.r',
  ],
  // Forearm muscles crossing to the hand → distal end follows the wrist.
  wrist: ['Flexor carpi radialis.r', 'Extensor digitorum.r'],
  // The long toe-extensor tendons cross the MTP onto the phalanges.
  toes: ['Extensor digitorum longus tendons.r'],
}).flatMap(([node, names]) => names.map((name) => [norm(name), node])));

// Map an atlas muscle name → { node, insert? } — the joint it rides plus, for a
// belly that crosses an articulated joint, the far bone it also attaches to. Or
// null to skip (arteries, nerves, ligaments, intrinsics, and muscles we don't
// ship).
export function classifyMuscle(rawName) {
  const n = norm(rawName);
  const node = MUSCLE_NODE.get(n);
  if (!node) return null;
  const insert = MUSCLE_INSERT.get(n);
  // Trunk sheets get the full-length spread skin and highlight with the Torso
  // part even though they ride the pelvis node.
  if (TRUNK_SHEETS.has(n)) return { node, insert, spread: true, ride: 'spine' };
  if (GIRDLE_SHEETS.has(n)) return { node, insert, ride: 'spine' };
  return insert ? { node, insert } : { node };
}

// Human-readable muscle label from an atlas name. GLTFLoader sanitises the
// source names (spaces/dots → underscores, so "Gluteus maximus muscle.r" arrives
// as "Gluteus_maximus_muscler"): restore the spaces, drop the trailing side tag
// (a ".r"/".l" or a merged "r"/"l"), and drop a trailing "muscle" word →
// "Gluteus maximus". Every shipped belly is right-side, so the tail is always a
// single side letter.
export function muscleLabel(rawName) {
  return rawName
    .replace(/_/g, ' ')
    .replace(/\s*\.?\s*[rl]$/i, '')
    .replace(/\s+muscle$/i, '')
    .trim();
}

// Load a Draco-compressed GLB (the decoder is self-hosted under public/draco,
// copied from three's addons, so the tool stays offline-friendly) and return the
// parsed gltf with world matrices resolved.
async function loadDracoGLTF(url) {
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const gltf = await loader.loadAsync(url);
  draco.dispose();
  gltf.scene.updateMatrixWorld(true);
  return gltf;
}

// Clone a mesh's geometry baked into the shared atlas (world) frame and stripped
// to position + normal (computing normals if absent) so the pieces merge cleanly.
function bakeToWorld(o) {
  const g = o.geometry.clone();
  g.applyMatrix4(o.matrixWorld);
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

// Load a muscle atlas GLB and return per-muscle atlas-space geometry, ready for
// the figure to scale (with the skeleton's atlas metrics), mirror, and attach
// individually. Every shipped muscle is a right-side belly, so all are mirrored
// to build the left side.
export async function loadMuscleMeshes(url) {
  const gltf = await loadDracoGLTF(url);
  const muscles = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const cls = classifyMuscle(o.name);
    if (!cls) return;
    const g = bakeToWorld(o);
    muscles.push({
      name: o.name, label: muscleLabel(o.name),
      node: cls.node, insert: cls.insert, spread: cls.spread, ride: cls.ride,
      geometry: g,
    });
  });
  gltf.scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  return { muscles };
}

// Load the GLB and return per-bone atlas-space geometry plus the atlas extents,
// ready for the figure to scale/mirror/attach. Geometry is stripped to
// position+normal so the pieces merge cleanly under a single bone material.
export async function loadSkeletonBones(url) {
  const gltf = await loadDracoGLTF(url);
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
    const g = bakeToWorld(o);
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

// ---------------------------------------------------------------- body view
// Imported clothed body avatars (Microsoft Rocketbox, MIT — see
// public/models/ATTRIBUTION.md). Unlike the skeleton/muscle atlases these are
// *skinned* meshes on a 3ds Max Biped rig; the figure re-parents the Biped
// bones onto our joint nodes so the existing rig drives the skin directly
// (see Figure.#buildMeshBody). This table says which Biped bone snaps to
// which of our joints, and which bone/joint pair defines the direction used
// to align it. 'S' in a name is the Biped side letter (l/r), resolved to our
// _L/_R side by bind-pose world position, not by name, so a mirrored export
// still lands on the correct side.
//   dirBone/dirJoint — align the bone's bind direction to our segment
//   axial            — also stretch along the bone so it reaches the child joint
//   inherit          — reuse the alignment rotation of that bone (no own dir ref)
//   squash           — scale world-Y so the sole grazes the floor at rest
//                      (Rocketbox ankles sit higher than our rig's, and heels
//                      would otherwise sink through the floor)
export const BODY_RETARGET = [
  { bone: 'bip01pelvis', joint: 'pelvis', dirBone: 'bip01spine1', dirJoint: 'spine' },
  { bone: 'bip01', joint: 'pelvis', inherit: 'bip01pelvis' },
  { bone: 'bip01spine1', joint: 'spine', dirBone: 'bip01spine2', dirJoint: 'chest' },
  { bone: 'bip01spine2', joint: 'chest', dirBone: 'bip01neck', dirJoint: 'neck' },
  { bone: 'bip01neck', joint: 'neck', dirBone: 'bip01head', dirJoint: 'head' },
  { bone: 'bip01head', joint: 'head', inherit: 'bip01neck' },
  { bone: 'bip01Supperarm', joint: 'shoulder', dirBone: 'bip01Sforearm', dirJoint: 'elbow', axial: true },
  { bone: 'bip01Sforearm', joint: 'elbow', dirBone: 'bip01Shand', dirJoint: 'wrist', axial: true },
  { bone: 'bip01Shand', joint: 'wrist', dirBone: 'bip01Sfinger2', dirJoint: 'hand' },
  { bone: 'bip01Sthigh', joint: 'hip', dirBone: 'bip01Scalf', dirJoint: 'knee', axial: true },
  { bone: 'bip01Scalf', joint: 'knee', dirBone: 'bip01Sfoot', dirJoint: 'ankle', axial: true },
  { bone: 'bip01Sfoot', joint: 'ankle', inherit: 'bip01Scalf', squash: true },
  { bone: 'bip01Stoe0', joint: 'toes', inherit: 'bip01Sfoot', squash: true },
];
export const normBoneName = norm;

// Load a clothed body avatar GLB (skinned mesh + Biped rig, in bind pose).
// Returns the parsed scene plus its bind-pose extents; each figure clones it
// (SkeletonUtils) and retargets the bones onto its own joints.
export async function loadBodyMesh(url) {
  const gltf = await loadDracoGLTF(url);
  // Bind pose = rest scene; setFromObject applies each mesh node's transform
  // (FBX2glTF keeps the vertex buffers Z-up behind a rotated mesh node, so raw
  // geometry bounds would measure the wrong axis).
  const box = new THREE.Box3().setFromObject(gltf.scene);
  gltf.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const mat = o.material;
    if (mat && mat.transparent) {
      // Hair cards / lashes: don't write depth (halo artifacts) and don't
      // cast card-shaped solid shadows.
      mat.depthWrite = false;
      o.castShadow = false;
    }
  });
  return { scene: gltf.scene, minY: box.min.y, height: box.max.y - box.min.y };
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
