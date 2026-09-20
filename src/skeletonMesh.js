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

// Bellies whose skin weights come from CONTACT with the two bones rather than
// from position along a bone axis (`contact` path in Figure.#addSkinnedMuscle).
//
// Gluteus maximus is the case that needs it. The axial split assigns tissue by
// its height along the FEMUR relative to the hip centre, which suits a belly
// whose fibres run down the limb — gluteus medius and minimus, iliac wing to
// trochanter, are well served by it and stay on it. Maximus is a fan running
// obliquely from the sacrum, coccyx and posterior ilium out to the femur, and
// HALF OF ITS ORIGIN LIES BELOW THE HIP JOINT'S HEIGHT. Measured by height, that
// sacral and coccygeal tissue is "distal", so it was welded to the thigh: through
// the hip-flexion clip the tissue actually touching the pelvis drifted 55 mm on
// average and 130 mm at worst off the bone, the belly peeling away from the
// sacrum and swinging forward with the leg. Weighted by contact instead — tissue
// on the pelvis follows the pelvis, tissue on the femur follows the femur, what
// lies between shears — the origin holds to 1.1 mm (3.5 max), the insertion to
// 2.0 mm (5.6 max, from 23.1), and the belly stretches no more than before
// (edge p95 x2.48 against x2.59).
//
// What this does NOT fix, so it is not mistaken for a regression: at 120° the
// belly still hangs a few cm below the ischium as a sling. Blending two rigid
// frames carries mid-belly tissue round the hip at its resting radius, where a
// real gluteus maximus is pulled taut over the ischial tuberosity. That needs a
// wrapping surface, which two-bone skinning cannot express.
//
// Two alternatives were measured and are worse — do not reach for them. The
// full-length `spread` ramp fixes maximus but needs an axis, and any axis that
// suits maximus ruins medius (origin 0 → 32 mm) and minimus (0 → 14). Biasing
// the contact ratio toward the pelvis, to keep more of the buttock on the bone,
// tears the insertion off instead (2 → 15 mm at a 0.6 exponent, 72 mm at 0.3).
//
// THE ROTATOR CUFF AND TERES MAJOR ARE HERE FOR THE MIRROR-IMAGE REASON, and it
// is worth stating separately because the failure looked nothing like maximus's
// on the numbers. They arise on the blade and insert on the humerus, so the
// table rows are right; what broke is that `#addSkinnedMuscle` measures along
// `b - a` and sizes its window as a fraction of |b - a|. When these five rode
// `chest`, that axis ran roughly DOWN the fibres (36-54°) over a 96-154 mm
// projection and worked. Moving them to `scapula` — which was correct, and fixed
// the blade sliding out from under motionless muscle — left the axis running
// ACROSS them: teres major's fibres sit 80.0° off it and subscapularis's 80.7°,
// so each belly projects onto only 34-53 mm of a 165.7 mm inter-node distance
// while the window is sized off the whole of it. The window then swallows the
// belly: 42% of teres major and 52% of subscapularis end up at mid-weight, i.e.
// committed to neither bone, and at `sh_flex`/`sh_abd` the scapula renders as
// BARE BONE while the untouched side stays clothed (measured before the switch:
// teres major 228 mm of contact tissue leaving the blade with a worst edge of
// +86 mm, subscapularis 169 mm / +38 mm).
//
// Contact weighting is the right instrument because it needs no axis at all —
// which is the whole reason it exists — and a fibre direction 80° off the
// inter-node line is exactly the case an axial split cannot express. Note the
// diagnosis did NOT come from stretch or drift, both of which read clean here
// (subscapularis x0.915..1.048): see dev-probe-muscle-anchor.mjs.
const CONTACT_SHEETS = new Set([
  'Gluteus maximus muscle.r',
  'Supraspinatus muscle.r', 'Infraspinatus muscle.r', 'Subscapularis muscle.r',
  'Teres major muscle.r', 'Teres minor muscle.r',
  'Latissimus dorsi.r',
].map(norm));

// A contact sheet whose ORIGIN spreads over more bones than the one node it
// rides. Two-bone skinning can only FOLLOW two frames, and that stays true — the
// sheet still follows `node` — but "which bone is this tissue lying on" is a
// separate question, and answering it against `node`'s bones alone misreads any
// tissue lying on a neighbour as lying on nothing.
//
// LATISSIMUS DORSI is why this exists. It rides `chest`, but it arises from the
// T7-L5 spinous processes, the thoracolumbar fascia and the iliac crest, so most
// of its origin is on `spine` and `pelvis`. Against the chest cloud alone, tissue
// on the iliac crest is ~15 cm from the ribs and — with the arm hanging — a
// similar distance from the humerus, so contact would hand a third of it to the
// arm. Pooling the three clouds puts it a few mm from "the origin" and it stays
// on the back.
//
// What contact FIXES here is the insertion. The axial split measures latissimus
// along chest→shoulder, which points UP and out, while its tendon runs DOWN the
// humerus — so the further down the shaft the insertion tissue lay, the LESS
// committed to the humerus it was: 0.94 at 50-75 mm below the joint, 0.77 at
// 75-100, 0.53 at 100-125, with 11 of 1054 vertices fully on the bone. At 170°
// of flexion 63% of the tissue touching the humerus left it by more than 20 mm
// (max 196, mean 47). The other axis is no way out — measured along the humerus,
// the lumbar origin projects further "distal" than the insertion itself and 71%
// of the sheet welds to the arm (see #addSkinnedMuscle) — which is exactly the
// bind contact weighting exists to escape: it needs no axis.
//
// `window` is the second half, and PLAIN CONTACT WITHOUT IT IS WORSE THAN THE BUG.
// Latissimus lies over other muscle (erector spinae, serratus), so most of the
// sheet stands 10-30 mm off bone; the raw ratio reads that stand-off as ~14%
// humeral, and 14% of a 170° swing is ~40 mm — the sheet went forward THROUGH
// the ribcage, ribs and lumbar vertebrae showing through it, while both END
// metrics read beautifully. [lo, hi] remaps the ratio so tissue at or below `lo`
// is wholly the trunk's and at or above `hi` wholly the humerus's. Swept, at
// 170° flexion (back sheet = the 735 verts within 40 mm of the trunk and clear
// of the humerus; insertion = the 108 touching the humerus):
//   axial split   back 0.0 mm   insertion max 196 / mean 47, 63% > 20 mm
//   [0, 1]        back THROUGH THE RIBS   insertion 10.5 / 2.0
//   [0.2, 0.95]   back max 53 mm          insertion  6.8 / 0.8   worst edge 141
//   [0.35, 0.9]   back max 0.2 mm         insertion  2.0 / 0.1   worst edge 169
//   [0.5, 0.9]    back 0.0 mm             insertion  3.8 / 0.3   worst edge 202
// 0.35 is the loosest window that still holds the back still. The worst edge is
// the axillary bridge taking the arm's whole ~25 cm of travel over a short free
// length; it renders as a continuous band up to the humerus (the posterior
// axillary fold), where the axial split left a wisp hanging in mid-air behind
// the arm. NOT fixed, and not new: in wide ABDUCTION the bridge bows ~10 cm
// lateral of the arm, because DQS carries mid-weight tissue round the shoulder
// on an arc where a taut tendon would take the chord — the same two-bone limit
// as gluteus maximus's sling. Judge any retune on the BACK SHEET and on
// screenshots, never on the end metrics alone.
const CONTACT_OPTS = new Map(Object.entries({
  'Latissimus dorsi.r': { origin: ['chest', 'spine', 'pelvis'], window: [0.35, 0.9] },
}).map(([name, opts]) => [norm(name), opts]));

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
  // Thigh units reaching the shank → they follow the knee at their distal end.
  // ONLY the long tendons are left here, and that is the whole point: a belly
  // is skinned across a joint only if it actually TOUCHES the bone on the far
  // side. Measured against the shin cluster at rest, the quadriceps bellies
  // stop 66-81 mm short of it (vastus intermedius 80.9, lateralis 69.9, rectus
  // femoris 69.1, medialis 65.6) while their common tendon reaches it at 0.7 mm.
  // Skinned to the tibia anyway, the sliding window parked their far weight
  // band on tissue nowhere near the joint and knee flexion dragged it across
  // the gap: the quadriceps group tore to x1.59..x1.75 of bind length in
  // kn_flex and x1.46..x1.65 in hp_flex (which drives the knee 110° too). That
  // is the "quad pulling off the bone" this table used to produce. The tendons
  // below touch the shin at 0.3-0.9 mm and do the crossing, which is exactly
  // the division of labour gastrocnemius/Achilles already uses.
  knee: [
    'Quadriceps common tendon and patellar ligament.r',
    'Common tendon of biceps femoris.r', 'Semimembranosus muscle tendon.r',
    'Pes anserinus common tendon.r',
    // Gastrocnemius crosses the KNEE (femoral origin → shank); the Achilles
    // above carries its ankle half.
    'Lateral head of gastrocnemius.r', 'Medial head of gastrocnemius.r',
  ],
  // Hip muscles anchored to the pelvis/sacrum above the joint → their proximal
  // end follows the pelvis.
  //
  // The second block is the counterpart to the note above, and it is the bug
  // the hip-flexion clip showed. These bellies REST ON the pelvis (measured
  // gap to the pelvic bone cloud: sartorius 2.3 mm, semimembranosus 1.6,
  // gracilis 2.4, rectus femoris 2.1 — 5-10% of each belly's tissue is in
  // contact with it), but their one `insert` slot was spent on the knee, so
  // their origins were welded to the FEMUR with nothing modelling the hip. Hip
  // flexion then carried those origins bodily off the pelvis — measured in the
  // pelvis's own frame, sartorius 169 mm, semimembranosus 127, gracilis 101,
  // rectus femoris 77, against 0-9 mm for the already-correct hip muscles
  // beside them. A belly can only span two joints, so the proximal one wins
  // here: the hip is where the detachment is, and every one of these already
  // has a shipped tendon crossing the knee for it.
  pelvis: [
    'Adductor longus.r', 'Adductor brevis.r', 'Adductor magnus.r', 'Pectineus muscle.r',
    'Gluteus maximus muscle.r', 'Gluteus medius muscle.r', 'Gluteus minimus muscle.r',
    'Iliacus muscle.r', 'Psoas major.r', 'Piriformis muscle.r',
    'Rectus femoris.r', 'Sartorius muscle.r', 'Gracilis muscle.r',
    'Long head of biceps femoris.r', 'Semitendinosus muscle.r', 'Semimembranosus muscle.r',
  ],
  // Shank muscles crossing to the foot (the ankle/toe movers) → their distal
  // end follows the ankle. The triceps surae is NOT here: it reaches the foot
  // through the Achilles, which is, and the two heads of gastrocnemius ride
  // `hip` and spend their crossing on the knee.
  //
  // THE SOLEUS BELONGS TO THAT DIVISION OF LABOUR TOO, and putting it here was
  // the quadriceps bug wearing a different hat. Measured at rest it sits 85.3 mm
  // from the ankle bone cluster and 111.9 mm from the calcaneus — it never
  // reaches the foot at all — so by the CONTACT rule above it must not be
  // skinned across the joint. Skinned to the ankle regardless, the sliding
  // window parked its far weight band on mid-belly tissue and the foot towed it
  // bodily through the arc: at 45° of plantarflexion 40% of its vertices moved
  // (max 84.8 mm, mean 28.7 mm) measured in the TIBIA's own frame, curling the
  // lower half of the belly off the shank and opening a 44.0 mm gap between the
  // soleus and its own Achilles (0.0 mm at rest). That is the "calf popping off
  // in plantarflexion" report. The Achilles already reaches the calcaneus at
  // 2.4 mm and already does the crossing, so the `insert` slot bought nothing.
  //
  // Note which metrics were BLIND to this, because they are the ones the probe
  // prints loudest: stretch read x0.947..x1.016 and drift 0.0-0.1 mm, both
  // perfect. The belly was not being stretched, it was being TRANSPORTED — rigid
  // in the foot's frame, which is exactly what "drift" measures as success. Only
  // the CONTACT audit, and per-vertex motion read in the bone the tissue rests
  // on, can see it. Same blind spot as the pre-fix quadriceps.
  ankle: [
    'Calcaneal tendon.r',
    'Tibialis anterior muscle.r', 'Tibialis posterior muscle.r',
    'Fibularis longus muscle.r', 'Fibularis brevis muscle.r',
    'Extensor digitorum longus.r', 'Extensor hallucis longus.r',
    'Flexor digitorum longus.r', 'Flexor hallucis longus.r',
  ],
  // Upper-arm muscles reaching the forearm (biceps/triceps/brachialis) → distal
  // end follows the elbow, so the biceps stretches as the elbow flexes.
  elbow: [
    'Common tendon of biceps brachii.r', 'Common tendon of triceps brachii.r',
    'Brachialis muscle.r',
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

// DELIBERATELY ABSENT above, so the omission does not read as an oversight: the
// three vasti and the short head of biceps femoris. Measured at rest, they touch
// NEITHER neighbouring bone — 55-63 mm from the pelvis and 66-81 mm from the
// shin (short head 120 mm / 13 mm) — because they arise from the femoral shaft
// and end in a tendon. There is no joint for them to be skinned across, so they
// stay rigid on the femur and their tendons (quadriceps/patellar, common tendon
// of biceps femoris) carry the knee. A clip whose prime movers are these bellies
// must name the tendon in its callout or it highlights nothing that can move —
// see QUADS/HAMSTRINGS in movements.js, the same rule the Achilles set for the
// ankle clips.

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
  if (insert && CONTACT_SHEETS.has(n)) {
    const opts = CONTACT_OPTS.get(n);
    return { node, insert, contact: true, contactOrigin: opts?.origin, contactWindow: opts?.window };
  }
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
      node: cls.node, insert: cls.insert, spread: cls.spread, contact: cls.contact,
      contactOrigin: cls.contactOrigin, contactWindow: cls.contactWindow, ride: cls.ride, geometry: g,
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
