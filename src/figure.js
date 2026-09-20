import * as THREE from 'three';
import {
  JOINTS, JOINT_BY_NAME, DEG, clampAngle, FOOT_CORNERS_L, FOOT_CORNERS_R,
  TOE_CORNERS_L, TOE_CORNERS_R, PART_OF_NODE, PART_COLOR,
} from './skeletonDef.js';
import { buildSkeleton, buildMuscles } from './anatomy.js';
import { LIMB_BASES, reverseWinding, BODY_RETARGET, normBoneName } from './skeletonMesh.js';
import { RIG_CALIBRATION } from './rigCalibration.js';
import { ENDPOINT_FITS, regionCentroid, axisFrame } from './landmarks.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _floorPt = new THREE.Vector3();

// Per-muscle appearance (Muscles panel): a highlighted belly is recoloured warm
// and glows; a hidden belly renders nearly transparent (see #applyMuscleStyle).
const MUSCLE_HL_COLOR = 0xffce4a;
const MUSCLE_HL_EMISSIVE = 0xffb020;
const MUSCLE_HIDDEN_OPACITY = 0.06;
const WHITE = new THREE.Color(0xffffff);
const _hl = new THREE.Color(); // scratch for the muscle highlight mix

// Centroid and smallest-variance axis (≈ the flat normal of a slab-like cloud,
// e.g. a palm or a sole) of a set of points, via power iteration on
// (trace·I − covariance): the dominant eigenvector of that shifted matrix is
// the *smallest* eigenvector of the covariance. Used to orient the skeletal
// hand/foot onto the body (see Figure.#endpointAlignR).
function pcaPlaneNormal(pts) {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const tr = xx + yy + zz;
  const M = [[tr - xx, -xy, -xz], [-xy, tr - yy, -yz], [-xz, -yz, tr - zz]];
  const b = new THREE.Vector3(0.3, 1, -0.2).normalize();
  for (let k = 0; k < 48; k++) {
    const nx = M[0][0] * b.x + M[0][1] * b.y + M[0][2] * b.z;
    const ny = M[1][0] * b.x + M[1][1] * b.y + M[1][2] * b.z;
    const nz = M[2][0] * b.x + M[2][1] * b.y + M[2][2] * b.z;
    b.set(nx, ny, nz).normalize();
  }
  return { centroid: c, normal: b };
}

// Optimal rotation (Horn's quaternion method) minimizing Σ wᵢ·|qᵢ − R·pᵢ|² over
// corresponding point pairs pᵢ (source) → qᵢ (target) taken about a shared
// origin. Robust where a hand-frame construction is not: it makes no axis or
// sign choices and fuses every correspondence at once, so a landmark that sits
// off the palm plane (the opposable thumb) or a shape mismatch between the two
// hands is averaged out instead of tipping a normal the wrong way. The solution
// is the eigenvector of a symmetric 4×4 built from the cross-covariance, for its
// largest eigenvalue — found here by shifted power iteration. Returns a unit
// THREE.Quaternion.
function hornRotation(P, Q, W) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = Q[i], w = W[i];
    Sxx += w * p.x * q.x; Sxy += w * p.x * q.y; Sxz += w * p.x * q.z;
    Syx += w * p.y * q.x; Syy += w * p.y * q.y; Syz += w * p.y * q.z;
    Szx += w * p.z * q.x; Szy += w * p.z * q.y; Szz += w * p.z * q.z;
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Shift by the max absolute row sum so N is positive-definite; power iteration
  // then converges to the (now largest-magnitude) eigenvector we want.
  let c = 1;
  for (let a = 0; a < 4; a++) { let s = 0; for (let b = 0; b < 4; b++) s += Math.abs(N[a][b]); c = Math.max(c, s); }
  for (let a = 0; a < 4; a++) N[a][a] += c;
  let v = [1, 0.1, 0.1, 0.1];
  for (let it = 0; it < 200; it++) {
    const r = [0, 0, 0, 0];
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) r[a] += N[a][b] * v[b];
    const n = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    v = [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  return new THREE.Quaternion(v[1], v[2], v[3], v[0]); // (x,y,z,w) from quaternion (w,x,y,z)
}

// How far to tuck the skeletal hand's splayed atlas fingers together (fraction
// of each finger's abduction from the middle finger removed at bake time). The
// anatomy atlas fans the fingers ~1.7× wider than the clothed avatar carries
// them, so the bare fan overshoots the glove; 0.40 brings index/ring/pinky
// abduction down to the clothed hand's own spread (measured per finger: atlas
// 13.8/12.6/27.0° → clothed 8.5/7.3/16.1°). The thumb (ray 1) and middle
// (ray 3, the reference) are left alone; index/ring/pinky adduct toward middle.
const HAND_DESPLAY = 0.4;

// Scratch objects for per-frame muscle skinning (updateMuscleSkin), reused so
// the hot loop allocates nothing.
const _gInv = new THREE.Matrix4();
const _dA = new THREE.Matrix4();
const _dB = new THREE.Matrix4();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _tA = new THREE.Vector3();
const _tB = new THREE.Vector3();
const _scl = new THREE.Vector3();

// Flesh clearance around each joint (fraction of height) used for floor
// contact; the foot soles are handled separately via FOOT_CORNERS.
const FLOOR_CLEARANCE = {
  head: 0.055, headTop: 0.01, neck: 0.04,
  pelvis: 0.075, spine: 0.08, chest: 0.08,
  shoulder_L: 0.045, shoulder_R: 0.045,
  elbow_L: 0.03, elbow_R: 0.03,
  wrist_L: 0.025, wrist_R: 0.025,
  hand_L: 0.012, hand_R: 0.012,
  hip_L: 0.055, hip_R: 0.055,
  knee_L: 0.042, knee_R: 0.042,
};

// Translucent heel/shoe outline shown under a heeled figure's bare foot in
// skeleton and muscle views (see Figure.#buildHeelOutline): a faint filled
// shape with a brighter edge line, so the viewer can see the heel the follower
// is standing in when the shoe itself (the body avatar) is hidden.
const HEEL_OUTLINE_FILL = 0x3a3b47;
const HEEL_OUTLINE_EDGE = 0xcdd3e0;
const HEEL_OUTLINE_FILL_OPACITY = 0.22;
const HEEL_OUTLINE_EDGE_OPACITY = 0.85;

// Nodes whose floor contact the sole corner sets fully describe — skipped by
// lowestPointY's joint-clearance sweep. The rig's toe segment overshoots the
// rendered shoe (the toes joint sits near the shoe TIP), so clearing the
// phantom toe endpoint would lift a pointed foot off a toe that is visibly
// on the floor. The corner sets are fitted to the shoe (soleScale) and their
// toe pads sit at/just past its tip, so they bound the shoe in any pitch.
const CORNER_NODES = new Set(['toes_L', 'toes_R', 'toe_L', 'toe_R']);

// Fraction of the toes bone cloud that counts as "lying against the
// metatarsals" when #mtpCenter locates the MTP joint. A fraction rather than a
// distance threshold, and the answer barely depends on it: 5%, 10%, 15% and
// 25% of the toes cloud put the joint centre within 4 mm of each other on both
// avatars, because the interphalangeal joints are far enough from the ankle
// cluster never to compete for the nearest band.
const MTP_BAND = 0.10;

// Body-view capsule radii per segment (fractions of height).
const BODY_RADII = {
  shoulder_L: 0.036, shoulder_R: 0.036, // upper arms
  elbow_L: 0.029, elbow_R: 0.029, // forearms
};

// Lathe profiles for the legs: [t, r] pairs, t running 0 (proximal joint) to
// 1 (distal joint), radii as fractions of height. Profiles overshoot [0, 1]
// slightly so their open rims hide inside the pelvis / knee ball / ankle.
const THIGH_PROFILE = [
  [-0.06, 0.010], [-0.04, 0.030], [0.02, 0.048], [0.08, 0.054], [0.18, 0.057],
  [0.35, 0.052], [0.55, 0.046], [0.75, 0.041], [0.9, 0.038], [1.0, 0.0345],
  [1.04, 0.024], [1.09, 0.008],
];
// Calf bulge in the upper third, tapering to a narrow ankle.
const SHANK_PROFILE = [
  [-0.05, 0.008], [-0.03, 0.024], [0, 0.0355], [0.06, 0.038], [0.16, 0.042],
  [0.28, 0.041], [0.45, 0.034], [0.65, 0.026], [0.85, 0.020], [1.0, 0.0165],
  [1.03, 0.010], [1.05, 0.004],
];

// Finger curl for a clasped hand (the embrace's open-side hold): per-phalanx
// bend in radians at full curl, proximal→distal; the thumb only closes
// lightly around the partner's hand. Applied to the clothed avatar's Biped
// finger bones, which bend about their local Z axis.
const FINGER_CURL = [0.75, 0.9, 0.6];
const THUMB_CURL = [0.15, 0.45, 0.35];
const FINGER_AXIS = new THREE.Vector3(0, 0, 1);
const _fingerQ = new THREE.Quaternion();
const _handV = new THREE.Vector3(); // scratch for the hand-mesh measurements

export class Figure {
  constructor({ name, height = 1.72, mass = 70, color = 0x4d8fd1, skin = 0xd9a68a, skeleton = null, muscles = null, body = null, bodyKey = null, heelRise = 0, moldedHeel = 0, soleScale = null, footNarrow = 1 }) {
    this.name = name;
    this.height = height;
    this.mass = mass;
    // Which frozen calibration this figure is checked against (see
    // rigCalibration.js / #assertCalibration). Avatar-keyed ('man'/'woman')
    // because each Biped bind pose retargets differently; null skips the check.
    this.bodyKey = bodyKey;
    // FAKE heel for a genuinely FLAT-shoed avatar, as a fraction of stature:
    // raises the ankle (and everything the heel lifts) so the foot sits heel-up
    // on the floor instead of squashed flat, and pitches BOTH the skeleton and
    // the clothed foot to match. Mutually exclusive with moldedHeel.
    this.heelRise = heelRise;
    // REAL molded heel, as a fraction of stature, for an avatar whose shoe mesh
    // ALREADY carries a heel (the woman avatar). The clothed shoe stands in its
    // own heel with NO help — the ankle is not raised, the corners already sit on
    // the floor, and the clothed foot is left alone — so this only pitches the
    // bare SKELETON foot up at the heel to sit inside the shoe, and sizes the
    // heel wedge. Mutually exclusive with heelRise. See #applyHeel.
    this.moldedHeel = moldedHeel;
    // The sagittal pitch (degrees) #pitchHeeledFoot tilts the skeletal foot up at
    // the heel — 0 for a flat figure. The frame gate (dev-verify-frames) allows
    // the foot midline to sit this far off the shoe's flat sole; see measureAxes.
    this.heelPitchDeg = 0;
    // Per-figure sole footprint scale ({ front, width }, both default 1): the
    // shared FOOT_CORNERS/TOE_CORNERS tables are sized to the man's shoe, and
    // this stretches/shrinks them so the balance footprint hugs THIS avatar's
    // shoe (the woman's heeled shoe is shorter in height-fractions). `front`
    // scales everything ahead of the ankle toward it; `width` scales laterally.
    this.soleScale = { front: 1, width: 1, ...(soleScale || {}) };
    // Lateral squeeze (<1) of the BARE skeletal foot toward its own midline, for a
    // figure whose avatar wears a shoe narrower than the atlas foot (the follower's
    // heeled shoe): the foot fit matches the shoe's length + direction but NOT its
    // width, so the atlas foot's 5th-metatarsal/little-toe edge otherwise pokes out
    // past the shoe in skeleton/muscle view. See #narrowFoot. 1 = no squeeze.
    this.footNarrow = footNarrow;
    this.color = color;
    this.skin = skin;
    this.skeletonMesh = skeleton; // parsed atlas bones, or null → procedural bones
    this.muscleMesh = muscles; // parsed atlas muscles (needs skeleton), or null → procedural
    this.bodyMesh = body; // parsed clothed avatar (skinned), or null → procedural mannequin

    // How closed each hand is held (0 = open bind pose, 1 = closed fist),
    // a user-posable "joint" shaping the whole hand (see setHandCurl). Kept
    // here — not just on the finger bones — so it survives pose save/load and
    // is the stable baseline the embrace's transient clasp curl departs from.
    this.handCurl = { L: 0, R: 0 };

    this.group = new THREE.Group(); // root: position (x,z) + facing (rotation.y)
    this.group.userData.figure = this;
    this.nodes = {};
    // Display-only "atlas" joint nodes: a parallel sub-tree carrying the skeletal
    // limb bones, positioned at the imported skeleton's OWN joint centers (which
    // sit a few cm off the rig's anthropometric nodes) and slaved to the rig
    // joints' rotations each frame. Bones hung here pivot about the anatomical
    // joint, so they stay welded to their neighbours in any pose instead of
    // swinging apart as a bend opens (see #buildAtlasNodes / syncAtlasNodes).
    this.atlasNodes = {};
    this.pickSpheres = [];
    this.layerMeshes = { skeleton: [], body: [], muscle: [] };
    // Translucent shoe/heel outline meshes, shown only when the body avatar is
    // hidden (skeleton / muscle views). Empty for a flat-shoed figure.
    this.heelOutline = [];
    this.jointSphereByName = {};
    // Bi-articular muscles that skin between two joints (see updateMuscleSkin).
    this._skinMuscles = [];

    this.#buildMaterials();
    this.#build();
  }

  #buildMaterials() {
    this.materials = {
      bone: new THREE.MeshStandardMaterial({ color: 0xece4d2, roughness: 0.55 }),
      cartilage: new THREE.MeshStandardMaterial({ color: 0xd7d9d2, roughness: 0.4 }),
      socket: new THREE.MeshStandardMaterial({ color: 0x3b3630, roughness: 0.6 }),
      joint: new THREE.MeshStandardMaterial({ color: 0xcfc6b0, roughness: 0.5, transparent: true }),
      cloth: new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.85 }),
      clothDark: new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.color).multiplyScalar(0.55), roughness: 0.9,
      }),
      skin: new THREE.MeshStandardMaterial({ color: this.skin, roughness: 0.7 }),
      shoe: new THREE.MeshStandardMaterial({ color: 0x23232a, roughness: 0.5 }),
      muscleA: new THREE.MeshStandardMaterial({ color: 0xbc4a3f, roughness: 0.5 }),
      muscleB: new THREE.MeshStandardMaterial({ color: 0x9c3540, roughness: 0.5 }),
    };
  }

  // Attach a mesh into a joint node and register it in a visual layer.
  // Public so anatomy.js (and future part modules) can add geometry.
  addMesh(nodeName, mesh, layer, cast = true, parent = null) {
    mesh.castShadow = cast;
    (parent || this.nodes[nodeName]).add(mesh);
    if (layer) this.layerMeshes[layer].push(mesh);
    return mesh;
  }

  #build() {
    const H = this.height;

    // Joint hierarchy. ANY heeled figure raises its RIG ankle node (and, riding
    // them, the toes) by the heel height: a real heel lifts the ankle joint off
    // the floor, and this is the ankle the biomechanics (COG, de Leva masses),
    // the balance corners and dancer-vs-dancer collision all read — so a heeled
    // foot must sit above a flat one or the couple's interleaved feet collide
    // where they shouldn't. The extra height propagates up the closed leg chain.
    //   FAKE heel (heelLift, flat shoe): the ATLAS seats + the retargeted body
    //   foot ride up with it too (see #buildAtlasNodes / #buildMeshBody), so the
    //   flat shoe is pitched into a heel shape.
    //   MOLDED heel (moldedHeel, real heeled shoe): only the RIG ankle rises; the
    //   atlas seats and the body foot stay DOWN so the shoe — which already
    //   carries its heel — grounds natively instead of floating en-pointe.
    this._heelLift = this.heelRise * H;
    this._moldedHeel = this.moldedHeel * H;
    const rigLift = this._heelLift || this._moldedHeel; // rig ankle raise (either heel)
    for (const def of JOINTS) {
      const node = new THREE.Object3D();
      node.name = `${this.name}:${def.name}`;
      node.position.set(def.offset[0] * H, def.offset[1] * H, def.offset[2] * H);
      if (rigLift && (def.name === 'ankle_L' || def.name === 'ankle_R')) {
        node.position.y += rigLift; // toes/toe are children → ride along
      }
      node.userData = { figure: this, jointName: def.name, def };
      this.nodes[def.name] = node;
      if (def.parent) this.nodes[def.parent].add(node);
      else this.group.add(node);
    }

    // Balance/contact sole corners for THIS figure: the shared tables scaled by
    // `soleScale` so the footprint matches the avatar's own shoe. The heel
    // stays put (z ≤ 0); everything ahead of the ankle scales toward it. The
    // toe-pad corners live in the toes joint's frame, so their scale acts on
    // the ankle-frame position (joint offset + corner) before converting back
    // — a strong shrink legally lands them slightly BEHIND the toes joint
    // (a short heeled shoe ends behind the rig's toe segment).
    const toesZ = JOINT_BY_NAME.toes_L.offset[2];
    const { front, width } = this.soleScale;
    const scaleFoot = (corners) => corners.map(([x, y, z]) => [x * width, y, z > 0 ? z * front : z]);
    const scaleToe = (corners) => corners.map(([x, y, z]) => [x * width, y, (toesZ + z) * front - toesZ]);
    this.footCorners = { _L: scaleFoot(FOOT_CORNERS_L), _R: scaleFoot(FOOT_CORNERS_R) };
    this.toeCorners = { _L: scaleToe(TOE_CORNERS_L), _R: scaleToe(TOE_CORNERS_R) };

    // The single neutral rest: the imported skeleton's own joint centers
    // (figure-local), estimated where its bone clusters meet. The body avatar
    // retarget and the endpoint roll both resolve against this, and the atlas
    // limb sub-tree is positioned by it. Computed before the skeleton bake so
    // the bones can be hung on the atlas nodes.
    const atlasRest = this.skeletonMesh ? this.#atlasLimbRest() : new Map();

    // --- Skeleton layer: imported anatomical mesh if available, else the
    // procedural bones in anatomy.js ---
    if (this.skeletonMesh) {
      this.#buildAtlasNodes(atlasRest);
      this.#buildMeshSkeleton();
    } else buildSkeleton(this);

    // Joint pick/display spheres (always raycastable; opacity follows skeleton layer).
    for (const def of JOINTS) {
      const r = def.endpoint ? 0.016 * H : 0.02 * H;
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), this.materials.joint.clone());
      s.userData = { figure: this, jointName: def.name, isPick: true };
      this.nodes[def.name].add(s);
      this.pickSpheres.push(s);
      this.jointSphereByName[def.name] = s;
    }

    // The single neutral rest: the canonical figure-local joint centers the
    // body avatar and the endpoint roll both resolve against (computed above as
    // `atlasRest`) so every layer references one object instead of re-estimating
    // inline. `rest` holds the (fragile, estimated) limb joints;
    // `endpointR`/`endpointS`/`endpointT` are filled by #alignEndpointGeometry
    // (the roll, uniform scale, and seat translation of each skeletal hand). A
    // frozen snapshot is the drift tripwire (see #assertCalibration).
    this.calibration = { rest: atlasRest, endpointR: {}, endpointS: {}, endpointT: {} };

    // Mesh-truth hand frames, filled by #buildMeshBody (null = rig-canonical:
    // palm along wrist-local +Z, fingers along -Y). See #measureHandMesh.
    this.handMesh = { L: null, R: null };

    // --- Body layer: imported clothed avatar if available, else the
    // procedural mannequin volumes ---
    if (this.bodyMesh) this.#buildMeshBody();
    else this.#buildBody();
    // Muscle layer: imported atlas muscles (share the skeleton's frame, so they
    // need it too), else the procedural bellies in anatomy.js.
    if (this.muscleMesh && this.skeletonMesh) this.#buildMeshMuscles();
    else buildMuscles(this);
    // De-splay the skeletal hands/feet onto the clothed body's orientation so
    // the three layers coincide at the extremities (see #alignEndpointGeometry).
    if (this.skeletonMesh && this.bodyMesh) this.#alignEndpointGeometry();
    // The foot's fit MOVES the forefoot out from under the toes node, so put the
    // MTP hinge back on the metatarsal heads before anything pivots about it —
    // #applyHeel's ball-break included.
    if (this.skeletonMesh) this.#reseatToesPivot();
    // A heeled figure: pitch the skeletal foot up at the heel so the bare bones
    // sit inside the shoe, draw the wedge, and (fake heel only) relocate the
    // balance corners to the raised, pitched foot.
    if ((this._heelLift || this._moldedHeel) && this.skeletonMesh) this.#applyHeel();
    // Squeeze the bare skeletal foot laterally into a shoe narrower than the atlas
    // foot (the foot analog of the hand desplay), so the little toe stops poking
    // out past the shoe. Post-fit, so the frozen calibration is unaffected.
    if (this.footNarrow !== 1 && this.skeletonMesh) this.#narrowFoot(this.footNarrow);
    // Both of those move the forefoot again — the heel pitch turns it about the
    // ball while the phalanges stay flat in the toe box, so the articulation it
    // leaves behind is a few mm from the one the ball was estimated on. Re-seat
    // on the final geometry (measured: the follower's MTP slip at −70° goes
    // 4.6 mm → 0.3, matching the flat-shoed leader). Skipped where neither ran,
    // since the first pass is then already exact.
    if (this.skeletonMesh && (this._heelLift || this._moldedHeel || this.footNarrow !== 1)) {
      this.#reseatToesPivot();
    }
    this.setLayers({ skeleton: false, body: true, muscle: false });
    // Tripwire: warn (don't block) if the live calibration has drifted from the
    // frozen snapshot in rigCalibration.js. The hard gate is dev-verify-calibration.mjs.
    this.#assertCalibration();
  }

  // The anatomy atlas holds the hand splayed (fingers fanned wide); the clothed
  // avatar carries them close, so the bare skeletal fingers overshoot the glove.
  // Build a per-finger-ray rotation (in the atlas frame, before scale/mirror)
  // that adducts index/ring/pinky toward the middle finger about the wrist base,
  // shrinking the fan by fraction `k`. Rotation is about the palm normal (pure
  // abduction, no flexion change). Returns { rot: Map<ray,Matrix4>, rayOf } or
  // null if the hand bones aren't named as expected. Since it operates on the
  // right-side atlas geometry before the mirror, the left hand tucks in for free.
  #handDesplayRotations(bones, k) {
    const rayOf = (name) => {
      const m = /([1-5])(?:st|nd|rd|th|d)_(?:metacarpal|finger)/i.exec(name || '');
      return m ? +m[1] : 0;
    };
    const wrist = bones.filter((b) => b.node === 'wrist');
    if (!wrist.length) return null;
    const sample = (b) => {
      const p = b.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 200));
      const out = [];
      for (let i = 0; i < p.count; i += step) out.push(new THREE.Vector3().fromBufferAttribute(p, i));
      return out;
    };
    const rays = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    const carpals = [];
    const all = [];
    for (const b of wrist) {
      const pts = sample(b);
      all.push(...pts);
      const r = rayOf(b.name);
      if (r) rays[r].push(...pts); else carpals.push(...pts);
    }
    if (!rays[3].length) return null; // need the middle finger as reference
    const centroid = (pts) => pts.reduce((c, p) => c.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const O = (carpals.length ? centroid(carpals) : centroid(all)); // fan origin at the wrist base
    const normal = pcaPlaneNormal(all).normal; // palm plane normal (atlas frame)
    const inPlane = (v) => v.clone().addScaledVector(normal, -v.dot(normal));
    const mid = inPlane(centroid(rays[3]).sub(O)).normalize();
    const rot = new Map();
    for (const r of [2, 4, 5]) { // index / ring / pinky toward middle; thumb & middle untouched
      if (!rays[r].length) continue;
      const dir = inPlane(centroid(rays[r]).sub(O)).normalize();
      let ang = Math.acos(THREE.MathUtils.clamp(dir.dot(mid), -1, 1));
      ang *= Math.sign(new THREE.Vector3().crossVectors(mid, dir).dot(normal)) || 1;
      const m = new THREE.Matrix4().makeTranslation(O.x, O.y, O.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(normal, -k * ang))
        .multiply(new THREE.Matrix4().makeTranslation(-O.x, -O.y, -O.z));
      rot.set(r, m);
    }
    return { rot, rayOf };
  }

  // Scale + settle (+ mirror) bringing an atlas-frame geometry into this
  // figure's local space. Shared by the skeleton and muscle bakes, which both
  // live in the skeleton's atlas frame; Tneg also mirrors X to build the left
  // side from the shipped right-side geometry.
  #atlasBakeTransforms() {
    const { atlasMinY, atlasHeight } = this.skeletonMesh;
    const s = this.height / atlasHeight;
    const settle = new THREE.Matrix4().makeTranslation(0, -atlasMinY * s, 0);
    const Tpos = settle.clone().multiply(new THREE.Matrix4().makeScale(s, s, s));
    const Tneg = settle.clone().multiply(new THREE.Matrix4().makeScale(-s, s, s)); // mirror
    return { Tpos, Tneg };
  }

  // Attach the imported atlas bones to our joint tree. Each bone is baked from
  // the shared atlas frame into a target joint node's local space (so it poses
  // with that joint), right-side bones are also mirrored across the sagittal
  // plane to build the left side, and everything landing on the same node +
  // material is merged into one mesh to keep the draw-call count low. Hand
  // fingers are also tucked from the atlas's wide fan (see #handDesplayRotations).
  #buildMeshSkeleton() {
    const { bones } = this.skeletonMesh;
    this.group.updateMatrixWorld(true);
    const { Tpos, Tneg } = this.#atlasBakeTransforms();
    // Atlas-frame rotations that tuck the fanned hand fingers together (applied
    // before T, so the mirror handles the left hand). Keyed by finger ray 1–5.
    const desplay = this.#handDesplayRotations(bones, HAND_DESPLAY);

    // `${node}|${material}` → [{ geom, name }, …]. The bone NAME is carried
    // through the merge so the rendered geometry stays addressable per bone
    // (see userData.boneRanges below) — landmarks.js selects verts by bone, and
    // a merged mesh with no name map would only be addressable per node.
    const groups = new Map();
    const stash = (nodeName, material, geom, name, side) => {
      const key = `${nodeName}|${material}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ geom, name, side });
    };

    for (const b of bones) {
      const isLimb = LIMB_BASES.has(b.node);
      // A finger ray's de-splay rotation (atlas frame), if any.
      const Rf = desplay && b.node === 'wrist' ? desplay.rot.get(desplay.rayOf(b.name)) : null;
      const targets = [];
      if (b.paired && isLimb) {
        targets.push([`${b.node}_R`, Tpos, false], [`${b.node}_L`, Tneg, true]);
      } else if (b.paired) {
        targets.push([b.node, Tpos, false], [b.node, Tneg, true]);
      } else {
        targets.push([b.node, Tpos, false]);
      }
      for (const [nodeName, T, mirror] of targets) {
        // Limb bones ride the atlas sub-tree (pivot about the anatomical joint);
        // everything else rides its rig node directly.
        const node = this.atlasNodes[nodeName] || this.nodes[nodeName];
        if (!node) continue;
        const g = b.geometry.clone();
        if (Rf) g.applyMatrix4(Rf); // adduct the finger in the atlas frame first
        // local = node⁻¹ · group · T  (bring the atlas-frame bone into the node)
        const X = node.matrixWorld.clone().invert().multiply(this.group.matrixWorld).multiply(T);
        g.applyMatrix4(X);
        if (mirror) reverseWinding(g);
        // `side` (null for an unpaired axial bone) lets labels.js name a bone
        // without its atlas ".r" tag and tell the mirrored copy from the source.
        stash(nodeName, b.material, g, b.name, b.paired ? (mirror ? 'L' : 'R') : null);
      }
    }

    for (const [key, parts] of groups) {
      const [nodeName, material] = key.split('|');
      const merged = mergeGeometries(parts.map((p) => p.geom), false);
      // Vertex ranges per source bone, in merge order — mergeGeometries
      // concatenates, so a running offset is exact. This is what lets a
      // landmark recipe say "the 3rd metacarpal" against a mesh that merged
      // ~40 bones for the draw-call budget.
      const boneRanges = [];
      let start = 0;
      for (const p of parts) {
        const count = p.geom.attributes.position.count;
        boneRanges.push({ name: p.name, start, count, side: p.side });
        start += count;
      }
      parts.forEach((p) => p.geom.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, this.materials[material]);
      mesh.userData.boneRanges = boneRanges;
      this.addMesh(nodeName, mesh, 'skeleton', true, this.atlasNodes[nodeName] || null);
    }
  }

  // Build the display-only atlas limb sub-tree (see this.atlasNodes). Each
  // seated joint gets an Object3D placed at the imported skeleton's own joint
  // center (`atlasRest`) and slaved to the rig joint's rotation every frame, so
  // the bones hung on it pivot about the anatomical joint and stay welded to
  // their neighbours through any bend. A whole limb chain must be seated
  // together (a bone welds to its neighbour only if both ride matching trees),
  // so this covers the complete arm chain scapula → shoulder → elbow → wrist
  // (the scapula stays a rig node — it anchors the chain and barely
  // articulates) and the complete leg chain hip → knee → ankle → toes, with
  // the pelvis as its rig anchor.
  #buildAtlasNodes(atlasRest) {
    this.group.updateMatrixWorld(true);
    const gInv = this.group.matrixWorld.clone().invert();
    const rigLocal = (name) => this.nodes[name].getWorldPosition(new THREE.Vector3()).applyMatrix4(gInv);
    // A heeled figure raises its rig ankle (and the toes riding it) by heelLift
    // so the shoe stands natively (see #build); the seated foot pivots must sit
    // in that same lifted frame — the retargeted shoe bones snap to the lifted
    // atlas centers (see #buildMeshBody's target()), so an unlifted seat would
    // pivot the foot below the shoe.
    const lifted = (name, v) => (v && this._heelLift && /^(ankle|toes)_/.test(name)
      ? v.clone().setY(v.y + this._heelLift) : v);
    // [seated base, parent base, parent is a rig node?]. Rest rotations are all
    // identity, so a parent's local axes equal the figure axes and the child's
    // local offset is a plain figure-local subtraction.
    // LEGS ONLY. The arm chain used to be seated here too, but its rig joints
    // now sit ON the anatomical centres (skeletonDef.js), so an arm atlas node
    // would be a zero-offset duplicate of its rig node — #seatNode falls
    // through to the rig node and the arm has ONE frame. That also collapses
    // handMesh's old split, where the palm's ORIENTATION was measured in the
    // rig wrist and its POSITION stored in the atlas wrist. The legs keep their
    // atlas sub-tree because their rig joints are still Drillis–Contini, which
    // the COG, the sole corners and the floor clamp all depend on.
    const chain = [
      ['hip', 'pelvis', true],
      ['knee', 'hip', false],
      ['ankle', 'knee', false],
      ['toes', 'ankle', false],
    ];
    for (const side of ['_L', '_R']) {
      for (const [base, par, parIsRig] of chain) {
        const name = `${base}${side}`;
        const parName = LIMB_BASES.has(par) ? `${par}${side}` : par;
        const center = lifted(name, atlasRest.get(name));
        const parent = parIsRig ? this.nodes[parName] : this.atlasNodes[parName];
        const parCenter = parIsRig ? rigLocal(parName) : lifted(parName, atlasRest.get(parName));
        if (!center || !parent || !parCenter) continue;
        const node = new THREE.Object3D();
        node.position.copy(center).sub(parCenter);
        node.userData = { figure: this, jointName: name, isAtlas: true };
        parent.add(node);
        this.atlasNodes[name] = node;
      }
    }
    this.group.updateMatrixWorld(true);
  }

  // Slave each atlas limb node to its rig joint's local rotation. The atlas tree
  // mirrors the rig chain order with identity rest rotations, so copying local
  // quaternions reproduces the rig's articulation about the anatomical pivots.
  // Called every frame (constraints/IK move rig joints directly) and from
  // setPose so headless/ghost paths stay in step without waiting for a frame.
  syncAtlasNodes() {
    for (const name in this.atlasNodes) {
      this.atlasNodes[name].quaternion.copy(this.nodes[name].quaternion);
    }
  }

  // Attach the imported atlas muscles to our joint tree. They live in the same
  // atlas frame as the bones, so they bake with the *skeleton's* atlas scale
  // (a limb-only muscle file has no full-body extent of its own). Each right-
  // side belly is placed and also mirrored to the left; muscles stay individual
  // (not merged) so each keeps its name and a distinct tint. A belly that only
  // rides one bone is parented rigidly to its joint node; one that crosses an
  // articulated joint (has an `insert`) is skinned between its two joints so it
  // stretches and bends as they move (see updateMuscleSkin).
  #buildMeshMuscles() {
    this.group.updateMatrixWorld(true);
    const { Tpos, Tneg } = this.#atlasBakeTransforms();
    // Resolve a limb base to a concrete side; central nodes pass through.
    const resolve = (base, side) => (LIMB_BASES.has(base) ? `${base}_${side}` : base);

    this.muscleMesh.muscles.forEach((m, i) => {
      const baseMat = i % 2 ? this.materials.muscleA : this.materials.muscleB;
      // Every shipped belly is right-side: place it (Tpos) and mirror to the
      // left (Tneg). The node side follows the copy's side.
      for (const [side, T, mirror] of [['R', Tpos, false], ['L', Tneg, true]]) {
        // Each belly COPY owns its material, so the Muscles panel can recolour
        // or fade one belly without touching the rest AND a sided body-part
        // highlight can light the left leg's bellies without the right's (the
        // two copies used to share one material, so whichever side was styled
        // last won and both legs showed it).
        const material = baseMat.clone();
        const nodeName = resolve(m.node, side);
        // Ride the same atlas limb sub-tree as the bones (see #seatNode) so a
        // belly stays welded to the bone it lies on when the joint bends,
        // instead of pivoting about the offset rig node while the bone doesn't.
        const node = this.#seatNode(nodeName);
        if (!node) continue;
        const insNode = m.insert ? this.#seatNode(resolve(m.insert, side)) : null;
        if (insNode) {
          // Skinned: bake into figure-local space and let updateMuscleSkin blend
          // each vertex between the two joints every frame. The highlight group
          // rides `m.ride` when a belly names one (the abdominal wall spans
          // pelvis→chest but belongs to the Torso part, not the Pelvis), else its
          // own node.
          const g = m.geometry.clone();
          g.applyMatrix4(T);
          if (mirror) reverseWinding(g);
          const rideName = m.ride ? resolve(m.ride, side) : nodeName;
          const mode = m.spread ? 'spread' : m.contact ? 'contact' : null;
          // A contact sheet may arise from more bones than the node it rides
          // (latissimus: chest + spine + pelvis) — see CONTACT_ORIGIN.
          const contactOpts = {
            originNodes: (m.contactOrigin ?? [])
              .map((base) => this.#seatNode(resolve(base, side))).filter(Boolean),
            window: m.contactWindow ?? [0, 1],
          };
          this.#addSkinnedMuscle(g, node, insNode, material, m.label, rideName, mode, contactOpts)
            .userData.muscleSide = side;
        } else {
          // Rigid: bake into the node's local frame and hang it there.
          const g = m.geometry.clone();
          const X = node.matrixWorld.clone().invert().multiply(this.group.matrixWorld).multiply(T);
          g.applyMatrix4(X);
          if (mirror) reverseWinding(g);
          const mesh = new THREE.Mesh(g, material);
          mesh.userData.muscleName = m.label;
          mesh.userData.muscleSide = side;
          mesh.userData.isMuscle = true;
          mesh.userData.muscleBaseColor = material.color.getHex();
          this.addMesh(nodeName, mesh, 'muscle', true, this.atlasNodes[nodeName] || null);
        }
      }
    });
  }

  // Register a bi-articular belly for two-bone skinning. `g` is baked in
  // figure-local (group) space. Anatomically a muscle's flesh is rigid on the
  // bone it lies on and only its tendon crosses a joint, so we split the weights
  // *at the articulating joint* the muscle spans — the deeper (child) of its two
  // nodes — rather than blending along the whole length. Flesh on the distal
  // side of that joint follows the child bone; flesh on the proximal side
  // follows the parent. The split is measured along the muscle's home-bone axis
  // (the bone its belly rides), which stays well-defined even when the two joint
  // pivots sit close together (adductors, lats) — a plain pivot-to-pivot ramp
  // degenerates there and lets the whole belly swing. Result: bellies stay
  // welded to their bone and only the short crossing band deforms. Each frame
  // updateMuscleSkin re-blends the baked positions/normals by that weight. The
  // mesh hangs off `group` (not a joint node) so its own frame never moves — all
  // motion comes through the two joints, keeping the skin correct even as the
  // whole dancer translates or turns.
  // `mode` picks how the weights are laid out: null = the axial split at the
  // crossed joint (nearly every belly), 'spread' = a full-length ramp (the
  // abdominal wall), 'contact' = by which of the two bones the tissue lies on.
  // `contactOpts` (contact mode only): `originNodes` widens what counts as
  // nodeA's bone for the distance test — the belly still FOLLOWS nodeA alone —
  // and `window` remaps the contact ratio (see #contactWeights).
  #addSkinnedMuscle(g, nodeA, nodeB, material, label, originNode, mode = null, contactOpts = {}) {
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const count = pos.count;
    const gInv = _gInv.copy(this.group.matrixWorld).invert();
    const a = new THREE.Vector3().setFromMatrixPosition(nodeA.matrixWorld).applyMatrix4(gInv);
    const b = new THREE.Vector3().setFromMatrixPosition(nodeB.matrixWorld).applyMatrix4(gInv);
    const weight = new Float32Array(count);
    const v = new THREE.Vector3();
    if (mode === 'contact' && this.#contactWeights(pos, nodeA, nodeB, gInv, weight,
      contactOpts.originNodes, contactOpts.window)) {
      // Weights written by #contactWeights. It returns false — and the axial
      // split below takes over — when either bone has no geometry to measure
      // against (the skeleton GLB failed to load).
    } else if (mode === 'spread') {
      // Broad trunk sheet (the abdominal wall) that spans BOTH joints rather than
      // lying on one bone and crossing at a tendon: shear the whole belly
      // progressively from the proximal joint (nodeA, the pelvis) to the distal
      // (nodeB, the chest). Trunk axial rotation — tango dissociation — accrues
      // across the whole lumbar span, so a full-length weight ramp is what makes
      // the obliques stretch on one side and shorten on the other as the chest
      // turns over the pelvis. The localized joint-split band below leaves this
      // sheet almost rigid (nearly every vertex sits below the crossed joint, so
      // it follows the near bone and the twisting joint above it barely reaches
      // the flesh). Weight runs 0 at the belly's nodeA end → 1 at its nodeB end,
      // measured along the joint-to-joint axis and normalized over the belly's
      // own extent, so its two attachments anchor to their bones and the middle
      // shears.
      const axis = new THREE.Vector3().subVectors(b, a);
      axis.multiplyScalar(1 / Math.max(axis.length(), 1e-6));
      const sArr = new Float32Array(count);
      let pMin = Infinity, pMax = -Infinity;
      for (let i = 0; i < count; i++) {
        const p = v.fromBufferAttribute(pos, i).sub(a).dot(axis);
        sArr[i] = p;
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
      }
      const span = Math.max(pMax - pMin, 1e-6);
      for (let i = 0; i < count; i++) {
        const t = THREE.MathUtils.clamp((sArr[i] - pMin) / span, 0, 1);
        weight[i] = t * t * (3 - 2 * t); // smoothstep, 0 at nodeA end → 1 at nodeB
      }
    } else {
      // The muscle spans the deeper (child) of its two joints. Pick the crossed
      // joint pivot, the home-bone axis to measure along, and how the distal-side
      // weight maps onto "blend toward nodeB".
      // The two branches measure along DIFFERENT axes on purpose, and it is not
      // an inconsistency — it was tried as one and is much worse. For a belly
      // riding nodeA's bone and crossing down to nodeB (child === nodeB), the
      // a→b line IS that bone. Switching it to the crossed joint's distal bone
      // breaks every trunk→limb muscle, because a hanging limb runs PARALLEL to
      // the torso: measured along the humerus, latissimus's lumbar origin
      // projects further "distal" (+189 mm) than its own humeral insertion, so
      // 71% of the sheet — the iliac end — welded itself to the arm. Along a→b
      // (chest→shoulder, mediolateral) the lateral-most vertices really are the
      // humeral insertion. A NEGATIVE sMax here means the belly stops short of
      // the pivot, which the transition window below handles; it does not mean
      // the axis is wrong.
      const child = this.#deeperJointNode(nodeA, nodeB);
      let cross, home, distalIsB;
      if (child === nodeB) {
        cross = b;                                     // belly on nodeA's bone (a→b)
        home = new THREE.Vector3().subVectors(b, a);
        distalIsB = true;                              // past the joint → nodeB
      } else {
        cross = a;                                     // belly on nodeA's own bone
        home = this.#distalBoneDir(nodeA, gInv) || new THREE.Vector3().subVectors(a, b);
        distalIsB = false;                             // past the joint → nodeA
      }
      const boneLen = Math.max(home.length(), 1e-6);
      home.multiplyScalar(1 / boneLen);
      // Pass 1: signed distance of each vertex from the crossed joint along the
      // home-bone axis (s > 0 on the distal / child-bone side), and how far the
      // muscle reaches on each side.
      const sArr = new Float32Array(count);
      let sMin = Infinity, sMax = -Infinity;
      for (let i = 0; i < count; i++) {
        const s = v.fromBufferAttribute(pos, i).sub(cross).dot(home);
        sArr[i] = s;
        if (s < sMin) sMin = s;
        if (s > sMax) sMax = s;
      }
      // How much flesh actually sits on each side of the pivot. Tissue reaching
      // less than REACH past it is a sliver, not an attachment: pectineus clears
      // the hip by 1.7 mm, and treating that as its proximal anchor collapsed
      // the band to 1.4 mm — a knife edge that let the whole muscle ride the
      // femur while the weight range still READ a healthy 0..1. So a belly is
      // only "straddling" on a side it genuinely reaches.
      const REACH = 0.02 * boneLen;
      const hasDistal = sMax > REACH;
      const hasProx = sMin < -REACH;
      // Transition half-width: a fraction of the bone, but never wider than the
      // shorter side reaches, so the short tendon side saturates to full weight
      // (otherwise it never fully commits to its bone and tears away at the joint).
      let band = 0.16 * boneLen;
      if (hasDistal) band = Math.min(band, 0.85 * sMax);
      if (hasProx) band = Math.min(band, -0.85 * sMin);
      band = Math.max(band, 1e-4);
      // Where the transition window SITS. It belongs at the joint — a muscle's
      // flesh is rigid on its bone and only the crossing tendon deforms — and
      // stays there whenever the belly has real flesh both sides, so a normally
      // seated belly is bit-identical to before. When it does NOT straddle, the
      // window must slide onto the geometry: narrowing alone cannot help,
      // because a band centred on the pivot has nothing to narrow TOWARD. That
      // was the single cause behind 44 of 106 bellies never saturating — the
      // quadriceps stop ~7 cm short of the knee (the atlas ships no patellar
      // tendon) and the calf ~13 cm short of the ankle (no Achilles), so every
      // vertex fell on one side of the ramp at weight 0 and the group stayed
      // welded to the wrong bone through a 145° bend; the adductors are the same
      // failure mirrored, starting ~2 cm BELOW the hip and capping at 0.28.
      // Sliding puts the belly's last `band` of tissue onto the far bone, which
      // is where its tendon would have run had the atlas shipped one.
      // A slid window must also FIT the belly: parked against one end, a window
      // wider than the belly runs off the other, and that end never reaches full
      // weight either (piriformis, a short strap, came out at 0..0.745 — its
      // sacral origin only three-quarters committed to the pelvis). Half the
      // belly's own span is the widest that can saturate both ends.
      const half = Math.max(0.5 * (sMax - sMin), 1e-4);
      let c = 0;
      if (!hasDistal && !hasProx) {                                 // tiny belly astride it
        c = 0.5 * (sMin + sMax);
        band = half;
      } else if (!hasDistal) {                                      // stops short of the joint
        band = Math.min(band, half);
        c = Math.min(0, sMax - band);
      } else if (!hasProx) {                                        // starts past the joint
        band = Math.min(band, half);
        c = Math.max(0, sMin + band);
      }
      // Pass 2: smoothstep across the window, mapped to "blend toward nodeB".
      for (let i = 0; i < count; i++) {
        const t = THREE.MathUtils.clamp((sArr[i] - c + band) / (2 * band), 0, 1);
        const distal = t * t * (3 - 2 * t);
        weight[i] = distalIsB ? distal : 1 - distal;
      }
    }
    const bindPos = new Float32Array(pos.array);
    const bindNrm = new Float32Array(nrm.array);
    // Inverse of each joint's figure-local matrix at bind: brings a baked vertex
    // into the joint's frame so the joint's later motion can carry it.
    const invA = new THREE.Matrix4().multiplyMatrices(gInv, nodeA.matrixWorld).invert();
    const invB = new THREE.Matrix4().multiplyMatrices(gInv, nodeB.matrixWorld).invert();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.frustumCulled = false; // vertices leave the baked bounds as joints move
    mesh.userData.muscleName = label;
    mesh.userData.isMuscle = true;
    mesh.userData.muscleBaseColor = material.color.getHex();
    mesh.userData.skinNode = originNode; // highlight groups it with this joint
    this.group.add(mesh);
    this.layerMeshes.muscle.push(mesh);
    this._skinMuscles.push({ mesh, nodeA, nodeB, weight, bindPos, bindNrm, invA, invB });
    return mesh;
  }

  // Skin weights from CONTACT: each vertex is shared between the two bones in
  // proportion to how close it lies to each (weight → nodeB = dA / (dA + dB),
  // smoothstepped), so tissue resting on a bone is glued to it and what lies
  // between shears. It needs no axis at all, which is the point — the axial
  // split cannot serve a fan like gluteus maximus, half of whose origin sits
  // below the joint it crosses (see CONTACT_SHEETS in skeletonMesh.js for the
  // measurements). Writes into `weight` and returns true, or returns false when
  // either bone has no geometry to measure against.
  // `originNodes` pools further bones into nodeA's side of the test, for a sheet
  // whose origin spreads past the one node it rides (latissimus arises from the
  // lumbar spine and iliac crest as well as the thorax). Without them that tissue
  // is "far from both bones" and the ratio hands a share of it to the limb.
  //
  // `window` = [lo, hi] remaps the contact ratio before the smoothstep: at or
  // below `lo` a vertex is wholly nodeA's, at or above `hi` wholly nodeB's. The
  // default [0, 1] is the plain ratio. It exists for a sheet that lies over OTHER
  // MUSCLE rather than on bone (latissimus sits 10-30 mm off the ribs across most
  // of the back): the plain ratio reads that stand-off as a share of the limb,
  // and a small share of a 170° swing is centimetres — straight through the ribs.
  #contactWeights(pos, nodeA, nodeB, gInv, weight, originNodes = [], window = [0, 1]) {
    const [lo, hi] = window;
    const cloudsA = [nodeA, ...originNodes.filter((n) => n !== nodeA)]
      .map((n) => this.#boneCloud(n, gInv)).filter((c) => c.length);
    const cloudB = this.#boneCloud(nodeB, gInv);
    if (!cloudsA.length || !cloudB.length) return false;
    const nearest = (p, cloud) => {
      let best = Infinity;
      for (let k = 0; k < cloud.length; k += 3) {
        const dx = p.x - cloud[k], dy = p.y - cloud[k + 1], dz = p.z - cloud[k + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      let dA = Infinity;
      for (const c of cloudsA) dA = Math.min(dA, nearest(v, c));
      const dB = nearest(v, cloudB);
      const r = dA / Math.max(dA + dB, 1e-9); // 1 = lying on nodeB's bone
      const t = THREE.MathUtils.clamp((r - lo) / Math.max(hi - lo, 1e-6), 0, 1);
      weight[i] = t * t * (3 - 2 * t);
    }
    return true;
  }

  // The bone surface hanging on a joint node, as a flat xyz array in
  // figure-local space at bind. Sub-sampled to ~3000 points: a nearest-point
  // search against every vertex of a pelvis, per belly vertex, per side, is load
  // time nobody asked for, and the coarse cloud costs almost nothing — measured
  // on gluteus maximus, the origin holds to 1.1 mm against 0.9 mm for a cloud
  // five times denser. Cached per node; both sides measure against one pelvis.
  #boneCloud(node, gInv) {
    this._boneClouds ??= new Map();
    let cloud = this._boneClouds.get(node);
    if (cloud) return cloud;
    const meshes = node.children.filter((c) => c.isMesh && c.userData.boneRanges);
    const total = meshes.reduce((n, m) => n + m.geometry.attributes.position.count, 0);
    const step = Math.max(1, Math.floor(total / 3000));
    const out = [];
    const v = new THREE.Vector3();
    const M = new THREE.Matrix4();
    for (const mesh of meshes) {
      M.multiplyMatrices(gInv, mesh.matrixWorld);
      const p = mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; i += step) {
        v.fromBufferAttribute(p, i).applyMatrix4(M);
        out.push(v.x, v.y, v.z);
      }
    }
    cloud = Float32Array.from(out);
    this._boneClouds.set(node, cloud);
    return cloud;
  }

  // The deeper (child) of two hierarchy-adjacent joint nodes — the joint the
  // muscle spanning them actually crosses.
  #deeperJointNode(nodeA, nodeB) {
    for (let n = nodeA.parent; n; n = n.parent) if (n === nodeB) return nodeA;
    return nodeB;
  }

  // Figure-local direction from a joint to its distal child joint(s), i.e. along
  // the bone it carries; null if it has no joint children. Used as the home-bone
  // axis when a muscle's belly rides this joint's own bone.
  // Two kinds of child carry a jointName but are NOT the next bone down, and
  // averaging them in corrupts the length this returns:
  //   - the node's OWN pick sphere, which sits at zero offset and so halves the
  //     mean (shoulder_R read a 151 mm humerus for a 303 mm bone, and that fed
  //     straight into `band = 0.16 * boneLen`);
  //   - the parallel ATLAS node of a seated limb joint, which duplicates a child
  //     the rig tree already contributes (rig pelvis carries both hips twice).
  // So count only real joint children from the SAME tree as `node`.
  #distalBoneDir(node, gInv) {
    const here = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld).applyMatrix4(gInv);
    const wantAtlas = node.userData?.isAtlas === true;
    const acc = new THREE.Vector3();
    let n = 0;
    for (const ch of node.children) {
      if (!ch.userData || !ch.userData.jointName) continue;
      if (ch.userData.isPick) continue;
      if ((ch.userData.isAtlas === true) !== wantAtlas) continue;
      acc.add(new THREE.Vector3().setFromMatrixPosition(ch.matrixWorld).applyMatrix4(gInv));
      n++;
    }
    return n ? acc.multiplyScalar(1 / n).sub(here) : null;
  }

  // Re-skin every bi-articular muscle from its two joints' current transforms.
  // Called each frame while the muscle layer is visible (skipped otherwise, so
  // it costs nothing in the skeleton/body views). Uses dual-quaternion skinning
  // (DQS), not linear blend: the two joint deltas are rigid transforms, so
  // blending them as dual quaternions rotates each vertex along the shortest
  // arc and preserves volume. Plain linear blending collapses the belly toward
  // the joint axis at deep bends ("candy-wrapper"), which made multi-joint
  // muscles sink through the bone or pop off. Figure-local space; assumes
  // group.matrixWorld is already current.
  updateMuscleSkin() {
    if (!this._skinMuscles.length || !this.layers?.muscle || !this.group.visible) return;
    const gInv = _gInv.copy(this.group.matrixWorld).invert();
    for (const sm of this._skinMuscles) {
      // Rigid delta of each joint since bind, in figure-local space.
      const dA = _dA.multiplyMatrices(gInv, sm.nodeA.matrixWorld).multiply(sm.invA);
      const dB = _dB.multiplyMatrices(gInv, sm.nodeB.matrixWorld).multiply(sm.invB);
      dA.decompose(_tA, _qA, _scl);
      dB.decompose(_tB, _qB, _scl);
      // Unit dual quaternion for each delta: real = rotation, dual encodes the
      // translation as dual = 0.5 * (t as pure quat) * rotation.
      const arx = _qA.x, ary = _qA.y, arz = _qA.z, arw = _qA.w;
      let brx = _qB.x, bry = _qB.y, brz = _qB.z, brw = _qB.w;
      const adx = 0.5 * (_tA.x * arw + _tA.y * arz - _tA.z * ary);
      const ady = 0.5 * (-_tA.x * arz + _tA.y * arw + _tA.z * arx);
      const adz = 0.5 * (_tA.x * ary - _tA.y * arx + _tA.z * arw);
      const adw = 0.5 * (-_tA.x * arx - _tA.y * ary - _tA.z * arz);
      let bdx = 0.5 * (_tB.x * brw + _tB.y * brz - _tB.z * bry);
      let bdy = 0.5 * (-_tB.x * brz + _tB.y * brw + _tB.z * brx);
      let bdz = 0.5 * (_tB.x * bry - _tB.y * brx + _tB.z * brw);
      let bdw = 0.5 * (-_tB.x * brx - _tB.y * bry - _tB.z * brz);
      // Blend the two along the shortest arc: flip B into A's hemisphere.
      if (arx * brx + ary * bry + arz * brz + arw * brw < 0) {
        brx = -brx; bry = -bry; brz = -brz; brw = -brw;
        bdx = -bdx; bdy = -bdy; bdz = -bdz; bdw = -bdw;
      }
      const geom = sm.mesh.geometry;
      const parr = geom.attributes.position.array;
      const narr = geom.attributes.normal.array;
      const { bindPos, bindNrm, weight } = sm;
      for (let i = 0, j = 0; i < weight.length; i++, j += 3) {
        const wb = weight[i];
        const wa = 1 - wb;
        // Blend real + dual parts, then renormalize the real part.
        let rx = arx * wa + brx * wb, ry = ary * wa + bry * wb;
        let rz = arz * wa + brz * wb, rw = arw * wa + brw * wb;
        let dx = adx * wa + bdx * wb, dy = ady * wa + bdy * wb;
        let dz = adz * wa + bdz * wb, dw = adw * wa + bdw * wb;
        const inv = 1 / (Math.hypot(rx, ry, rz, rw) || 1);
        rx *= inv; ry *= inv; rz *= inv; rw *= inv;
        dx *= inv; dy *= inv; dz *= inv; dw *= inv;
        // Translation = 2 * (dual * conjugate(real)), vector part.
        const tx = 2 * (rw * dx - rx * dw + ry * dz - rz * dy);
        const ty = 2 * (rw * dy - ry * dw + rz * dx - rx * dz);
        const tz = 2 * (rw * dz - rz * dw + rx * dy - ry * dx);
        // Rotate the bound position by the blended real quaternion, add t.
        const px = bindPos[j], py = bindPos[j + 1], pz = bindPos[j + 2];
        let ix = rw * px + ry * pz - rz * py;
        let iy = rw * py + rz * px - rx * pz;
        let iz = rw * pz + rx * py - ry * px;
        let iw = -rx * px - ry * py - rz * pz;
        parr[j] = ix * rw + iw * -rx + iy * -rz - iz * -ry + tx;
        parr[j + 1] = iy * rw + iw * -ry + iz * -rx - ix * -rz + ty;
        parr[j + 2] = iz * rw + iw * -rz + ix * -ry - iy * -rx + tz;
        // Rotate the bound normal by the same quaternion (no translation).
        const nx = bindNrm[j], ny = bindNrm[j + 1], nz = bindNrm[j + 2];
        ix = rw * nx + ry * nz - rz * ny;
        iy = rw * ny + rz * nx - rx * nz;
        iz = rw * nz + rx * ny - ry * nx;
        iw = -rx * nx - ry * ny - rz * nz;
        narr[j] = ix * rw + iw * -rx + iy * -rz - iz * -ry;
        narr[j + 1] = iy * rw + iw * -ry + iz * -rx - ix * -rz;
        narr[j + 2] = iz * rw + iw * -rz + ix * -ry - iy * -rx;
      }
      geom.attributes.position.needsUpdate = true;
      geom.attributes.normal.needsUpdate = true;
    }
  }

  // Estimate our limb joints' positions in the *atlas* rest pose from the loaded
  // skeleton bones, so the clothed body can be retargeted onto the same pose the
  // skeleton and muscle layers show. Those layers render the atlas rest (arms
  // slightly abducted, hands/feet splayed out); the rig's own rest is
  // arms-straight-down, so without this the bones and muscle poke ~10 cm outside
  // the clothed skin at the hands. Each joint is located where two adjacent bone
  // clusters meet — the mean of the child cluster's vertices nearest the parent
  // cluster's centroid — which is robust regardless of how the limb hangs.
  // Endpoints (hand, toe) have no cluster of their own, so they take the far tip
  // of the distal cluster. Returns a Map of joint name → figure-local Vector3
  // (empty if no skeleton is loaded, in which case the body falls back to the
  // rig rest). Uses the same scale/settle/mirror as #buildMeshSkeleton's bake.
  #atlasLimbRest() {
    const out = new Map();
    if (!this.skeletonMesh) return out;
    const { bones, atlasMinY, atlasHeight } = this.skeletonMesh;
    const s = this.height / atlasHeight;
    const settleY = -atlasMinY * s;
    const verts = new Map(); // node name → [Vector3, …] in figure-local atlas space
    const gather = (name, geom, mirror) => {
      let a = verts.get(name); if (!a) { a = []; verts.set(name, a); }
      const p = geom.attributes.position;
      for (let i = 0; i < p.count; i += 3) { // sampled: joint estimates don't need every vert
        const x = p.getX(i) * s * (mirror ? -1 : 1);
        a.push(new THREE.Vector3(x, p.getY(i) * s + settleY, p.getZ(i) * s));
      }
    };
    for (const b of bones) {
      const isLimb = LIMB_BASES.has(b.node);
      if (b.paired && isLimb) { gather(`${b.node}_R`, b.geometry, false); gather(`${b.node}_L`, b.geometry, true); }
      else if (b.paired) { gather(b.node, b.geometry, false); gather(b.node, b.geometry, true); }
      else gather(b.node, b.geometry, false);
    }
    const centroid = (a) => a.reduce((c, v) => c.add(v), new THREE.Vector3()).multiplyScalar(1 / a.length);
    // Mean of the K cluster verts nearest (or farthest) from a reference point.
    const extremeMean = (a, ref, frac, farthest) => {
      const scored = a.map((v) => [v.distanceToSquared(ref), v]);
      scored.sort((x, y) => (farthest ? y[0] - x[0] : x[0] - y[0]));
      const k = Math.max(1, Math.floor(scored.length * frac));
      const c = new THREE.Vector3();
      for (let i = 0; i < k; i++) c.add(scored[i][1]);
      return c.multiplyScalar(1 / k);
    };
    const PARENT = { shoulder: 'chest', elbow: 'shoulder', wrist: 'elbow', hip: 'pelvis', knee: 'hip', ankle: 'knee', toes: 'ankle' };
    // The two joints whose PARENT is a torso cluster, located from the child
    // side instead. "Verts of this bone nearest the parent cluster's centroid"
    // is a good rule while the parent is a limb bone — the humerus's centroid
    // sits up the arm, so the nearest radius/ulna verts really are the elbow.
    // It fails badly for the shoulder and the hip, whose parents are the whole
    // chest and the whole pelvis: those centroids lie far away and medial, and
    // they drag the estimate down and inward. Measured against the atlas's own
    // bones, the error was 74 mm at the shoulder (estimated upper arm 259 mm
    // against a real humerus of 333 mm) and 56 mm at the hip (thigh 418 mm
    // against a femur of 474 mm) — and since this rest positions the atlas
    // display tree AND drives the body retarget, every layer was pivoting the
    // limb about a joint centre that far from the real head of the bone.
    // Both are instead the far end of their OWN bone, away from the next joint
    // down the chain: the head of the humerus, the head of the femur.
    const FROM_CHILD = { shoulder: 'elbow', hip: 'knee' };
    for (const side of ['_L', '_R']) {
      for (const [base, parBase] of Object.entries(PARENT)) {
        const a = verts.get(`${base}${side}`);
        if (!a || !a.length) continue;
        const childBase = FROM_CHILD[base];
        if (childBase) {
          const ch = verts.get(`${childBase}${side}`);
          if (ch && ch.length) {
            out.set(`${base}${side}`, extremeMean(a, centroid(ch), 0.10, true));
            continue;
          }
        }
        const par = verts.get(LIMB_BASES.has(parBase) ? `${parBase}${side}` : parBase);
        out.set(`${base}${side}`, par && par.length ? extremeMean(a, centroid(par), 0.05, false) : centroid(a));
      }
      const wrist = verts.get(`wrist${side}`), elbow = verts.get(`elbow${side}`);
      if (wrist && elbow) out.set(`hand${side}`, extremeMean(wrist, centroid(elbow), 0.03, true));
      const toes = verts.get(`toes${side}`), ankle = verts.get(`ankle${side}`);
      if (toes && ankle) out.set(`toe${side}`, extremeMean(toes, centroid(ankle), 0.03, true));
    }
    return out;
  }

  // Serialize this figure's live calibration in a scale-free form for baking:
  // rest joint centers as fractions of stature, endpoint rolls as quaternion
  // arrays. Consumed by scripts/build-calibration.mjs to write rigCalibration.js.
  calibrationJSON() {
    const H = this.height;
    const rest = {};
    for (const [k, v] of this.calibration.rest) rest[k] = [v.x / H, v.y / H, v.z / H];
    const endpointR = {};
    for (const [k, q] of Object.entries(this.calibration.endpointR)) {
      endpointR[k] = [q.x, q.y, q.z, q.w];
    }
    const endpointS = {};
    for (const [k, s] of Object.entries(this.calibration.endpointS)) endpointS[k] = s;
    const endpointT = {};
    for (const [k, t] of Object.entries(this.calibration.endpointT)) {
      endpointT[k] = [t.x / H, t.y / H, t.z / H];
    }
    return { rest, endpointR, endpointS, endpointT };
  }

  // Tripwire: compare the live calibration to the frozen snapshot for this
  // avatar and console.error (never throw) if anything has drifted past
  // tolerance — a hand-off to the developer to re-run `npm run bake:rig`. No
  // frozen entry (procedural/ghost figures, or before the first bake) → no-op.
  #assertCalibration() {
    const frozen = this.bodyKey ? RIG_CALIBRATION[this.bodyKey] : null;
    if (!frozen) return;
    const H = this.height;
    const TOL_MM = 2, TOL_DEG = 0.5;
    const issues = [];
    const _v = new THREE.Vector3();
    for (const [k, f] of Object.entries(frozen.rest || {})) {
      const live = this.calibration.rest.get(k);
      if (!live) continue;
      const mm = live.distanceTo(_v.set(f[0] * H, f[1] * H, f[2] * H)) * 1000;
      if (mm > TOL_MM) issues.push(`${k} ${mm.toFixed(1)}mm`);
    }
    const _q = new THREE.Quaternion();
    for (const [k, f] of Object.entries(frozen.endpointR || {})) {
      const live = this.calibration.endpointR[k];
      if (!live) continue;
      _q.set(f[0], f[1], f[2], f[3]);
      const deg = 2 * Math.acos(Math.min(1, Math.abs(live.dot(_q)))) / DEG;
      if (deg > TOL_DEG) issues.push(`${k} ${deg.toFixed(2)}°`);
    }
    for (const [k, f] of Object.entries(frozen.endpointT || {})) {
      const live = this.calibration.endpointT[k];
      if (!live) continue;
      const mm = live.distanceTo(_v.set(f[0] * H, f[1] * H, f[2] * H)) * 1000;
      if (mm > TOL_MM) issues.push(`${k}T ${mm.toFixed(1)}mm`);
    }
    for (const [k, f] of Object.entries(frozen.endpointS || {})) {
      const live = this.calibration.endpointS[k];
      if (live == null) continue;
      if (Math.abs(live - f) > 0.01) issues.push(`${k}S ${(live - f).toFixed(3)}`);
    }
    if (issues.length) {
      console.error(`[rig] calibration for "${this.bodyKey}" is stale (${issues.join(', ')}) — re-run: npm run bake:rig`);
    }
  }

  // Attach an imported clothed avatar (Microsoft Rocketbox: one skinned mesh
  // on a 3ds Max Biped rig, in bind pose) by re-parenting its bones onto our
  // joint nodes — the same idea as the skeleton/muscle bake, but keeping the
  // mesh's own skin weights so the surface deforms smoothly at every joint.
  //
  // For each bone in BODY_RETARGET we build a constant local matrix under its
  // target joint node: snap the bone origin to the joint, rotate its bind
  // orientation by the shortest arc that aligns its bind bone direction with
  // our rest segment direction (the bind pose is a near-A-pose; our rest is
  // arms-down, so this also drops the arms), and scale — uniformly by
  // figure/avatar height, plus axially so long bones reach the child joint,
  // plus a world-Y "squash" on the feet so shoe soles (heels included) graze
  // y = 0 at rest instead of sinking through the floor. Unmapped bones
  // (fingers, face, clavicles, skirt helpers) keep their original local
  // transform and simply ride their re-parented ancestor. The skinned mesh
  // itself hangs off `group` in the default 'attached' bind mode, which
  // cancels the mesh's own transform — every motion comes through the bones,
  // on the GPU, with no per-frame CPU work.
  #buildMeshBody() {
    const H = this.height;
    const src = this.bodyMesh;
    const s0 = H / src.height;

    // Our joints' rest positions in figure-local space (rest rotations are
    // all identity, so rest world = accumulated offsets — no scene reads).
    const rest = {};
    for (const def of JOINTS) {
      const p = def.parent ? rest[def.parent].clone() : new THREE.Vector3();
      rest[def.name] = p.add(new THREE.Vector3(...def.offset).multiplyScalar(H));
    }
    // The heel lifts the ankle and everything riding it; mirror the node-build
    // lift here so rest/target/jointY agree with the actual foot node heights.
    const HEEL_NODES = new Set(['ankle_L', 'ankle_R', 'toes_L', 'toes_R', 'toe_L', 'toe_R']);
    if (this._heelLift) for (const n of HEEL_NODES) rest[n].y += this._heelLift;
    // Retarget onto the *atlas* rest pose where it's known (limb joints), so the
    // clothed body coincides with the skeleton/muscle layers; the torso and any
    // joint the atlas can't locate fall back to the rig rest. `target` is the
    // position each bone is snapped/aligned to; the offset from its rig node is
    // baked into the bone's local matrix so posing still pivots about the node.
    const atlas = this.calibration.rest; // the single neutral rest (computed in #build)
    const targetBase = (name) => {
      const p = atlas.get(name) || rest[name];
      return this._heelLift && HEEL_NODES.has(name) && atlas.has(name)
        ? p.clone().setY(p.y + this._heelLift) : p;
    };
    // Shoe stand-height lift (filled below once bones are known): our ankle node
    // sits at the anthropometric malleolus (~7 cm), but the avatar's shoe bone
    // sits ~10 cm up, so dropping it onto our ankle sinks the sole ~3 cm and the
    // squash below flattens the whole shoe (toe box included) to compensate.
    // Instead, raise the shoe's ankle so it stands at its natural height (the
    // calf stretches to meet it, the squash relaxes toward 1); `targetBase` stays
    // the true node position so the origin offset carries the lift.
    const shoeLift = {}; // ankle joint name -> lift (m)
    const target = (name) => {
      const p = targetBase(name);
      return shoeLift[name] ? p.clone().setY(p.y + shoeLift[name]) : p;
    };

    const avatar = cloneSkinned(src.scene);
    avatar.updateMatrixWorld(true);

    // Bones by normalized name, and each bone's bind world matrix. The scene
    // is loaded in bind pose, so node matrixWorld *is* the Y-up bind transform.
    // (Don't invert the inverse-bind matrices instead: those live in the
    // skinned mesh's Z-up local frame, not scene space.)
    const boneByName = new Map();
    avatar.traverse((o) => {
      if (o.isBone || normBoneName(o.name).startsWith('bip01')) boneByName.set(normBoneName(o.name), o);
    });
    const bindWorld = new Map();
    for (const b of boneByName.values()) bindWorld.set(b, b.matrixWorld.clone());
    const bindPos = (bone) => new THREE.Vector3().setFromMatrixPosition(bindWorld.get(bone));

    // Biped side letter → our joint suffix, resolved by bind world position so
    // a mirrored export still lands on the correct side.
    let sideFor = { l: '_L', r: '_R' };
    const lThigh = boneByName.get('bip01lthigh');
    if (lThigh && (bindPos(lThigh).x > 0) !== (rest.hip_L.x > 0)) sideFor = { l: '_R', r: '_L' };

    // How far to raise each shoe so it stands at (near) its natural height: the
    // amount that would bring the foot squash `lam` to SHOE_STAND (1 = no squash
    // at all, the shoe stands full height above a taller-than-skeletal ankle;
    // lower keeps some squash but sits the shoe closer to the skeletal foot).
    const SHOE_STAND = 1.0;
    for (const s of ['l', 'r']) {
      const footBone = boneByName.get(`bip01${s}foot`);
      const ankleName = `ankle${sideFor[s]}`;
      if (!footBone) continue;
      const sink = bindPos(footBone).y * s0 - targetBase(ankleName).y; // sole sink if placed rigidly
      shoeLift[ankleName] = Math.max(0, SHOE_STAND * (bindPos(footBone).y * s0) - targetBase(ankleName).y);
      if (sink <= 0) shoeLift[ankleName] = 0; // already heeled / no sink → leave alone
    }

    // Expand the retarget table to both sides and resolve alignment rotations
    // (inherit entries reuse an earlier bone's rotation, e.g. foot ← calf).
    const plans = new Map(); // bone object → plan
    const alignR = new Map(); // bone name (expanded) → THREE.Quaternion
    for (const s of ['l', 'r']) {
      for (const tpl of BODY_RETARGET) {
        const sided = tpl.bone.includes('S'); // side placeholder
        if (!sided && s === 'r') continue; // central bones: process once
        const sub = (name) => name && name.replace('S', s);
        const suffix = sided ? sideFor[s] : '';
        const boneName = sub(tpl.bone);
        const jointName = `${tpl.joint}${suffix}`;
        const bone = boneByName.get(boneName);
        // Ride the same atlas limb sub-tree as the skeleton bones and muscles
        // (#seatNode) where the joint is seated, so the clothed limb pivots about
        // the anatomical joint centre too and stays welded to the skeleton
        // through any bend; unseated joints (torso) keep their rig node.
        const node = this.#seatNode(jointName);
        if (!bone || !node) continue;
        const q = bindPos(bone);
        const rotBind = new THREE.Quaternion();
        bindWorld.get(bone).decompose(new THREE.Vector3(), rotBind, new THREE.Vector3());
        let R = new THREE.Quaternion();
        let axialLen = null; // [ourLen, bindLen] when axially stretched
        if (tpl.dirBone && boneByName.get(sub(tpl.dirBone))) {
          const dA = bindPos(boneByName.get(sub(tpl.dirBone))).sub(q);
          const dirKey = rest[`${tpl.dirJoint}${suffix}`] ? `${tpl.dirJoint}${suffix}` : tpl.dirJoint;
          const dJ = target(dirKey).clone().sub(target(jointName));
          if (tpl.axial) axialLen = [dJ.length(), dA.length()];
          R.setFromUnitVectors(dA.normalize(), dJ.normalize());
        } else if (tpl.inherit) {
          R = (alignR.get(sub(tpl.inherit)) || new THREE.Quaternion()).clone();
        }
        alignR.set(boneName, R);
        // Snap the bone origin to the atlas joint, expressed in the PARENT node's
        // rest frame. An atlas seat node already sits at the atlas joint (heel
        // lift included — targetBase() and the seat agree), so the offset is zero
        // unless a shoe lift raises the target above its node; a rig node (torso)
        // carries the rig→atlas delta.
        const seatRest = this.atlasNodes[jointName] ? targetBase(jointName) : rest[jointName];
        const originDelta = target(jointName).clone().sub(seatRest);
        plans.set(bone, { node, jointName, q, rotBind, R, axialLen, originDelta, jointY: target(jointName).y, squash: !!tpl.squash });
      }
    }

    // Apply: constant local matrix under the joint node.
    const m = new THREE.Matrix4();
    this.jointBone = {}; // retargeted Biped bone now driving each joint (for endpoint alignment)
    for (const [bone, p] of plans) {
      this.jointBone[p.jointName] = bone;
      const sx = p.axialLen ? p.axialLen[0] / Math.max(p.axialLen[1], 1e-6) : s0;
      const local = new THREE.Matrix4()
        .compose(new THREE.Vector3(), p.R.clone().multiply(p.rotBind), new THREE.Vector3(sx, s0, s0));
      if (p.squash && p.q.y * s0 > 1e-4) {
        // Vertical squash so the sole reaches exactly y = 0 at rest: the bind
        // sole sits q.y below the bone; our joint sits jointY above the floor.
        // With the shoe stand-height lift above, jointY is raised to (near) the
        // shoe's natural sole depth, so lam → SHOE_STAND (1 = no flatten at all,
        // the toe box keeps its shape); a heeled figure was already there.
        const lam = THREE.MathUtils.clamp(p.jointY / (p.q.y * s0), 0.3, 1);
        local.premultiply(m.makeScale(1, lam, 1));
      }
      local.setPosition(p.originDelta); // snap origin to the atlas joint (after squash)
      p.node.add(bone);
      bone.matrixAutoUpdate = false;
      bone.matrix.copy(local);
    }

    // Keep handles to the (unmapped) Biped finger bones riding each hand so
    // the embrace can close a clasped hand's fingers (setFingerCurl).
    this.fingerBones = { L: [], R: [] };
    for (const [bone, p] of plans) {
      if (!p.jointName.startsWith('wrist_')) continue;
      const side = p.jointName.slice(-1);
      bone.traverse((o) => {
        const m = normBoneName(o.name).match(/finger(\d)(\d*)$/);
        if (!m) return;
        this.fingerBones[side].push({
          bone: o, rest: o.quaternion.clone(), digit: +m[1], seg: m[2] ? +m[2] : 0,
        });
      });
    }

    // Where the avatar's palms REALLY face: the rig's canonical hand frame
    // (palm = wrist-local +Z, fingers = -Y; anatomical position, palms
    // forward) is NOT what the retargeted skin shows. The Biped bind carries
    // each hand rolled about the forearm — palms toward the thighs — and the
    // retarget only aligns the hand bone's direction along the wrist segment,
    // keeping that roll. Anything that aims the node's +Z at a target (the
    // embrace clasp) therefore turns the VISIBLE hand ~110° away from it —
    // the back of the leader's hand faced his partner. Measure the mesh-truth
    // frame from the finger bones instead (see #measureHandMesh); embrace.js
    // conjugates its hand-orientation targets by this offset.
    this.#measureHandMesh();

    // The skinned meshes themselves: identity bind under `group` ('attached'
    // mode divides the mesh's own world transform back out, so parenting is
    // only for visibility/layer bookkeeping).
    avatar.updateMatrixWorld(true);
    const skinnedMeshes = [];
    avatar.traverse((o) => { if (o.isSkinnedMesh) skinnedMeshes.push(o); });
    for (const o of skinnedMeshes) { // re-parent after the walk, not during
      o.bind(o.skeleton, new THREE.Matrix4());
      o.frustumCulled = false; // posed verts leave the bind-pose bounds
      o.castShadow = !o.material.transparent; // hair cards would cast solid blobs
      o.userData.noHighlight = true; // one skin, no per-part split (see #applyHighlight)
      this.group.add(o);
      this.layerMeshes.body.push(o);
    }
  }

  // The skeleton/muscle GLBs are frozen in an anatomical reference pose that
  // holds the hands splayed (palm-down, fingers fanned) and the feet turned
  // out; the clothed avatar hangs its hands and feet naturally. So overlaying
  // the layers, the bony hands/feet poke out of the skin (the drift the
  // alignment diagnostic measures). We reconcile them by rotating the *skeleton*
  // hand/foot geometry onto the body's orientation — the body is already the
  // natural pose, so it stays put and the bones come to it ("body conforms to
  // skeleton" was chosen before we saw the skeleton is the splayed one).
  //
  // classifyBone puts the whole hand on the wrist node and the foot on the
  // ankle+toes nodes, each as a merged mesh parented at its joint with an
  // identity local transform, and every rig rest rotation is identity — so the
  // node-local axes equal the figure axes at rest, and a single mesh-local
  // quaternion rotates the geometry about the joint (its node origin) into
  // place. Because the mesh rides the node, the fix holds in every pose.
  #alignEndpointGeometry() {
    this.group.updateMatrixWorld(true);
    const gInv = this.group.matrixWorld.clone().invert();
    // Per endpoint: the skeleton node(s) whose merged mesh we rotate, the joint
    // the rotation pivots about, and the joint base(s) whose geometry defines
    // the endpoint's frame (in both layers). Only the hand uses this whole-frame
    // match: the foot rests on the floor and its flat-bone-vs-heeled-shoe shape
    // mismatch makes a centroid match over-pitch it through the floor, so the
    // foot is handled separately (#applyHeel pitches a heeled foot about the ball).
    const specs = ENDPOINT_FITS;
    const A = new THREE.Vector3(); const P = new THREE.Vector3(); const off = new THREE.Vector3();
    for (const side of ['_L', '_R']) {
      for (const spec of specs) {
        const fit = this.#endpointAlignR(side, spec, gInv);
        if (!fit) continue;
        const { R, S, T, X } = fit;
        this.calibration.endpointR[`${spec.pivot}${side}`] = R.clone(); // record for the tripwire
        this.calibration.endpointS[`${spec.pivot}${side}`] = S;
        this.calibration.endpointT[`${spec.pivot}${side}`] = T.clone();
        this.#seatNode(`${spec.pivot}${side}`).getWorldPosition(A).applyMatrix4(gInv);
        // The endpoint's linear map about the pivot. A similarity fit is just
        // S·R; the foot's axis fit also stretches along its own midline, which
        // is NOT expressible as mesh.scale (that is per-local-axis, and the
        // midline is an arbitrary direction), so both modes go through one
        // general 3×3 and the mesh matrix is written directly.
        const L = X ? X.clone() : new THREE.Matrix4().makeRotationFromQuaternion(R)
          .premultiply(new THREE.Matrix4().makeScale(S, S, S));
        for (const base of spec.rotNodes) {
          const nodeName = `${base}${side}`;
          // Transform geometry about the pivot A, then seat it with T. A mesh
          // parented at a node with origin P and identity rest rotation needs a
          // local offset A + L·(P − A) − P + T so the transform pivots about A,
          // not P (zero when the node *is* the pivot, e.g. the wrist's own mesh
          // — the hand rides the atlas wrist node, whose origin is that pivot);
          // T is a figure-local displacement = node-local at rest.
          this.#seatNode(nodeName).getWorldPosition(P).applyMatrix4(gInv);
          off.copy(P).sub(A).applyMatrix4(L).add(A).sub(P)
            .add(T);
          for (const mesh of this.layerMeshes.skeleton) {
            if (this.#nodeNameOf(mesh) !== nodeName) continue;
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(L).setPosition(off);
          }
        }
      }
    }
  }

  // The Object3D a limb bone actually pivots about: its atlas node if seated,
  // else the rig node of the same name.
  #seatNode(name) {
    return this.atlasNodes[name] || this.nodes[name];
  }

  // Walk up to the joint node a mesh belongs to (its jointName), or null.
  #nodeNameOf(obj) {
    let n = obj;
    while (n && (!n.userData || n.userData.jointName === undefined)) n = n.parent;
    return n ? n.userData.jointName : null;
  }

  // The joint a mesh belongs to: an explicit userData.skinNode when it has one
  // (skinned muscles hang off `group`, not their joint node), else the node it
  // is parented under (#nodeNameOf).
  #jointNameOf(obj) {
    return obj.userData.skinNode !== undefined ? obj.userData.skinNode : this.#nodeNameOf(obj);
  }

  // Similarity fit ({ R, S, T }) laying the atlas geometry of an endpoint onto
  // the clothed avatar's: R rolls it to the avatar's orientation, S scales it to
  // the avatar's size about the pivot joint, and T seats the whole thing. Rather
  // than build a frame from a few axes — fragile, because the two models are
  // shaped differently and a landmark off the main plane (the opposable thumb)
  // tilts any single normal differently in each layer — this fits the *optimal*
  // rotation (hornRotation) that overlays every corresponding region at once.
  //
  // The regions come from ENDPOINT_FITS in landmarks.js, so the correspondences
  // are data rather than code and the same {bones, pick} recipe language serves
  // both this fit and the verification gate. Both layers are read from the
  // RENDERED meshes through landmarks.js's resolver — valid because this runs
  // during build, before any endpoint correction has been applied, so the
  // meshes still carry identity local transforms. Returns null if fewer than
  // three regions resolve (body fell back to the mannequin, or the atlas isn't
  // the named anatomy skeleton) — the caller then leaves the endpoint as-is.
  #endpointAlignR(side, spec, gInv) {
    const jointName = `${spec.pivot}${side}`;
    const jointPos = this.#seatNode(jointName).getWorldPosition(new THREE.Vector3()).applyMatrix4(gInv);
    const nodes = spec.rotNodes.map((b) => `${b}${side}`);

    // Axis mode: match the MIDLINE through the two layers' geometry and change
    // nothing else — the rotation that makes the skeletal foot point the way
    // the shoe points, plus the translation that puts the two midlines on top
    // of each other. No scale: the bare foot and the shoe are genuinely
    // different sizes, and a scale term here is what slid the follower's heel
    // 55 mm forward when this was a similarity fit (see ENDPOINT_FITS).
    if (spec.mode === 'axis') {
      const sf = axisFrame(this, 'skeleton', spec.axis.skeleton, nodes, side, spec.axis.forward);
      const bf = axisFrame(this, 'body', spec.axis.body, nodes, side, spec.axis.forward);
      if (!sf || !bf) return null;
      const R = new THREE.Quaternion().setFromUnitVectors(sf.axis, bf.axis);
      // Record how far off the two midlines were BEFORE this correction — the
      // fit's own rotation angle is exactly that. Worth keeping: it is the only
      // record of how misaligned the raw geometry is, which the post-fit
      // measurement can no longer see.
      this.calibration.axisDeg = this.calibration.axisDeg || {};
      this.calibration.axisDeg[jointName] = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(R.w))));
      const Cs = sf.center.applyMatrix4(gInv);
      const Cb = bf.center.applyMatrix4(gInv);

      // Stretch along the midline ONLY, to the length of the part we are laying
      // this one inside. The two feet are genuinely different lengths — the
      // leader's skeletal foot is shorter than his shoe, the follower's longer
      // than her heeled one — and that surplus has to go somewhere. A UNIFORM
      // scale is the wrong way to absorb it (it was what slid the follower's
      // heel 55 mm forward when this was a similarity fit): the feet differ in
      // length far more than in width, so scaling all three axes to fix the
      // length distorts the other two. One axis, so width and height are
      // untouched. Clamped, so a degenerate cloud cannot collapse the foot.
      const k = THREE.MathUtils.clamp(
        sf.extent > 1e-6 ? bf.extent / sf.extent : 1, 0.75, 1.25,
      );
      // X = R · (I + (k−1)·â⊗â): stretch along the skeleton's own midline, then
      // rotate that midline onto the body's.
      const a = sf.axis;
      const kk = k - 1;
      const stretch = new THREE.Matrix4().set(
        1 + kk * a.x * a.x, kk * a.x * a.y, kk * a.x * a.z, 0,
        kk * a.y * a.x, 1 + kk * a.y * a.y, kk * a.y * a.z, 0,
        kk * a.z * a.x, kk * a.z * a.y, 1 + kk * a.z * a.z, 0,
        0, 0, 0, 1,
      );
      const X = new THREE.Matrix4().makeRotationFromQuaternion(R).multiply(stretch);

      // With the lengths now MATCHED, aligning the two centroids is no longer
      // arbitrary — equal-length segments sharing a centre also share their
      // ends, so this lands the heel and the toe together. (Before the stretch
      // it was actively wrong: the centroids of two different-length feet do
      // not correspond, and matching them slid the skeletal foot so far down
      // its own length that its farthest point from the ankle flipped from toe
      // to heel — 290 mm of error, which `measureAxes` could not see because a
      // metric that measures what the fit forces will always agree with it.)
      const T = Cb.clone().sub(jointPos)
        .sub(Cs.clone().sub(jointPos).applyMatrix4(X));
      // S is recorded (not used for the transform — X carries it) so the frozen
      // calibration tripwires the along-axis stretch too.
      return { R, S: k, T, X };
    }

    // Corresponding pivot-relative point pairs, in figure-local space.
    const P = []; const Q = []; const W = [];
    for (const region of spec.regions) {
      const sc = regionCentroid(this, 'skeleton', region.skeleton, nodes, side);
      const bc = regionCentroid(this, 'body', region.body, nodes, side);
      if (!sc || !bc) continue;
      P.push(sc.applyMatrix4(gInv).sub(jointPos));
      Q.push(bc.applyMatrix4(gInv).sub(jointPos));
      W.push(region.weight ?? 1);
    }
    if (P.length < 3) return null;

    // Weighted similarity fit (Umeyama): a roll R, a uniform scale S about the
    // pivot, and a seat translation T that together overlay the atlas endpoint
    // onto the avatar's. Scale earns its keep because the two models disagree
    // about size — the atlas hand is longer from the wrist than the glove, and
    // the atlas foot is 20 mm SHORTER than the leader's shoe but 22 mm LONGER
    // than the follower's heeled one, so the term is per-figure and signed both
    // ways. A rotation alone leaves geometry poking through the skin, and a
    // translation alone only trades that overshoot for an offset at the pivot.
    // Centering by the weighted centroids first frees the roll from having to
    // pass through the joint, then S/T seat the whole endpoint; S is clamped so
    // a degenerate correspondence can't collapse or inflate it.
    let wsum = 0; const muP = new THREE.Vector3(); const muQ = new THREE.Vector3();
    for (let i = 0; i < P.length; i++) { muP.addScaledVector(P[i], W[i]); muQ.addScaledVector(Q[i], W[i]); wsum += W[i]; }
    muP.multiplyScalar(1 / wsum); muQ.multiplyScalar(1 / wsum);
    const Pc = P.map((p) => p.clone().sub(muP));
    const Qc = Q.map((q) => q.clone().sub(muQ));
    const R = hornRotation(Pc, Qc, W);
    let num = 0, den = 0; const _rp = new THREE.Vector3();
    for (let i = 0; i < Pc.length; i++) {
      num += W[i] * _rp.copy(Pc[i]).applyQuaternion(R).dot(Qc[i]);
      den += W[i] * Pc[i].lengthSq();
    }
    const S = THREE.MathUtils.clamp(den > 1e-9 ? num / den : 1, 0.75, 1.25);
    const T = muQ.clone().sub(muP.clone().applyQuaternion(R).multiplyScalar(S));
    return { R, S, T };
  }

  // Re-seat the atlas `toes` node onto the MTP joint of the foot AS RENDERED.
  //
  // #atlasLimbRest estimates every seated joint from the RAW atlas bones, but
  // the foot is then moved out from under its nodes by #alignEndpointGeometry's
  // axis fit — a rotation of 18.6° (leader) / 13.9° (follower) onto the shoe's
  // midline, a stretch along it, and a ~1.3 cm seat translation. That fit
  // PIVOTS about the ankle, so the ankle node keeps its own geometry; the toes
  // node, 13 cm out along the foot, does not. Measured, the metatarsal heads
  // ended up 3.5–3.8 cm away from the node that is supposed to be the hinge
  // through them.
  //
  // The mesh still pivots about the node, so that offset is a crank: the MTP
  // articulation itself TRAVELLED 22 mm at 35° of toe flexion and 43 mm at the
  // −70° extension, carrying the phalanges through the metatarsal heads instead
  // of hinging against them — the visible "the toe clip smashes the foot". A
  // clip's sagittal plane and angle arc are drawn on surfacePos (studio.js), so
  // the same offset also planted them off the joint they name.
  //
  // Nothing on screen moves: each child is shifted back by the same delta, so
  // this changes the PIVOT and only the pivot. Deliberately NOT written back
  // into calibration.rest — that records the rest the body retarget was built
  // against, and leaving it be keeps the frozen snapshot (and
  // dev-verify-calibration) valid, exactly as #applyHeel and #narrowFoot do.
  //
  // Only the foot needs this. The hand's fit pivots about the wrist, and the
  // wrist is the hand's only seated joint, so its geometry cannot move relative
  // to its own pivot; the foot is the one endpoint whose fit spans a second
  // seated joint. #narrowFoot's later squeeze is a pure scale along x about the
  // foot's sagittal plane, and the MTP is an x hinge — a rotation about x is
  // unaffected by its pivot's x — so the few mm it leaves behind cannot reach
  // the movement. Verified by scripts/dev-verify-toe-pivot.mjs.
  #reseatToesPivot() {
    this.group.updateMatrixWorld(true);
    const gInv = this.group.matrixWorld.clone().invert();
    const movedNodes = new Set();
    for (const side of ['_L', '_R']) {
      const node = this.atlasNodes[`toes${side}`];
      const ankle = this.#seatNode(`ankle${side}`);
      if (!node || !node.parent || !ankle) continue;
      // Any cloud sampled before the fit is stale: that geometry has moved.
      this._boneClouds?.delete(node);
      this._boneClouds?.delete(ankle);
      const mtp = this.#mtpCenter(node, ankle, gInv);
      if (!mtp) continue;
      // Rest rotations are identity (see #buildAtlasNodes), so the parent's
      // local axes are the figure axes and this is a plain subtraction — and
      // for the same reason a child cancels the move by −delta in its own frame.
      const want = mtp.sub(node.parent.getWorldPosition(new THREE.Vector3()).applyMatrix4(gInv));
      const delta = want.clone().sub(node.position);
      if (delta.lengthSq() < 1e-8) continue;
      node.position.copy(want);
      for (const child of node.children) {
        if (child.matrixAutoUpdate) child.position.sub(delta);
        else {
          child.matrix.elements[12] -= delta.x;
          child.matrix.elements[13] -= delta.y;
          child.matrix.elements[14] -= delta.z;
        }
      }
      movedNodes.add(node);
    }
    if (!movedNodes.size) return;
    this.group.updateMatrixWorld(true);
    // A bi-articular belly crossing the MTP (the long toe-extensor tendons)
    // recorded this node's bind matrix when it was skinned. Re-take it, or
    // updateMuscleSkin reads the re-seat as joint motion and the tendon jumps
    // at rest. Valid here because the figure is still in its rest pose.
    const g = this.group.matrixWorld.clone().invert();
    for (const sm of this._skinMuscles) {
      if (movedNodes.has(sm.nodeA)) sm.invA.multiplyMatrices(g, sm.nodeA.matrixWorld).invert();
      if (movedNodes.has(sm.nodeB)) sm.invB.multiplyMatrices(g, sm.nodeB.matrixWorld).invert();
    }
  }

  // Where the phalanges actually meet the metatarsals in the RENDERED foot: the
  // mean of the toes-cloud points lying closest to the ankle cloud — the
  // articulation itself, found from both bone groups at once, in figure-local
  // space.
  //
  // #atlasLimbRest's rule ("the child verts nearest the PARENT CLUSTER'S
  // CENTROID") is a proxy that holds while the parent is a long bone, but it
  // biases here because the ankle cluster's centroid sits back in the mid-foot:
  // re-run on this same geometry it lands 18 mm behind the joint and 22 mm off
  // laterally. Nearest-to-the-CLUSTER has no such lever arm.
  #mtpCenter(toesNode, ankleNode, gInv) {
    const ank = this.#boneCloud(ankleNode, gInv);
    const toe = this.#boneCloud(toesNode, gInv);
    if (ank.length < 60 || toe.length < 60) return null;
    const scored = [];
    for (let i = 0; i < toe.length; i += 3) {
      const x = toe[i], y = toe[i + 1], z = toe[i + 2];
      let best = Infinity;
      for (let k = 0; k < ank.length; k += 3) {
        const dx = x - ank[k], dy = y - ank[k + 1], dz = z - ank[k + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
      scored.push([best, i]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const k = Math.max(1, Math.round(scored.length * MTP_BAND));
    const c = new THREE.Vector3();
    for (let n = 0; n < k; n++) {
      const i = scored[n][1];
      c.x += toe[i]; c.y += toe[i + 1]; c.z += toe[i + 2];
    }
    return c.multiplyScalar(1 / k);
  }

  // Seat a heeled figure's foot inside its shoe: drop the balance corners onto
  // the shoe sole, pitch the foot heel-up (both the bare skeleton AND the clothed
  // body, so they agree) so it stands in the heel the way a real foot does, and
  // draw a translucent outline of the shoe for the skeleton/muscle views (where
  // the shoe itself is hidden).
  #applyHeel() {
    // Height of the heel the skeletal foot pitches into and the wedge draws:
    // the FAKE lift for a flat shoe, else the MOLDED heel of a real heeled shoe.
    const lift = this._heelLift || this._moldedHeel;
    const heelFrac = this.heelRise || this.moldedHeel; // same height as a stature fraction
    // Either heel raised the RIG ankle node (see #build), floating the balance
    // corners; the shoe still contacts heel-block + ball flat on the floor, so
    // lower each corner by the heel fraction to put them back on the sole. Bases
    // on this figure's soleScale-fitted corners (built in #build).
    const drop = (corners) => corners.map(([x, y, z]) => [x, y - heelFrac, z]);
    this.footCorners = { _L: drop(this.footCorners._L), _R: drop(this.footCorners._R) };
    this.toeCorners = { _L: drop(this.toeCorners._L), _R: drop(this.toeCorners._R) };
    // Pitch the bare skeleton foot into the heel. Also pitch the CLOTHED foot for
    // a fake heel (its flat shoe has no heel of its own); a molded shoe already
    // carries one, so leave the clothed foot alone or it would double-count.
    this.#pitchHeeledFoot(lift, !!this._heelLift);
    for (const side of ['_L', '_R']) this.#buildHeelOutline(side, lift);
  }

  // Pitch a heeled figure's foot heel-up so it sits in the shoe the way a real
  // foot does: calcaneus lifted onto the heel, forefoot on the floor, breaking
  // at the MTP, instead of lying flat with the heel on the ground.
  //
  // `lift` is the heel height (figure-local metres); `pitchBody` says whether the
  // clothed foot needs pitching too. Two callers:
  //
  //  - FAKE heel (heelLift): both this avatar's shoe is FLAT and its ankle node
  //    was raised by heelLift, so BOTH layers need the pitch. The skeleton's
  //    endpoint axis fit (ENDPOINT_FITS, mode 'axis') lands it flat on the shoe's
  //    OUTER sole while the ankle rides heelLift up, leaving the leg meeting the
  //    foot heelLift above the bones. The BODY's foot bones just rode the raised
  //    ankle rigidly (no ball-pitch), so the flat shoe stretched heel-up and the
  //    toe box deformed. pitchBody = true fixes both.
  //  - MOLDED heel: the shoe mesh already carries the heel and the ankle was NOT
  //    raised, so the CLOTHED foot already stands correctly — pitching it too
  //    would double-count the heel (the old en-pointe float). Only the bare
  //    SKELETON, which the axis fit still lands flat on the outer sole, needs the
  //    pitch to climb inside the shoe. pitchBody = false.
  //
  // The pitch is one rotation about the ball (the MTP / toes joint) by
  // atan2(lift, run): it rotates the ankle-region mesh / the foot bone
  // (bip01*foot) — lifting its ankle end — while the phalanges (toes mesh) / toe
  // bone (bip01*toe0), which ride the toes node, stay flat in the toe box, so the
  // break falls at the MTP as in a real heeled shoe. The foot bone rides the same
  // atlas ankle node as the skeleton mesh, so the identical transform lands both
  // layers on one heel.
  //
  // Baked into each matrix ONCE (they ride their node rigidly, so the pitch holds
  // through any pose) and COMPOSED with — never overwrites — the fit matrix
  // #alignEndpointGeometry wrote / the body bone's retarget matrix: assigning the
  // matrix outright would erase the fit/retarget on exactly the foot that needs
  // it. Runs after the calibration is recorded, so the frozen snapshot (and
  // dev-verify-calibration) is unaffected — no re-bake needed.
  #pitchHeeledFoot(lift, pitchBody) {
    this.group.updateMatrixWorld(true);
    const gInv = this.group.matrixWorld.clone().invert();
    const local = (name) => this.#seatNode(name).getWorldPosition(new THREE.Vector3()).applyMatrix4(gInv);
    const m = new THREE.Matrix4();
    for (const side of ['_L', '_R']) {
      const ball = local(`toes${side}`); // MTP joint = pivot
      const ankle = local(`ankle${side}`);
      const run = ball.z - ankle.z; // horizontal ball→ankle distance
      if (run < 1e-4) continue;
      // Heel-up rotation about the figure-local lateral (X) axis that lifts the
      // foot's ankle end by `lift` over that run.
      const theta = Math.atan2(lift, run);
      this.heelPitchDeg = THREE.MathUtils.radToDeg(theta); // both sides equal

      const pitch = new THREE.Matrix4()
        .makeTranslation(ball.x, ball.y, ball.z)
        .multiply(m.makeRotationX(theta))
        .multiply(new THREE.Matrix4().makeTranslation(-ball.x, -ball.y, -ball.z));
      for (const mesh of this.layerMeshes.skeleton) {
        if (this.#nodeNameOf(mesh) !== `ankle${side}`) continue;
        // Re-express the figure-local pitch in the mesh's parent (atlas ankle
        // node) frame and pre-apply it to the baked fit matrix.
        const pl = gInv.clone().multiply(mesh.parent.matrixWorld);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(pl.clone().invert().multiply(pitch).multiply(pl).multiply(mesh.matrix));
      }
      // Pitch the CLOTHED foot the same way (fake heel only — a molded shoe
      // already carries its heel). The foot bone (bip01*foot) rides the same
      // atlas ankle node as the skeleton mesh, so the identical about-the-ball
      // pitch lands it on the same heel; the toe bone (bip01*toe0) rides the toes
      // node and is left flat, so the shoe breaks at the MTP instead of stretching.
      const footBone = pitchBody && this.jointBone && this.jointBone[`ankle${side}`];
      if (footBone && footBone.parent) {
        const pl = gInv.clone().multiply(footBone.parent.matrixWorld);
        footBone.matrixAutoUpdate = false;
        footBone.matrix.copy(pl.clone().invert().multiply(pitch).multiply(pl).multiply(footBone.matrix));
      }
    }
  }

  // Narrow the BARE skeletal foot laterally (toward its own sagittal midline) so
  // it sits inside a shoe narrower than the atlas foot — the foot analog of the
  // hand desplay (#handDesplayRotations tucks the splayed atlas fingers into the
  // glove). The foot's endpoint fit (ENDPOINT_FITS, mode 'axis') matches the
  // shoe's LENGTH and DIRECTION but NOT its WIDTH, so a figure whose avatar wears
  // a narrow shoe (the follower's heeled shoe) has its 5th-metatarsal / little-toe
  // edge poke out past the shoe in skeleton / muscle view (measured ~1 cm at the
  // ball). `factor` (<1) scales x about each foot's own sagittal plane (the ankle
  // node's x), narrowing the ankle-region (metatarsals) AND toes meshes together.
  //
  // Like #pitchHeeledFoot: the figure-frame squeeze is re-expressed in each mesh's
  // parent-node frame and COMPOSED with — never overwriting — the fit / heel-pitch
  // matrix already on the mesh, and it runs AFTER the calibration is recorded, so
  // the frozen snapshot (and dev-verify-calibration) is unaffected — no re-bake.
  // The squeeze is perpendicular to the foot's midline, so the foot's aim and
  // length (what the frame gate checks) are untouched. Skeleton + muscle only;
  // the clothed shoe is already the right width.
  #narrowFoot(factor) {
    this.group.updateMatrixWorld(true);
    const gInv = this.group.matrixWorld.clone().invert();
    const m = new THREE.Matrix4();
    for (const side of ['_L', '_R']) {
      const cx = this.#seatNode(`ankle${side}`).getWorldPosition(new THREE.Vector3())
        .applyMatrix4(gInv).x; // foot's sagittal plane (figure-local)
      const squeeze = new THREE.Matrix4().makeTranslation(cx, 0, 0)
        .multiply(m.makeScale(factor, 1, 1))
        .multiply(new THREE.Matrix4().makeTranslation(-cx, 0, 0));
      for (const layer of ['skeleton', 'muscle']) {
        for (const mesh of this.layerMeshes[layer]) {
          const jn = this.#nodeNameOf(mesh);
          if (jn !== `ankle${side}` && jn !== `toes${side}`) continue;
          const pl = gInv.clone().multiply(mesh.parent.matrixWorld);
          mesh.matrixAutoUpdate = false;
          mesh.matrix.copy(pl.clone().invert().multiply(squeeze).multiply(pl).multiply(mesh.matrix));
        }
      }
    }
  }

  // A faint translucent outline of one shoe (flat sole footprint + the raised
  // heel wedge at the back), parented to the rig ankle node so it sits on the
  // floor at rest and rides the foot when it is posed. Shown only when the body
  // avatar is hidden (skeleton / muscle views), where it stands in for the shoe
  // the bones are wearing. Built from this figure's fitted sole corners, so it
  // tracks the balance footprint and any soleScale change for free. `hl` is the
  // wedge height (the fake heelLift or the real molded heel).
  #buildHeelOutline(side, hl) {
    const H = this.height;
    const ankleNode = this.nodes[`ankle${side}`];
    const toesNode = this.nodes[`toes${side}`];
    if (!ankleNode || !toesNode) return;
    const foot = this.footCorners[side]; // ankle-frame, [heel-out, heel-in, ball-in, ball-out]
    const toe = this.toeCorners[side]; // toes-frame, [toe-out, toe-in]
    // Bring the toe-pad corners into the ankle node's frame (identity rest
    // rotations, so a plain offset of the toes node from the ankle).
    const toesOff = toesNode.position.clone().sub(ankleNode.position).multiplyScalar(1 / H);
    const P = (x, y, z) => new THREE.Vector3(x * H, y * H, z * H);
    const soleY = foot[0][1]; // dropped sole plane (fraction), on the floor at rest
    const outline = [
      P(...foot[0]), P(...foot[1]), P(...foot[2]),
      P(toe[0][0] + toesOff.x, soleY, toe[0][2] + toesOff.z),
      P(toe[1][0] + toesOff.x, soleY, toe[1][2] + toesOff.z),
      P(...foot[3]),
    ];

    const fillMat = new THREE.MeshStandardMaterial({
      color: HEEL_OUTLINE_FILL, roughness: 0.6, transparent: true,
      opacity: HEEL_OUTLINE_FILL_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: HEEL_OUTLINE_EDGE, transparent: true,
      opacity: HEEL_OUTLINE_EDGE_OPACITY, depthWrite: false,
    });

    const group = new THREE.Group();
    // --- Sole: a flat filled polygon (triangle fan from its centroid) + edge. ---
    const c = new THREE.Vector3();
    for (const p of outline) c.add(p);
    c.multiplyScalar(1 / outline.length);
    const solePos = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]; const b = outline[(i + 1) % outline.length];
      solePos.push(c.x, c.y, c.z, a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const soleGeo = new THREE.BufferGeometry();
    soleGeo.setAttribute('position', new THREE.Float32BufferAttribute(solePos, 3));
    soleGeo.computeVertexNormals();
    group.add(new THREE.Mesh(soleGeo, fillMat));
    const edgePos = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]; const b = outline[(i + 1) % outline.length];
      edgePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    group.add(new THREE.LineSegments(edgeGeo, edgeMat));

    // --- Heel: a wedge from the heel corners (on the floor) up to heelLift,
    // sloping down to the sole around the arch. Slightly inset from the sole. ---
    const xOut = foot[0][0] * 0.92; const xIn = foot[1][0] * 0.92;
    const zBack = foot[0][2]; const zArch = 0.006; // wedge front, ~1 cm ahead of the ankle
    const A = P(xOut, soleY, zBack); const A2 = P(xIn, soleY, zBack);
    const B = new THREE.Vector3(A.x, A.y + hl, A.z); const B2 = new THREE.Vector3(A2.x, A2.y + hl, A2.z);
    const Cc = P(xOut, soleY, zArch); const Cc2 = P(xIn, soleY, zArch);
    const tri = (p, q, r) => [p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z];
    const wedgePos = [
      ...tri(A, B, B2), ...tri(A, B2, A2), // vertical back face
      ...tri(A, A2, Cc2), ...tri(A, Cc2, Cc), // bottom
      ...tri(B, Cc, Cc2), ...tri(B, Cc2, B2), // sloped top
      ...tri(A, Cc, B), ...tri(A2, B2, Cc2), // side triangles
    ];
    const wedgeGeo = new THREE.BufferGeometry();
    wedgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(wedgePos, 3));
    wedgeGeo.computeVertexNormals();
    group.add(new THREE.Mesh(wedgeGeo, fillMat));
    const wedgeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wedgeGeo, 20), edgeMat);
    group.add(wedgeEdges);

    group.visible = false; // shown by setLayers when the body avatar is hidden
    for (const o of group.children) { o.castShadow = false; o.raycast = () => {}; }
    ankleNode.add(group);
    this.heelOutline.push(group);
  }

  // Curl one hand's fingers (0 = bind pose, 1 = closed around the partner's
  // hand). Used by the embrace's open-side clasp. Only the clothed avatar has
  // finger bones; the procedural fallback hand is a single ellipsoid, so this
  // is a no-op without a body mesh.
  setFingerCurl(side, curl) {
    if (!this.fingerBones) return;
    for (const f of this.fingerBones[side]) {
      const amt = (f.digit === 0 ? THUMB_CURL : FINGER_CURL)[Math.min(f.seg, 2)];
      f.bone.quaternion.copy(f.rest);
      if (curl * amt) f.bone.quaternion.multiply(_fingerQ.setFromAxisAngle(FINGER_AXIS, curl * amt));
    }
  }

  // User-facing open/close of one hand: like setFingerCurl, but REMEMBERS the
  // amount (this.handCurl) so it persists through pose save/load and is
  // re-applied by setPose. The embrace still drives the clasp hands directly
  // through setFingerCurl (a transient hold), leaving this baseline untouched.
  setHandCurl(side, curl) {
    this.handCurl[side] = curl;
    this.setFingerCurl(side, curl);
  }

  // Measure each clothed hand's real orientation AND its palm center, from the
  // avatar's own finger bones at rest.
  //
  // Orientation, in the wrist node's frame: `fingers` runs along the middle
  // finger's proximal phalanx; `palm` (the visible palm's outward normal) is
  // the direction a curl first sweeps the fingertips — the Biped fingers bend
  // about their bones' local Z (FINGER_AXIS) and positive curl closes onto the
  // palm by construction, so curlAxis × fingers points out of the palm with no
  // sign ambiguity. `offset` is the rotation taking the rig-canonical hand
  // frame (fingers -Y, palm +Z) onto the mesh frame; embrace.js multiplies its
  // orientation targets by `offsetInv` so the visible palm — not the rig's
  // phantom +Z — faces the partner. The rig wrist node is the right frame for
  // this half: it and the atlas wrist share their local rotations, so the two
  // agree in orientation exactly (measured: 0.0° apart in every pose).
  //
  // POSITION is a different matter, and is stored in the ATLAS wrist's frame
  // (#seatNode) because that is the node the clothed hand is welded to. The
  // two chains share rotations but NOT local positions, so they drift apart as
  // the arm flexes — measured 6 cm with the arm hanging, ~18 cm at the
  // embrace's -120° elbow. Anything that POSITIONS a hand off the rig node is
  // therefore aiming a phantom: it is what let the embrace solve a perfect
  // palm-to-palm clasp on the rig nodes while the rendered hands hung ~15 cm
  // apart (and why a rig-node metric could never see it). `center` is the
  // position half of the same mesh-truth correction — midway between the
  // avatar's own hand-bone origin (its wrist) and the row of finger knuckles,
  // i.e. the middle of the palm, which is the surface a clasp actually joins.
  #measureHandMesh() {
    this.group.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const mid = this.fingerBones[side].filter((b) => b.digit === 2);
      const seg0 = mid.find((b) => b.seg === 0);
      const seg1 = mid.find((b) => b.seg === 1);
      if (!seg0 || !seg1) continue;
      const root = seg0.bone.getWorldPosition(new THREE.Vector3());
      const fingers = seg1.bone.getWorldPosition(new THREE.Vector3()).sub(root);
      const curlAxis = new THREE.Vector3().setFromMatrixColumn(seg0.bone.matrixWorld, 2);
      const palm = new THREE.Vector3().crossVectors(curlAxis, fingers);
      if (fingers.lengthSq() < 1e-10 || palm.lengthSq() < 1e-10) continue;
      const qInv = this.nodes[`wrist_${side}`].getWorldQuaternion(new THREE.Quaternion()).invert();
      fingers.normalize().applyQuaternion(qInv);
      palm.normalize().applyQuaternion(qInv);
      const y = fingers.clone().negate();
      const z = palm.addScaledVector(y, -y.dot(palm)).normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      const offset = new THREE.Quaternion()
        .setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      // Palm center, in the frame the hand is welded to (see above). The thumb
      // (digit 0) is left out of the knuckle row: its metacarpal sits off the
      // palm plane and would drag the center toward the thumb side.
      const knuckles = this.fingerBones[side].filter((b) => b.seg === 0 && b.digit > 0);
      const handBone = seg0.bone.parent;
      let center = null;
      if (handBone && knuckles.length) {
        const mcp = new THREE.Vector3();
        for (const k of knuckles) mcp.add(k.bone.getWorldPosition(_handV));
        mcp.divideScalar(knuckles.length);
        center = handBone.getWorldPosition(new THREE.Vector3())
          .add(mcp).multiplyScalar(0.5);
        this.#seatNode(`wrist_${side}`).worldToLocal(center);
      }
      this.handMesh[side] = {
        fingers, palm: z.clone(), offset, offsetInv: offset.clone().invert(), center,
      };
    }
  }

  // World direction the VISIBLE palm faces (mesh-truth; falls back to the
  // rig convention, wrist-local +Z, when no clothed avatar is loaded).
  palmDirWorld(side) {
    const q = this.nodes[`wrist_${side}`].getWorldQuaternion(new THREE.Quaternion());
    const p = this.handMesh[side]?.palm ?? new THREE.Vector3(0, 0, 1);
    return p.clone().applyQuaternion(q);
  }

  // World direction the VISIBLE fingers point (mesh-truth, measured on the
  // uncurled hand — so it reports where the hand is AIMED regardless of any
  // clasp curl, which is what an aim target means). Falls back to the rig
  // convention, wrist-local -Y, with no clothed avatar.
  fingerDirWorld(side) {
    const q = this.nodes[`wrist_${side}`].getWorldQuaternion(new THREE.Quaternion());
    const d = this.handMesh[side]?.fingers ?? new THREE.Vector3(0, -1, 0);
    return d.clone().applyQuaternion(q);
  }

  // World position of the VISIBLE palm's center — where the clothed hand
  // really is, which on a flexed arm is nowhere near the rig wrist/hand nodes
  // (see #measureHandMesh). Anything joining, resting or measuring a hand
  // against the world wants this, not the rig nodes. Falls back to the rig
  // wrist→hand midpoint when no clothed avatar is loaded (the procedural
  // mannequin's hand IS on the rig node, so the fallback is exact there).
  palmPosWorld(side, target = new THREE.Vector3()) {
    const c = this.handMesh[side]?.center;
    if (c) return this.#seatNode(`wrist_${side}`).localToWorld(target.copy(c));
    target.setFromMatrixPosition(this.nodes[`wrist_${side}`].matrixWorld);
    return target.add(_handV.setFromMatrixPosition(this.nodes[`hand_${side}`].matrixWorld))
      .multiplyScalar(0.5);
  }

  #buildBody() {
    const H = this.height;
    // --- Body layer: mannequin volumes ---
    const limbFor = (nodeName, childName, r, mat, sx = 1, sz = 1) => {
      const child = JOINT_BY_NAME[childName];
      const end = new THREE.Vector3(child.offset[0] * H, child.offset[1] * H, child.offset[2] * H);
      this.#bodyCapsule(nodeName, new THREE.Vector3(), end, r * H, mat, sx, sz);
    };

    // Trunk: hips bar, abdomen, chest, shoulder bar.
    this.#bodyCapsule('pelvis',
      new THREE.Vector3(-0.052 * H, 0, 0), new THREE.Vector3(0.052 * H, 0, 0),
      0.062 * H, this.materials.cloth, 1, 0.85);
    limbFor('pelvis', 'spine', 0.070, this.materials.cloth, 1.15, 0.85);
    limbFor('spine', 'chest', 0.074, this.materials.cloth, 1.15, 0.8);
    limbFor('chest', 'neck', 0.082, this.materials.cloth, 1.25, 0.75);
    this.#bodyCapsule('chest',
      new THREE.Vector3(-0.115 * H, 0.11 * H, 0), new THREE.Vector3(0.115 * H, 0.11 * H, 0),
      0.042 * H, this.materials.cloth);
    // Neck.
    limbFor('neck', 'head', 0.024, this.materials.skin);

    // Limbs.
    const legEnd = (childName) => {
      const child = JOINT_BY_NAME[childName];
      return new THREE.Vector3(child.offset[0] * H, child.offset[1] * H, child.offset[2] * H);
    };
    for (const side of ['L', 'R']) {
      // Legs: tapered profiles instead of uniform capsules.
      this.#bodyLimbProfile(`hip_${side}`, new THREE.Vector3(), legEnd(`knee_${side}`),
        THIGH_PROFILE, this.materials.clothDark);
      this.#bodyLimbProfile(`knee_${side}`, new THREE.Vector3(), legEnd(`ankle_${side}`),
        SHANK_PROFILE, this.materials.clothDark);
      // Knee ball fills the gap when the knee bends; at rest it hides just
      // inside the thigh/shank profiles so no intersection ring shows.
      this.#bodyBall(`knee_${side}`, 0, 0, 0, 0.033 * H, this.materials.clothDark);
      limbFor(`shoulder_${side}`, `elbow_${side}`, BODY_RADII[`shoulder_${side}`], this.materials.cloth);
      limbFor(`elbow_${side}`, `wrist_${side}`, BODY_RADII[`elbow_${side}`], this.materials.skin);
      // Hand: small flattened ellipsoid.
      const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), this.materials.skin);
      hand.scale.set(0.024 * H, 0.05 * H, 0.032 * H);
      hand.position.set(0, -0.05 * H, 0);
      hand.castShadow = true;
      this.nodes[`wrist_${side}`].add(hand);
      this.layerMeshes.body.push(hand);
      // Foot: bare ankle, then a shaped shoe — rounded heel, arched instep,
      // toe box. Sole grazes y = -0.039H to match FOOT_CORNERS.
      this.#bodyBall(`ankle_${side}`, 0, -0.006 * H, 0, 0.016 * H, this.materials.skin);
      this.#bodyBall(`ankle_${side}`, 0, -0.020 * H, -0.028 * H, 0.019 * H, this.materials.shoe)
        .scale.set(1.2, 0.95, 1.5);
      this.#bodyBall(`ankle_${side}`, 0, -0.016 * H, 0.024 * H, 0.019 * H, this.materials.shoe)
        .scale.set(1.4, 1.15, 2.5);
      this.#bodyBall(`ankle_${side}`, 0, -0.022 * H, 0.064 * H, 0.015 * H, this.materials.shoe)
        .scale.set(1.9, 1.1, 2.1);
      // Toe cap rides the toes joint so demi-pointe and toe curls read in
      // body view; its underside grazes the toes-local sole plane (y=-0.009H)
      // and its tail tucks under the toe box above.
      this.#bodyBall(`toes_${side}`, 0, 0.0027 * H, 0.021 * H, 0.013 * H, this.materials.shoe)
        .scale.set(2.2, 0.9, 1.9);
    }

    // Head + hair.
    const headBall = new THREE.Mesh(new THREE.SphereGeometry(0.066 * H, 20, 16), this.materials.skin);
    headBall.position.set(0, 0.055 * H, 0.004 * H);
    headBall.castShadow = true;
    this.nodes.head.add(headBall);
    this.layerMeshes.body.push(headBall);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.068 * H, 20, 16), this.materials.clothDark);
    hair.position.set(0, 0.062 * H, -0.008 * H);
    hair.scale.set(1, 0.92, 0.95);
    this.nodes.head.add(hair);
    this.layerMeshes.body.push(hair);
  }

  #alignY(mesh, a, b) {
    const dir = b.clone().sub(a);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize());
  }

  // Tapered limb from a lathe profile of [t, r] pairs (t: 0 at a → 1 at b).
  #bodyLimbProfile(nodeName, a, b, profile, material) {
    const H = this.height;
    const len = a.distanceTo(b);
    const pts = profile.map(([t, r]) => new THREE.Vector2(r * H, (t - 0.5) * len));
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 16), material);
    this.#alignY(mesh, a, b);
    mesh.castShadow = true;
    this.nodes[nodeName].add(mesh);
    this.layerMeshes.body.push(mesh);
    return mesh;
  }

  #bodyBall(nodeName, x, y, z, radius, material) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.nodes[nodeName].add(mesh);
    this.layerMeshes.body.push(mesh);
    return mesh;
  }

  #bodyCapsule(nodeName, a, b, radius, material, sx = 1, sz = 1) {
    const len = a.distanceTo(b);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len, 6, 14), material);
    this.#alignY(mesh, a, b);
    mesh.scale.set(sx, 1, sz);
    mesh.castShadow = true;
    this.nodes[nodeName].add(mesh);
    this.layerMeshes.body.push(mesh);
    return mesh;
  }

  // ------------------------------------------------------------- highlight
  // Highlight the given body parts (Set of BODY_PARTS ids): their meshes get
  // an emissive glow IN THAT PART'S COLOUR, everything else goes
  // ghost-translucent. Works on every layer because materials are swapped per
  // mesh, not per layer.

  // Each (base material, colour) pair gets its own cloned variant, cached — a
  // part recoloured from the Highlight panel must not restyle the material of
  // every other part sharing that base.
  #highlightVariant(base, kind, color = null) {
    this._hlCache ??= new Map();
    let byKey = this._hlCache.get(base);
    if (!byKey) this._hlCache.set(base, byKey = new Map());
    const key = kind === 'lit' ? `lit|${color}` : 'dim';
    let mat = byKey.get(key);
    if (!mat) {
      mat = base.clone();
      if (kind === 'lit') {
        const c = new THREE.Color(color);
        mat.emissive = c.clone();
        mat.emissiveIntensity = 0.45;
        // Bone is near-white, so an emissive glow alone washes every hue out to
        // the same pale cream — tint the diffuse colour too, and the parts stay
        // tellable apart.
        if (mat.color) mat.color = mat.color.clone().lerp(c, 0.5);
        mat.transparent = false;
        mat.opacity = 1;
      } else {
        mat.transparent = true;
        mat.opacity = 0.13;
        mat.depthWrite = false;
      }
      byKey.set(key, mat);
    }
    return mat;
  }

  // The colour a part lights in: the user's pick (Highlight panel) if it has
  // one, else the part's own default from BODY_PARTS.
  #partColor(part) {
    return this.highlightColors?.get(part) ?? PART_COLOR[part] ?? '#cc8a22';
  }

  // `colors`: Map/object of part id → hex, or null/omitted to keep the current
  // choices (the common case — toggling which parts are lit).
  setHighlight(parts, colors = undefined) {
    this.highlightParts = parts && parts.size ? new Set(parts) : null;
    if (colors !== undefined) {
      this.highlightColors = colors
        ? new Map(colors instanceof Map ? colors : Object.entries(colors)) : null;
    }
    this.#applyHighlight();
    this.#applyMuscleStyle(); // muscles dim/light with the body-part highlight too
  }

  // Muscles panel: hide a set of bellies (render them nearly transparent) and/or
  // highlight a set (recolour + glow). Labels match userData.muscleName, so both
  // the left and right copy of a named belly respond together.
  setMuscleHidden(labels) {
    this.hiddenMuscles = labels && labels.size ? new Set(labels) : null;
    this.#applyMuscleStyle();
  }

  setMuscleLit(labels) {
    this.litMuscles = labels && labels.size ? new Set(labels) : null;
    this.#applyMuscleStyle();
  }

  // The colour ONE belly lights in, overriding both the default highlight amber
  // and the body part's hue (the more specific pick wins). Keyed by atlas label
  // like the lit/hidden sets, so both copies of a named belly agree; `hex` null
  // hands it back to the default. The callouts read it back through
  // `muscleColor` so a labelled muscle and its pill carry the same colour.
  setMuscleColor(label, hex) {
    this.muscleColors ??= new Map();
    if (hex) this.muscleColors.set(label, hex); else this.muscleColors.delete(label);
    this.#applyMuscleStyle();
  }

  muscleColor(label) { return this.muscleColors?.get(label) ?? null; }

  // How much of a picked colour a belly takes (0..1, default 1 = exactly the
  // colour picked). Below 1 it mixes back toward the belly's own flesh tone and
  // dims the glow with it, so the colour reads as a tint rather than a coat.
  // Only PICKED colours listen to it: a body-part highlight has its own
  // calibrated look (see #applyMuscleStyle).
  setMuscleTint(frac) {
    this.muscleTint = Math.min(1, Math.max(0, frac));
    this.#applyMuscleStyle();
  }

  // Set a material's transparency IN PLACE. `transparent` is not an ordinary
  // uniform: three bakes it into the shader program (`opaque` is a program
  // parameter → `#define OPAQUE`, and an opaque program forces the fragment's
  // alpha to 1), so flipping the flag on an already-compiled material changes
  // NOTHING on screen until the program is rebuilt. That is exactly what made
  // "Fade others" look broken — every faded belly carried opacity 0.06 and went
  // on rendering solid. Only flag a rebuild when the value really changed;
  // recompiling a shader per call would be a real cost.
  //
  // (The body-part highlight escapes this because it swaps in CLONED variant
  // materials, which compile once with the flag they are born with.)
  static setTransparency(mat, transparent, opacity, depthWrite) {
    if (mat.transparent !== transparent) {
      mat.transparent = transparent;
      mat.needsUpdate = true;
    }
    mat.opacity = opacity;
    mat.depthWrite = depthWrite;
  }

  // Resolve each imported muscle belly's look from three inputs: the panel's
  // hidden set (transparent), its highlight set (warm glow), and the body-part
  // highlight (dim the bellies outside the chosen part). Each belly owns its
  // material, so states are set in place. Fallback (procedural) muscles carry no
  // isMuscle flag and keep flowing through #applyHighlight instead.
  #applyMuscleStyle() {
    const hidden = this.hiddenMuscles;
    const lit = this.litMuscles;
    const parts = this.highlightParts;
    for (const mesh of this.layerMeshes.muscle) {
      if (!mesh.userData.isMuscle) continue;
      const label = mesh.userData.muscleName;
      let state;
      let partColor = null; // set only when the body-part highlight is what lights it
      if (hidden && hidden.has(label)) state = 'hidden';
      // A bare label lights both sides; `${label}|L` / `|R` lights one (the
      // movement clips light only the moving side's prime movers).
      else if (lit && (lit.has(label) || lit.has(`${label}|${mesh.userData.muscleSide}`))) state = 'lit';
      else if (parts) {
        const jointName = this.#jointNameOf(mesh);
        const part = jointName ? PART_OF_NODE[jointName] : null;
        state = parts.has(part) ? 'lit' : 'dim';
        if (state === 'lit') partColor = this.#partColor(part);
      } else state = 'normal';

      const mat = mesh.material;
      if (state === 'lit') {
        // A colour picked for THIS belly beats the body part's hue beneath it.
        const own = this.muscleColors?.get(label) ?? null;
        const hue = own ?? partColor;
        if (own) {
          // A PICKED colour renders as picked: mixing it halfway to white (what
          // the body-part hue below does, so a whole lit region still reads as
          // flesh over the bones) makes the belly visibly paler than the swatch
          // the user chose it from. The strength slider mixes back toward the
          // belly's own flesh colour instead of toward white, so turning it
          // down desaturates the tint rather than bleaching it.
          const t = this.muscleTint ?? 1;
          mat.color.setHex(mesh.userData.muscleBaseColor).lerp(_hl.set(hue), t);
          mat.emissive.set(hue);
          mat.emissiveIntensity = 0.5 * t;
          Figure.setTransparency(mat, false, 1, true);
          mesh.castShadow = true;
          continue;
        }
        if (hue) {
          // The belly takes the hue, lightened so it still reads as flesh
          // over the bones, with the pure hue as its glow.
          mat.emissive.set(hue);
          mat.color.set(hue).lerp(WHITE, 0.45);
        } else {
          mat.color.setHex(MUSCLE_HL_COLOR);
          mat.emissive.setHex(MUSCLE_HL_EMISSIVE);
        }
        mat.emissiveIntensity = 0.5;
        Figure.setTransparency(mat, false, 1, true);
      } else {
        mat.color.setHex(mesh.userData.muscleBaseColor);
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 1;
        if (state === 'hidden') Figure.setTransparency(mat, true, MUSCLE_HIDDEN_OPACITY, false);
        else if (state === 'dim') Figure.setTransparency(mat, true, 0.13, false);
        else Figure.setTransparency(mat, false, 1, true);
      }
      mesh.castShadow = state !== 'hidden';
    }
  }

  #applyHighlight() {
    const parts = this.highlightParts;
    this.group.traverse((o) => {
      if (!o.isMesh || o.userData.isPick) return;
      if (o.userData.isMuscle) return; // imported muscles are styled by #applyMuscleStyle
      o.userData.baseMaterial ??= o.material;
      const base = o.userData.baseMaterial;
      if (!parts || o.userData.noHighlight) {
        // The imported body avatar is one continuous skin — it can't light up
        // a single part, so it keeps its normal look during highlights (the
        // skeleton/muscle layers carry the emphasis).
        o.material = base;
        return;
      }
      // Skinned muscles hang off the group, not a joint node, so they carry the
      // joint they belong to explicitly; everything else walks up to its node.
      const jointName = this.#jointNameOf(o);
      const part = jointName ? PART_OF_NODE[jointName] : null;
      o.material = parts.has(part)
        ? this.#highlightVariant(base, 'lit', this.#partColor(part))
        : this.#highlightVariant(base, 'dim');
    });
  }

  setLayers({ skeleton, body, muscle }) {
    this.layers = { skeleton, body, muscle };
    for (const m of this.layerMeshes.skeleton) m.visible = skeleton;
    for (const m of this.layerMeshes.body) m.visible = body;
    for (const m of this.layerMeshes.muscle) m.visible = muscle;
    // The shoe/heel outline stands in for the (hidden) shoe: show it whenever
    // the body avatar is off, i.e. in the skeleton and muscle views.
    for (const g of this.heelOutline) g.visible = skeleton || muscle;
    // Joint spheres are click targets, not anatomy: keep them faint in skeleton
    // view (the bones already show the joints) and invisible-but-clickable
    // otherwise. Raycasting ignores opacity, so picking is unaffected.
    for (const s of this.pickSpheres) {
      s.material.opacity = skeleton ? 0.22 : 0;
      s.material.depthWrite = false;
      // Restore the resting depth state: hover (main.js) draws the spheres
      // through the opaque avatar, and a layer switch must not strand them there.
      s.material.depthTest = true;
      s.renderOrder = 0;
    }
  }

  // Pull a joint back inside its anatomical range. Returns HOW FAR it had to
  // move — the largest per-axis |before − after|, in radians, or 0 if the pose
  // was already legal. That return is the only trace a clamp leaves: without
  // it a limb simply stops and the app looks broken rather than anatomical.
  // The per-frame solvers (solveTwoBone, flattenFoot, groundPlantedLeg,
  // pivotHips, the embrace) clamp constantly as part of converging and ignore
  // it; only the direct user-edit paths in main.js report it.
  clampJoint(name) {
    const def = JOINT_BY_NAME[name];
    if (!def || !def.limits) return 0;
    const r = this.nodes[name].rotation;
    let worst = 0;
    for (const ax of ['x', 'y', 'z']) {
      const before = r[ax];
      const after = clampAngle(before, def.limits[ax]);
      if (after === before) continue;
      r[ax] = after;
      worst = Math.max(worst, Math.abs(after - before));
    }
    return worst;
  }

  getPose() {
    const joints = {};
    for (const def of JOINTS) {
      if (def.endpoint) continue;
      const r = this.nodes[def.name].rotation;
      joints[def.name] = [r.x, r.y, r.z];
    }
    return {
      position: this.group.position.toArray(),
      quaternion: this.group.quaternion.toArray(),
      facing: this.group.rotation.y,
      pelvisY: this.nodes.pelvis.position.y / this.height, // stored as fraction of height
      joints,
      handCurl: { ...this.handCurl },
    };
  }

  setPose(pose) {
    if (pose.position) this.group.position.fromArray(pose.position);
    if (pose.quaternion) this.group.quaternion.fromArray(pose.quaternion);
    else if (pose.facing !== undefined) this.group.rotation.y = pose.facing;
    if (pose.pelvisY !== undefined) this.nodes.pelvis.position.y = pose.pelvisY * this.height;
    for (const [name, [x, y, z]] of Object.entries(pose.joints || {})) {
      const node = this.nodes[name];
      if (!node) continue;
      node.rotation.set(x, y, z);
      this.clampJoint(name);
    }
    // Restore hand shape if the pose carried one (older poses omit it — leave
    // the hands as they are rather than forcing them open).
    if (pose.handCurl) {
      for (const side of ['L', 'R']) {
        if (pose.handCurl[side] !== undefined) this.setHandCurl(side, pose.handCurl[side]);
      }
    }
    this.syncAtlasNodes(); // pivot the skeletal limb bones about the anatomical joints
    this.group.updateMatrixWorld(true);
    this.updateMuscleSkin(); // keep bi-articular muscles in step (e.g. ghosts, interp)
  }

  resetPose() {
    for (const def of JOINTS) {
      if (!def.endpoint) this.nodes[def.name].rotation.set(0, 0, 0);
    }
    this.nodes.pelvis.position.set(0, 0.530 * this.height, 0);
    // Undo any closed-chain tilt of the root, keeping only floor position + yaw.
    const yaw = this.group.rotation.y;
    this.group.position.y = 0;
    this.group.rotation.set(0, yaw, 0);
    this.syncAtlasNodes();
    this.group.updateMatrixWorld(true);
  }

  // Convenience for authoring presets: angles in degrees.
  setJointDegrees(map) {
    for (const [name, axes] of Object.entries(map)) {
      const node = this.nodes[name];
      if (!node) continue;
      if (axes.x !== undefined) node.rotation.x = axes.x * DEG;
      if (axes.y !== undefined) node.rotation.y = axes.y * DEG;
      if (axes.z !== undefined) node.rotation.z = axes.z * DEG;
      this.clampJoint(name);
    }
    this.syncAtlasNodes();
    this.group.updateMatrixWorld(true);
  }

  // Rig joint centre, world. This is the ANTHROPOMETRIC skeleton (Drillis–
  // Contini), and it is the right thing for BIOMECHANICS — computeCOG lerps de
  // Leva segment masses between exactly these points, and the joint-angle and
  // balance readouts are defined on them. It is the WRONG thing for anything
  // about where the body physically is; see surfaceNode/surfacePos.
  worldPos(jointName, target = new THREE.Vector3()) {
    return this.nodes[jointName].getWorldPosition(target);
  }

  // The node the VISIBLE body is welded to: the atlas node on a seated limb
  // joint, else the rig node (torso joints, where the two coincide).
  //
  // Use this for contact — collision volumes, pin spots, anything asking where
  // the dancer physically IS. Measured across six poses, the difference is not
  // subtle: the visible palm sits 165 mm from the rig wrist and wanders 107 mm
  // inside it as the arm flexes, while in the ATLAS wrist it sits a steady
  // 39 mm away and wanders 0.0 mm. The elbow is 97 mm / 111 mm versus 37 mm /
  // 15 mm. A capsule or a pin built on the rig node is displaced from the limb
  // it represents by more than that limb's own radius.
  surfaceNode(jointName) {
    return this.#seatNode(jointName);
  }

  surfacePos(jointName, target = new THREE.Vector3()) {
    return this.#seatNode(jointName).getWorldPosition(target);
  }

  // Lowest sole corner of one foot ('L' | 'R'), world Y — how far this foot's
  // sole (heel, ball and toe corners; the heeled follower's dropped set) is
  // off the floor. The walk uses it to land a heel-strike or a grazing toe
  // exactly on y = 0 whatever the ankle pitch.
  footLowY(side) {
    this.group.updateMatrixWorld(true);
    const H = this.height;
    let minY = Infinity;
    for (const [nodeName, corners] of [
      [`ankle_${side}`, this.footCorners?.[`_${side}`] ?? (side === 'L' ? FOOT_CORNERS_L : FOOT_CORNERS_R)],
      [`toes_${side}`, this.toeCorners?.[`_${side}`] ?? (side === 'L' ? TOE_CORNERS_L : TOE_CORNERS_R)],
    ]) {
      const node = this.nodes[nodeName];
      for (const [x, y, z] of corners) {
        _floorPt.set(x * H, y * H, z * H);
        node.localToWorld(_floorPt);
        if (_floorPt.y < minY) minY = _floorPt.y;
      }
    }
    return minY;
  }

  // Lowest floor-relevant point of the body: foot sole corners plus every
  // joint padded by its flesh clearance.
  lowestPointY() {
    this.group.updateMatrixWorld(true);
    const H = this.height;
    let minY = Infinity;
    for (const [nodeName, corners] of [
      ['ankle_L', this.footCorners?._L ?? FOOT_CORNERS_L], ['ankle_R', this.footCorners?._R ?? FOOT_CORNERS_R],
      ['toes_L', this.toeCorners?._L ?? TOE_CORNERS_L], ['toes_R', this.toeCorners?._R ?? TOE_CORNERS_R],
    ]) {
      const node = this.nodes[nodeName];
      for (const [x, y, z] of corners) {
        _floorPt.set(x * H, y * H, z * H);
        node.localToWorld(_floorPt);
        if (_floorPt.y < minY) minY = _floorPt.y;
      }
    }
    for (const def of JOINTS) {
      if (CORNER_NODES.has(def.name)) continue; // the sole corners own the foot
      this.nodes[def.name].getWorldPosition(_floorPt);
      const y = _floorPt.y - (FLOOR_CLEARANCE[def.name] ?? 0.02) * H;
      if (y < minY) minY = y;
    }
    return minY;
  }

  // Keep the body out of the floor: lift the root if anything is below it,
  // and settle back down only by undoing a previous lift (group.position.y
  // is 0 unless collision or a closed-chain edit moved it).
  clampToFloor() {
    const minY = this.lowestPointY();
    if (minY < -1e-4) {
      this.group.position.y -= minY;
      this.group.updateMatrixWorld(true);
    } else if (this.group.position.y > 1e-4 && minY > 1e-4) {
      this.group.position.y -= Math.min(minY, this.group.position.y);
      this.group.updateMatrixWorld(true);
    }
  }

  setHeight(h) {
    const pose = this.getPose();
    const layers = { ...this.layers };
    this.height = h;
    this.dispose();
    this.pickSpheres = [];
    this.layerMeshes = { skeleton: [], body: [], muscle: [] };
    this.heelOutline = [];
    this.jointSphereByName = {};
    this._skinMuscles = [];
    this.nodes = {};
    this.#build();
    this.setPose(pose);
    this.setLayers(layers);
    this.#applyHighlight();
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.group.clear();
  }
}
