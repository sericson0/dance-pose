import * as THREE from 'three';
import { normBoneName } from './skeletonMesh.js';

// ---------------------------------------------------------------- landmarks
// Named anatomical points, each located INDEPENDENTLY in every layer from that
// layer's own geometry. This independence is the whole point: the existing
// alignment diagnostic compares the centroid of everything hanging on a joint
// node against the centroid of the skin attributed to it, which conflates two
// different things — "the layers disagree" and "the layers own different
// geometry". (The skeleton's `spine` node holds the entire vertebral column and
// ribcage; the avatar's Spine bone owns a patch of skin. Those centroids differ
// by ~150 mm at rest and always will.) A landmark says instead: here is one
// point, here is how the skeleton finds it, here is how the avatar finds it —
// now their distance apart is a real number that means something.
//
// TORSO LANDMARKS MUST BE PALPABLE. The skeleton lives *inside* the skin, so
// for most of the trunk there is no reason bone and skin should coincide and a
// large gap is anatomy, not misalignment. The landmarks below are therefore the
// classical subcutaneous ones anthropometry itself uses — acromion, iliac
// crest, C7 spinous process, jugular notch — where bone is directly under skin
// and the residual is a thin, roughly constant soft-tissue thickness. Limb
// landmarks are mostly endpoints (fingertip, heel, toe tip) for the same
// reason: that is where the two layers genuinely describe the same place.
//
// A landmark's vertex SET is frozen at bind (rest pose); its POSITION is read
// live, so a landmark can be resolved in any pose. That matters because the
// whole rig/atlas divergence class of bug is pose-dependent — invisible at rest
// (~6 mm) and glaring at the embrace's deep elbow flexion (~180 mm). A metric
// that only ever samples rest cannot see it in principle.

// `pick` selects which of the matched verts define the point:
//   'all'                      → centroid of every match
//   { ref, far, frac }         → mean of the `frac` fraction farthest from
//                                (or nearest, far:false) the joint node `ref`
//   { axis, frac }             → mean of the `frac` fraction most extreme along
//                                a figure-local direction (+z anterior, +y up,
//                                +x is the figure's left)
// `ref` names one of OUR joint nodes. Using a shared reference is legitimate:
// it only decides WHICH verts to select, and both layers use the same one — the
// measurement is the distance between the two selected points.
export const LANDMARKS = [
  // ---- hand: the one endpoint that already gets a full similarity fit
  // (#endpointAlignR), so these are the regression guard. Expect ~10-15 mm.
  {
    id: 'palm_center', joint: 'wrist', sided: true,
    skeleton: { bones: /metacarpal|capitate|hamate|lunate|scaphoid|trapezi|triquetrum|pisiform/, pick: 'all' },
    body: { bones: /hand$/, pick: 'all' },
  },
  {
    id: 'fingertip_middle', joint: 'wrist', sided: true,
    skeleton: { bones: /phalanx.*of3(?:rd|d)finger|of3(?:rd|d)finger/, pick: { ref: 'wrist', far: true, frac: 0.04 } },
    body: { bones: /finger2/, pick: { ref: 'wrist', far: true, frac: 0.04 } },
  },

  // ---- foot: no roll fit and no scale fit today. heel_back + toe_tip span the
  // foot's long axis in both layers, so their two gaps report position, ANGLE
  // and LENGTH error at once — which is exactly the reported symptom.
  {
    id: 'heel_back', joint: 'ankle', sided: true,
    skeleton: { bones: /calcaneus/, pick: { axis: [0, 0, -1], frac: 0.05 } },
    body: { bones: /foot$/, pick: { axis: [0, 0, -1], frac: 0.05 } },
  },
  {
    id: 'toe_tip', joint: 'toes', sided: true,
    skeleton: { bones: /fingeroffoot/, pick: { axis: [0, 0, 1], frac: 0.05 } },
    body: { bones: /toe0/, pick: { axis: [0, 0, 1], frac: 0.05 } },
  },
  {
    id: 'ankle_center', joint: 'ankle', sided: true,
    // Interior bone vs exterior skin, so this one carries a real standing
    // offset (~20-30 mm) and its ABSOLUTE gap says little. What it is good for
    // is the offset's stability across poses — see the spread metric.
    skeleton: { bones: /talus/, pick: 'all' },
    body: { bones: /foot$/, pick: { ref: 'knee', far: false, frac: 0.06 } },
  },

  // ---- arm joints: the audit targets. collision.js builds its arm capsules
  // between rig joint NODES, and pins.js stores an arm spot in a rig node's
  // local frame — both on limbs that flex deeply in the embrace, which is the
  // exact condition under which a rig node stops representing the visible limb.
  // These landmarks are here to measure that, not to look pretty: each is the
  // skin the avatar actually shows at the joint, so the distance from the rig
  // node to the landmark IS the error a capsule or a pin inherits.
  {
    id: 'elbow_skin', joint: 'elbow', sided: true,
    skeleton: { bones: /^radius|^ulna/, pick: { ref: 'wrist', far: true, frac: 0.06 } },
    body: { bones: /forearm/, pick: { ref: 'wrist', far: true, frac: 0.06 } },
  },
  {
    id: 'shoulder_skin', joint: 'shoulder', sided: true,
    skeleton: { bones: /humerus/, pick: { ref: 'elbow', far: true, frac: 0.06 } },
    body: { bones: /upperarm/, pick: { ref: 'elbow', far: true, frac: 0.06 } },
  },

  // ---- torso: palpable landmarks only (see the header note).
  {
    id: 'acromion', joint: 'scapula', sided: true,
    // The lateral bony point of the shoulder — the scapular spine's far end.
    // Body side is the CLAVICLE's skin only: upper-arm weights run the whole
    // limb, whose most-lateral vert at rest is the deltoid, not the acromion.
    skeleton: { bones: /scapula/, pick: { axis: [1, 0, 0], frac: 0.04 } },
    body: { bones: /clavicle/, pick: { axis: [1, 0, 0], frac: 0.04 } },
  },
  {
    id: 'iliac_crest', joint: 'pelvis', sided: true,
    // The crest's lateral tubercle — the point you feel resting a hand on your
    // hip. Sided (there are two crests) but riding the central pelvis node, so
    // the mirrored axis is what separates them. Up-AND-lateral: a plain +y took
    // the topmost pelvis skin, which is the waist, a good 7 cm above the crest.
    skeleton: { bones: /hipbone/, pick: { axis: [1, 1, 0], frac: 0.03 } },
    body: { bones: /pelvis$/, pick: { axis: [1, 1, 0], frac: 0.03 } },
  },
  {
    id: 'c7_spinous', joint: 'neck', sided: false,
    // The bump at the base of the neck — the most posterior cervical vertebra.
    skeleton: { bones: /cervicalvertebrae/, pick: { axis: [0, 0, -1], frac: 0.05 } },
    body: { bones: /neck/, pick: { axis: [0, 0, -1], frac: 0.05 } },
  },
  {
    id: 'jugular_notch', joint: 'chest', sided: false,
    // Top of the sternum, in the hollow between the collarbones. Body side is
    // CHEST-weighted skin picked up-and-forward: the neck bone's weights stop
    // above the collarbone, so the lowest anterior neck vert sat at the throat,
    // ~6 cm high. The top-front of the chest lands in the hollow itself.
    skeleton: { bones: /sternum/, pick: { axis: [0, 1, 0], frac: 0.04 } },
    body: { bones: /spine2/, pick: { axis: [0, 1, 1], frac: 0.03 } },
  },
];

// ------------------------------------------------------------ endpoint fits
// Where the skeleton geometry must be laid ONTO the clothed avatar's, because
// the two models simply disagree about the shape of an extremity. Each fit is a
// set of corresponding regions; Figure.#endpointAlignR runs a weighted
// similarity fit (Umeyama/Horn) over their centroids and applies the resulting
// rotation + uniform scale + translation to the skeleton meshes on `rotNodes`,
// pivoting about `pivot`.
//
// A region uses exactly the same {bones, pick} recipe as a landmark — a region
// is just a landmark that keeps many verts instead of a few. What makes a
// region VALID is that its two recipes describe the same sub-object, so the
// centroids are concentric (bone inside, skin outside, same middle). "The
// thumb" works; "the calcaneus vs the rearmost 5% of foot skin" does not,
// because the skin patch is biased backwards and the bone centroid is not.
//
// Regions must also not be collinear, or the roll about that line is
// unconstrained. The foot's heel/ball/whole regions all lie along the foot's
// long axis, so medial and lateral regions are what actually pin its roll.
export const ENDPOINT_FITS = [
  {
    // The hand: the atlas holds it splayed and palm-down, the avatar carries it
    // hanging and rolled ~110° about the forearm. Five finger clusters plus the
    // palm block. The palm is weighted up because the two hands are shaped
    // differently and no rigid rotation makes them fully coincide — the palm is
    // the part that must truly match, and the fingers merely steer the roll.
    pivot: 'wrist', rotNodes: ['wrist'],
    regions: [
      { key: 'thumb', weight: 1, skeleton: { raw: true, perBone: 120, bones: /of1stfinger/, pick: 'all' }, body: { bones: /finger0/, pick: 'all' } },
      { key: 'index', weight: 1, skeleton: { raw: true, perBone: 120, bones: /of2(?:nd|d)finger/, pick: 'all' }, body: { bones: /finger1/, pick: 'all' } },
      { key: 'middle', weight: 1, skeleton: { raw: true, perBone: 120, bones: /of3(?:rd|d)finger/, pick: 'all' }, body: { bones: /finger2/, pick: 'all' } },
      { key: 'ring', weight: 1, skeleton: { raw: true, perBone: 120, bones: /of4thfinger/, pick: 'all' }, body: { bones: /finger3/, pick: 'all' } },
      { key: 'pinky', weight: 1, skeleton: { raw: true, perBone: 120, bones: /of5thfinger/, pick: 'all' }, body: { bones: /finger4/, pick: 'all' } },
      {
        key: 'palm', weight: 2,
        skeleton: { raw: true, perBone: 120, bones: /metacarpal|capitat|hamat|lunat|scaphoid|pisiform|trapez|triquetr|sesamoidbonesofhand/, pick: 'all' },
        body: { bones: /hand$/, pick: 'all' },
      },
    ],
  },
  {
    // The foot: an AXIS fit, not a similarity fit. What matters for a foot is
    // that it POINTS the same way as the shoe around it — so this aligns the
    // midline through the skeletal foot with the midline through the shoe, and
    // deliberately does nothing else.
    //
    // A similarity fit was tried first and made things worse: toe_tip improved
    // 53→34 mm but heel_back went 21→55 mm and ankle_center 43→81 mm. The
    // reason is that a glove follows a hand, so their regions are concentric
    // and a similarity transform can reconcile them, whereas a SHOE does not
    // follow a foot — heel block, toe box — so no region pair is concentric.
    // The scale term was the worst of it: the leader's skeletal foot is 20 mm
    // SHORTER than his shoe while the follower's is 22 mm LONGER than her
    // heeled one, so fitting hers shrank it about the ankle and slid the heel
    // forward. Dropping scale entirely removes that failure mode by
    // construction — the two feet are allowed to stay different sizes, which
    // they genuinely are.
    //
    // This also subsumes the pitch #applyHeel used to bisect for: a heeled
    // shoe's midline is already pitched, so matching it reproduces the pitch at
    // any heel height with no special case.
    pivot: 'ankle', rotNodes: ['ankle', 'toes'], mode: 'axis',
    axis: {
      skeleton: { bones: /talus|calcaneus|navicular|cuboid|cuneiform|metatarsal|fingeroffoot|sesamoidbonesoffoot/ },
      body: { bones: /foot$|toe0/ },
      // Both midlines are un-signed (a principal axis has no inherent
      // direction), so each is flipped to point the same way along the figure's
      // own forward before they are compared — otherwise the fit can cheerfully
      // rotate the foot 180° to align heel-to-toe with toe-to-heel.
      forward: [0, 0, 1],
    },
  },
];

const _v = new THREE.Vector3();

// Gather candidate verts for one layer's recipe as [{ mesh, index }, …].
// Skeleton meshes are merged per node+material but carry userData.boneRanges
// (see Figure.#buildMeshSkeleton), so a bone-name regex still selects a vertex
// range. Body verts are attributed to the Biped bone carrying the most weight.
function candidates(figure, spec, layer, nodes, side, sided) {
  const out = [];
  const re = spec.bones;
  if (layer === 'skeleton') {
    for (const mesh of figure.layerMeshes.skeleton) {
      if (!nodes.includes(nodeNameOf(mesh))) continue;
      const ranges = mesh.userData.boneRanges;
      if (!ranges) continue;
      for (const r of ranges) {
        if (!re.test(normBoneName(r.name))) continue;
        // `perBone` samples a FIXED count from every bone instead of a fixed
        // fraction, so each bone contributes equally and the result is the mean
        // of the bones' centroids rather than the cloud's volume centroid. That
        // matters wherever a region mixes bones of very different sizes: the
        // palm block spans five metacarpals and eight small carpals, and
        // weighting by volume drags its centroid out of the wrist and away from
        // the glove (measured: the fit's palm gap went 4 mm → 11 mm when this
        // was proportional). Equal-per-bone also keeps the small carpals'
        // anchoring influence near the joint, which is what the fit pivots on.
        const denom = spec.perBone ?? 400;
        const step = Math.max(1, Math.floor(r.count / denom));
        for (let i = 0; i < r.count; i += step) out.push({ mesh, index: r.start + i });
      }
    }
  } else {
    for (const mesh of figure.layerMeshes.body) {
      if (!mesh.isSkinnedMesh) continue;
      // Hair cards, lashes and other transparent shells are not body surface,
      // and they sit PROUD of it — the follower's hair is weighted to her neck
      // bone, so a "most posterior neck vert" recipe was measuring the back of
      // her hair (74 mm, against 18 mm for the same landmark on the leader,
      // who has none). loadBodyMesh already marks these materials transparent.
      if (mesh.material && mesh.material.transparent) continue;
      const si = mesh.geometry.attributes.skinIndex;
      const sw = mesh.geometry.attributes.skinWeight;
      const p = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 8000));
      for (let i = 0; i < p.count; i += step) {
        let bi = si.getX(i); let bw = sw.getX(i);
        if (sw.getY(i) > bw) { bw = sw.getY(i); bi = si.getY(i); }
        if (sw.getZ(i) > bw) { bw = sw.getZ(i); bi = si.getZ(i); }
        if (sw.getW(i) > bw) { bw = sw.getW(i); bi = si.getW(i); }
        const bone = mesh.skeleton.bones[bi];
        if (!bone) continue;
        const n = normBoneName(bone.name);
        if (!re.test(n)) continue;
        // A sided landmark must not pick up the other limb's bone — but only
        // where the bone IS sided. A sided landmark can ride a central bone
        // (left and right iliac crests both live on the Biped pelvis); there
        // the axis pick is what separates the sides, so keep both.
        if (sided && /^bip01[lr]/.test(n) && /^bip01l/.test(n) !== (side === '_L')) continue;
        out.push({ mesh, index: i });
      }
    }
  }
  return out;
}

// World position of one candidate vertex, in the CURRENT pose.
//
// getVertexPosition returns the vertex in the mesh's OWN space for both mesh
// kinds — plain geometry-local, or (for a SkinnedMesh) skinned but still
// pre-model-matrix, because 'attached' bind mode leaves the model matrix to be
// applied at render time. So one formula covers both: matrixWorld · vertex.
//
// The skinned case is a trap worth naming. Because #buildMeshBody binds with an
// identity bind matrix, the skinned result looks world-space — it is built from
// bone.matrixWorld — and it IS world-space whenever the figure's group happens
// to sit at the origin. Off the origin it is short by exactly the group
// translation. dev-verify-alignment.mjs reads it raw and only stays correct
// because it zeroes group.position first.
function vertWorld(c, target) {
  c.mesh.getVertexPosition(c.index, target);
  return target.applyMatrix4(c.mesh.matrixWorld);
}

function nodeNameOf(obj) {
  let n = obj;
  while (n && (!n.userData || n.userData.jointName === undefined)) n = n.parent;
  return n ? n.userData.jointName : null;
}

// Narrow a candidate list down to the verts a `pick` selects. Extracted so the
// landmark gate and the endpoint fit (ENDPOINT_FITS) run the exact same
// selection rules — a region and a landmark differ only in how many verts they
// keep, not in how they are found.
function reduceVerts(figure, cands, pick, side, gInv) {
  if (pick === 'all' || !pick) return cands;
  const frac = pick.frac ?? 0.05;
  let score;
  if (pick.axis) {
    // Extreme along a figure-local direction: measured in figure space so the
    // axis means the same thing however the dancer is turned. On a sided
    // landmark the axis is authored for the LEFT and mirrored for the right,
    // matching skeletonDef.js's left-only convention — otherwise a fixed +x
    // reads "lateral" on one side and "medial" on the other, and the two sides
    // silently pick opposite edges of the same bone (measured: a 300 mm
    // acromion gap that was pure recipe).
    const mir = side === '_R' ? -1 : 1;
    const ax = new THREE.Vector3(pick.axis[0] * mir, pick.axis[1], pick.axis[2]).normalize();
    score = (c) => vertWorld(c, _v).applyMatrix4(gInv).dot(ax);
  } else {
    // A ref names a joint BASE; resolve it to this landmark's side (pick.ref
    // 'wrist' → node 'wrist_L'). An unresolved ref used to fail silently and
    // leave the set null, which reads downstream as "landmark not found"
    // rather than "recipe is broken".
    const ref = figure.nodes[pick.ref] || figure.nodes[`${pick.ref}${side}`];
    if (!ref) throw new Error(`landmark pick: no joint node for ref '${pick.ref}'`);
    const rp = ref.getWorldPosition(new THREE.Vector3());
    const sgn = pick.far ? 1 : -1;
    score = (c) => sgn * vertWorld(c, _v).distanceToSquared(rp);
  }
  // Always average a few verts, never one. A fraction alone collapses to a
  // single vertex on a small candidate set — the follower's neck skin yielded
  // exactly 1, which is a sample of noise, not a landmark (it read 50 mm
  // off-centre while the leader's 7-vert set read 11 mm).
  const scored = cands.map((c) => [score(c), c]).sort((a, b) => b[0] - a[0]);
  const take = Math.min(scored.length, Math.max(pick.min ?? 5, Math.round(scored.length * frac)));
  return scored.slice(0, take).map((s) => s[1]);
}

// Centroid of the RAW atlas bone geometry for a region — the un-baked source
// meshes, transformed by the same scale/settle/mirror #buildMeshSkeleton uses.
//
// This differs from reading the rendered meshes in one way that matters: the
// rendered hand has the HAND_DESPLAY finger tuck baked into it. Reading what is
// actually drawn is arguably the more correct thing to fit, but switching to it
// rotated the frozen hand calibration by 9° and moved palm_center 4 mm → 8 mm,
// so the validated behaviour is preserved here deliberately. Whether the
// desplayed geometry gives a better fit is a real open question — it is worth
// testing on its own, with a screenshot comparison, not as a side effect of a
// refactor. Regions opt in with `raw: true`.
function rawSkeletonCentroid(figure, spec, bases, side) {
  const sm = figure.skeletonMesh;
  if (!sm) return null;
  const s = figure.height / sm.atlasHeight;
  const settleY = -sm.atlasMinY * s;
  const mir = side === '_L' ? -1 : 1;
  const c = new THREE.Vector3();
  let n = 0;
  for (const b of sm.bones) {
    if (!bases.includes(b.node) || !spec.bones.test(normBoneName(b.name))) continue;
    const p = b.geometry.attributes.position;
    const step = Math.max(1, Math.floor(p.count / (spec.perBone ?? 120)));
    for (let i = 0; i < p.count; i += step) {
      c.add(_v.set(p.getX(i) * s * mir, p.getY(i) * s + settleY, p.getZ(i) * s));
      n++;
    }
  }
  return n ? c.multiplyScalar(1 / n).applyMatrix4(figure.group.matrixWorld) : null;
}

// The midline of one layer's take on a body part: its centroid and its long
// axis, in world space. The axis is the dominant principal component of the
// vertex cloud — for a foot, whose length far exceeds its width and height,
// that IS the heel-to-toe midline, and it is far steadier than any two extreme
// points (which sit on a toe box or a heel block and jitter with the mesh).
// `forward` is a figure-local direction used only to give the axis a sign.
export function axisFrame(figure, layer, spec, nodes, side, forward) {
  const pts = regionPoints(figure, layer, spec, nodes, side);
  if (pts.length < 3) return null;
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  // Covariance, then power iteration for its dominant eigenvector.
  let xx = 0; let xy = 0; let xz = 0; let yy = 0; let yz = 0; let zz = 0;
  for (const p of pts) {
    const dx = p.x - c.x; const dy = p.y - c.y; const dz = p.z - c.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const M = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  const b = new THREE.Vector3(0.2, 0.1, 1).normalize();
  for (let k = 0; k < 64; k++) {
    const nx = M[0][0] * b.x + M[0][1] * b.y + M[0][2] * b.z;
    const ny = M[1][0] * b.x + M[1][1] * b.y + M[1][2] * b.z;
    const nz = M[2][0] * b.x + M[2][1] * b.y + M[2][2] * b.z;
    if (!Number.isFinite(nx + ny + nz) || (nx === 0 && ny === 0 && nz === 0)) return null;
    b.set(nx, ny, nz).normalize();
  }
  // Sign it: a principal axis is a line, not an arrow.
  const fwdWorld = new THREE.Vector3(...forward)
    .applyQuaternion(figure.group.getWorldQuaternion(new THREE.Quaternion()));
  if (b.dot(fwdWorld) < 0) b.negate();
  // Extent along the midline — the part's LENGTH, which is what lets the fit
  // absorb a genuine size difference along one axis without touching the other
  // two (a bare foot and a shoe differ in length far more than in width).
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    const t = p.clone().sub(c).dot(b);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  // `center` is the MIDPOINT OF THE SEGMENT, not the centroid, and the two are
  // not interchangeable. The centroid is a mass average, so it sits wherever
  // the vertices happen to bunch — and a bone cloud bunches quite differently
  // from the shoe skin around it, which means the two layers' centroids do not
  // correspond to each other even when their extents match exactly. Aligning
  // them slid the skeletal foot right down its own length (312 mm of error).
  // The segment midpoint is purely geometric: with equal extents, matching
  // midpoints also matches both ENDS, which is what puts heel on heel and toe
  // on toe.
  const center = c.clone().addScaledVector(b, (lo + hi) / 2);
  return { centroid: c, center, axis: b, extent: hi - lo };
}

// Every world-space vertex a region's recipe selects (before any `pick`).
export function regionPoints(figure, layer, spec, nodes, side, sided = true) {
  figure.group.updateMatrixWorld(true);
  return candidates(figure, spec, layer, nodes, side, sided)
    .map((c) => vertWorld(c, new THREE.Vector3()));
}

// World-space centroid of one layer's take on a region: the same {bones, pick}
// recipe a landmark uses, reduced to a single point. Returns null if nothing
// matched. This is the correspondence the endpoint similarity fit consumes.
export function regionCentroid(figure, layer, spec, nodes, side, sided = true) {
  figure.group.updateMatrixWorld(true);
  if (layer === 'skeleton' && spec.raw) {
    return rawSkeletonCentroid(figure, spec, nodes.map((n) => n.replace(/_[LR]$/, '')), side);
  }
  const gInv = figure.group.matrixWorld.clone().invert();
  const cands = candidates(figure, spec, layer, nodes, side, sided);
  if (!cands.length) return null;
  const chosen = reduceVerts(figure, cands, spec.pick, side, gInv);
  if (!chosen.length) return null;
  const c = new THREE.Vector3();
  for (const v of chosen) c.add(vertWorld(v, _v));
  return c.multiplyScalar(1 / chosen.length);
}

// Freeze each landmark's vertex set, per layer, at the CURRENT (rest) pose.
// Selection happens once so a landmark stays the same material point on the
// body; only its position is re-read later. Stores figure.landmarkSets.
export function bindLandmarks(figure) {
  figure.group.updateMatrixWorld(true);
  const gInv = figure.group.matrixWorld.clone().invert();
  const sets = {};

  for (const lm of LANDMARKS) {
    for (const side of lm.sided ? ['_L', '_R'] : ['']) {
      // A sided landmark normally rides a sided node (acromion → scapula_L),
      // but may ride a central one (both iliac crests are on `pelvis`); fall
      // back so `sided` can mean "has L/R instances and mirrors its axis"
      // independently of whether the joint itself is paired.
      const jointName = figure.nodes[`${lm.joint}${side}`] ? `${lm.joint}${side}` : lm.joint;
      const key = `${lm.id}${side}`;
      sets[key] = { joint: jointName, skeleton: null, body: null };

      for (const layer of ['skeleton', 'body']) {
        const cands = candidates(figure, lm[layer], layer, [jointName], side, lm.sided);
        if (!cands.length) continue;
        sets[key][layer] = reduceVerts(figure, cands, lm[layer].pick, side, gInv);
      }
    }
  }
  figure.landmarkSets = sets;
  return sets;
}

// World position of a landmark in one layer, in the CURRENT pose, or null if
// that layer could not locate it (geometry missing, or a procedural fallback).
export function landmarkWorld(figure, key, layer, target = new THREE.Vector3()) {
  const set = figure.landmarkSets?.[key];
  const verts = set?.[layer];
  if (!verts || !verts.length) return null;
  target.set(0, 0, 0);
  for (const c of verts) target.add(vertWorld(c, _v));
  return target.multiplyScalar(1 / verts.length);
}

// The angle between the two layers' midlines, per axis-mode endpoint fit, in
// the CURRENT pose: [{ key, deg, offsetMm }, …].
//
// This is the direct measure of "does the skeletal foot point the same way as
// the shoe" — the question the layer-gap numbers cannot answer, because a foot
// can be perfectly aimed and still show a large gap at heel and toe simply for
// being a different LENGTH than the shoe around it. Reads the rendered meshes,
// so it measures the foot after the fit, not before.
export function measureAxes(figure) {
  figure.group.updateMatrixWorld(true);
  const out = [];
  for (const fit of ENDPOINT_FITS) {
    if (fit.mode !== 'axis') continue;
    for (const side of ['_L', '_R']) {
      const nodes = fit.rotNodes.map((b) => `${b}${side}`);
      const sf = axisFrame(figure, 'skeleton', fit.axis.skeleton, nodes, side, fit.axis.forward);
      const bf = axisFrame(figure, 'body', fit.axis.body, nodes, side, fit.axis.forward);
      if (!sf || !bf) continue;
      // Perpendicular distance between the two midlines at the shoe's centre —
      // how far off-axis the skeletal foot sits, independent of length.
      const d = sf.centroid.clone().sub(bf.centroid);
      const perp = d.clone().sub(bf.axis.clone().multiplyScalar(d.dot(bf.axis)));
      out.push({
        key: `${fit.pivot}${side}`,
        deg: THREE.MathUtils.radToDeg(sf.axis.angleTo(bf.axis)),
        offsetMm: perp.length() * 1000,
      });
    }
  }
  return out;
}

// Every landmark's per-layer position, the gap between layers, and the
// landmark's position expressed in its RIG joint node's local frame, in the
// CURRENT pose: [{ key, joint, skeleton, body, gapMm, rigLocal }, …].
//
// `rigLocal` is the one that catches the palm-hold class of bug, and layer-vs-
// layer agreement provably cannot. The skeleton hand and the clothed hand are
// BOTH welded to the atlas wrist, so they ride together and their mutual gap
// stays ~4 mm in every pose — perfectly aligned, and perfectly uninformative,
// because the failure is that constraint code reads a THIRD thing: the rig
// wrist node, which shares the atlas wrist's rotation but drifts up to ~180 mm
// from it in position under flexion. Expressed in the rig node's local frame, a
// landmark the node faithfully represents holds STILL; one the node has
// diverged from moves as the limb bends. So the signal is again spread, not
// magnitude — the standing offset from a joint centre to a palm centre is
// supposed to be non-zero; what it must not do is change.
export function measureLandmarks(figure) {
  figure.group.updateMatrixWorld(true);
  const out = [];
  for (const key of Object.keys(figure.landmarkSets || {})) {
    const joint = figure.landmarkSets[key].joint;
    const s = landmarkWorld(figure, key, 'skeleton', new THREE.Vector3());
    const b = landmarkWorld(figure, key, 'body', new THREE.Vector3());
    const node = figure.nodes[joint];
    const ref = b || s; // prefer mesh truth: the body is what the viewer sees
    out.push({
      key,
      joint,
      skeleton: s,
      body: b,
      gapMm: s && b ? s.distanceTo(b) * 1000 : null,
      rigLocal: node && ref ? node.worldToLocal(ref.clone()) : null,
      // Same, but in the ATLAS node's frame where the joint is seated. The
      // clothed limb is welded to the atlas node, so if this is small and
      // steady where rigLocal is large and wandering, the fix for collision
      // capsules and contact pins is simply to read the atlas node — no new
      // machinery needed.
      atlasLocal: figure.atlasNodes?.[joint] && ref
        ? figure.atlasNodes[joint].worldToLocal(ref.clone()) : null,
    });
  }
  return out;
}
