import * as THREE from 'three';

// Procedural skeleton and muscle geometry. Everything is expressed in fractions
// of body height H and attached into a Figure's joint nodes, so it bends with
// the pose and rescales with height. Shapes are anatomically suggestive rather
// than medically exact: recognisable skull, ribcage, spine, pelvis, condylar
// long bones, and fusiform muscle bellies.

const Y = new THREE.Vector3(0, 1, 0);

function alignY(mesh, a, b) {
  const dir = b.clone().sub(a);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  if (dir.lengthSq() > 1e-12) mesh.quaternion.setFromUnitVectors(Y, dir.clone().normalize());
  return mesh;
}

function perpendicular(dir) {
  const p = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, 1));
  if (p.lengthSq() < 1e-8) p.crossVectors(dir, new THREE.Vector3(1, 0, 0));
  return p.normalize();
}

// A fusiform (spindle) belly: length 1 along Y, max radius 1. Scale per muscle.
let _spindle = null;
export function spindleGeometry() {
  if (_spindle) return _spindle;
  const pts = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = Math.max(0.02, Math.pow(Math.sin(Math.PI * t), 0.7));
    pts.push(new THREE.Vector2(r, t - 0.5));
  }
  _spindle = new THREE.LatheGeometry(pts, 16);
  return _spindle;
}

// ------------------------------------------------------------------- skeleton

// Long bone: a shaft plus rounded condyles at each end; optionally two parallel
// shafts (forearm, lower leg).
// Small primitives shared by the anatomical builders: an ellipsoid knob and a
// tapered shaft (radii are fractions of height; rB is the radius at end b).
function ball(fig, nodeName, x, y, z, r, sx = 1, sy = 1, sz = 1, mat = 'bone', cast = true) {
  const H = fig.height;
  const m = new THREE.Mesh(new THREE.SphereGeometry(r * H, 12, 10), fig.materials[mat]);
  m.position.set(x * H, y * H, z * H);
  m.scale.set(sx, sy, sz);
  fig.addMesh(nodeName, m, 'skeleton', cast);
  return m;
}

function shaft(fig, nodeName, a, b, rA, rB, mat = 'bone') {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(rB * fig.height, rA * fig.height, a.distanceTo(b), 10),
    fig.materials[mat],
  );
  alignY(m, a, b);
  fig.addMesh(nodeName, m, 'skeleton');
  return m;
}

function longBone(fig, nodeName, a, b, { rMid, rEnd, double = false, sep = 0 }) {
  const H = fig.height;
  const dir = b.clone().sub(a);
  const len = dir.length();
  if (len < 1e-6) return;
  const shaftLen = len * 0.8;
  const perp = perpendicular(dir).multiplyScalar(sep * H);
  const offsets = double ? [perp, perp.clone().negate()] : [new THREE.Vector3()];
  for (const off of offsets) {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(rMid * H, rMid * H, shaftLen, 12),
      fig.materials.bone,
    );
    alignY(shaft, a.clone().add(off), b.clone().add(off));
    fig.addMesh(nodeName, shaft, 'skeleton');
  }
  // Condyles at both ends (shared centre for double bones).
  for (const end of [a, b]) {
    const knob = new THREE.Mesh(new THREE.SphereGeometry(rEnd * H, 14, 10), fig.materials.cartilage);
    knob.position.copy(end);
    knob.scale.set(1, 0.85, 1);
    fig.addMesh(nodeName, knob, 'skeleton');
  }
}

function skull(fig) {
  const H = fig.height;
  const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.058 * H, 20, 16), fig.materials.bone);
  cranium.position.set(0, 0.058 * H, -0.002 * H);
  cranium.scale.set(0.92, 1.02, 1);
  fig.addMesh('head', cranium, 'skeleton');
  // Face / maxilla.
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.042 * H, 16, 12), fig.materials.bone);
  face.position.set(0, 0.03 * H, 0.03 * H);
  face.scale.set(0.85, 0.9, 0.8);
  fig.addMesh('head', face, 'skeleton');
  // Jaw.
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.032 * H, 14, 10), fig.materials.bone);
  jaw.position.set(0, 0.006 * H, 0.024 * H);
  jaw.scale.set(0.9, 0.55, 0.95);
  fig.addMesh('head', jaw, 'skeleton');
  // Eye sockets.
  for (const sx of [-1, 1]) {
    const orbit = new THREE.Mesh(new THREE.SphereGeometry(0.014 * H, 10, 8), fig.materials.socket);
    orbit.position.set(sx * 0.02 * H, 0.036 * H, 0.05 * H);
    fig.addMesh('head', orbit, 'skeleton', false);
  }
}

function vertebra(fig, nodeName, y, radius, H) {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(radius * H, radius * H, 0.016 * H, 10), fig.materials.bone);
  body.position.set(0, y * H, 0);
  fig.addMesh(nodeName, body, 'skeleton');
  const spinous = new THREE.Mesh(new THREE.SphereGeometry(0.009 * H, 8, 6), fig.materials.bone);
  spinous.position.set(0, y * H, -radius * H - 0.006 * H);
  spinous.scale.set(0.7, 0.9, 1.4);
  fig.addMesh(nodeName, spinous, 'skeleton', false);
}

function spineColumn(fig) {
  // Discs interpolated along each trunk segment, attached to the lower node so
  // they follow that segment's bend.
  const segs = [
    ['pelvis', 'spine', 0.021, 3],
    ['spine', 'chest', 0.020, 3],
    ['chest', 'neck', 0.018, 3],
    ['neck', 'head', 0.013, 2],
  ];
  for (const [parent, child, r, n] of segs) {
    const end = fig.nodes[child].position; // child offset in parent frame
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      vertebra(fig, parent, (end.y * t) / fig.height, r, fig.height);
    }
  }
}

function ribcage(fig) {
  const H = fig.height;
  // Attached to the chest node; the cage hangs below it toward the abdomen.
  const ribYs = [0.045, 0.01, -0.025, -0.06, -0.093, -0.123, -0.148];
  ribYs.forEach((y, i) => {
    const t = i / (ribYs.length - 1);
    const width = 0.093 * H * Math.sin(Math.PI * (0.28 + 0.6 * t)) / Math.sin(Math.PI * 0.5);
    const rib = new THREE.Mesh(
      new THREE.TorusGeometry(width, 0.006 * H, 8, 24, Math.PI * 1.55),
      fig.materials.bone,
    );
    rib.rotation.x = Math.PI / 2;
    rib.rotation.z = Math.PI * 0.225; // open the gap toward the front
    rib.position.set(0, y * H, 0);
    rib.scale.set(1, 0.82, 1); // flatten front-to-back
    fig.addMesh('chest', rib, 'skeleton', false);
  });
  // Sternum.
  const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.02 * H, 0.11 * H, 0.01 * H), fig.materials.bone);
  sternum.position.set(0, -0.02 * H, 0.072 * H);
  fig.addMesh('chest', sternum, 'skeleton');
  // Shoulder girdle per side (shoulder joint at chest-local ±0.115, 0.110, 0).
  const v = (x, y, z) => new THREE.Vector3(x * H, y * H, z * H);
  for (const sx of [-1, 1]) {
    // Clavicle: S-curved strut from the sternal notch out to the acromion,
    // bowing forward over the first rib then sweeping back.
    shaft(fig, 'chest', v(sx * 0.014, 0.078, 0.062), v(sx * 0.062, 0.095, 0.040), 0.0055, 0.005);
    shaft(fig, 'chest', v(sx * 0.062, 0.095, 0.040), v(sx * 0.104, 0.118, 0.002), 0.005, 0.005);
    ball(fig, 'chest', sx * 0.062, 0.095, 0.040, 0.006, 1, 1, 1, 'bone', false);
    // Scapula: flat blade riding the back of the ribcage, lateral edge
    // swinging forward toward the glenoid.
    const blade = ball(fig, 'chest', sx * 0.078, 0.058, -0.050, 0.040, 0.75, 1.05, 0.18);
    blade.rotation.set(0, sx * 0.30, sx * 0.12);
    // Scapular spine ridge rising to the acromion above the humeral head.
    shaft(fig, 'chest', v(sx * 0.052, 0.088, -0.058), v(sx * 0.102, 0.115, -0.012), 0.005, 0.005);
    ball(fig, 'chest', sx * 0.106, 0.120, -0.004, 0.0075, 1.1, 0.7, 1.2);
    // Glenoid fossa: shallow socket facing the humeral head.
    ball(fig, 'chest', sx * 0.106, 0.104, -0.004, 0.011, 0.5, 1.1, 0.9, 'cartilage', false);
  }
}

// Pelvic ring: sacrum + coccyx at the back, flaring iliac wings with ASIS
// points, acetabular sockets cupping the femoral heads (hips at ±0.052H),
// and the pubic/ischial ring closing at the symphysis in front.
function pelvisBone(fig) {
  const H = fig.height;
  const v = (x, y, z) => new THREE.Vector3(x * H, y * H, z * H);

  // Sacrum: wedge between the wings, tipped forward at the top (nutation),
  // tapering to the coccyx.
  const sacrum = ball(fig, 'pelvis', 0, 0.028, -0.030, 0.026, 1.0, 1.25, 0.6);
  sacrum.rotation.x = 0.35;
  ball(fig, 'pelvis', 0, -0.004, -0.038, 0.008, 0.8, 1.1, 0.8, 'bone', false); // coccyx

  for (const sx of [-1, 1]) {
    // Iliac wing: broad blade flaring out at the crest, fossa opening forward.
    const ilium = ball(fig, 'pelvis', sx * 0.040, 0.035, -0.010, 0.042, 0.38, 1.0, 0.85);
    ilium.rotation.set(0, sx * 0.35, -sx * 0.40);
    // ASIS: the bony point at the front of the crest.
    ball(fig, 'pelvis', sx * 0.052, 0.028, 0.024, 0.008, 1, 1, 1, 'bone', false);
    // Acetabulum: socket cupping the femoral head from above/medial.
    ball(fig, 'pelvis', sx * 0.046, 0.006, -0.002, 0.023, 0.6, 1.0, 1.0, 'cartilage');
    // Pubic rami: superior to the symphysis, inferior down to the ischium.
    shaft(fig, 'pelvis', v(sx * 0.042, -0.006, 0.010), v(sx * 0.006, -0.020, 0.030), 0.007, 0.007);
    shaft(fig, 'pelvis', v(sx * 0.008, -0.026, 0.028), v(sx * 0.028, -0.042, 0.000), 0.006, 0.006);
    // Ischial tuberosity (sit bone).
    ball(fig, 'pelvis', sx * 0.030, -0.044, -0.004, 0.012, 0.85, 1.1, 1.0);
  }
  // Pubic symphysis joining the rami in front.
  ball(fig, 'pelvis', 0, -0.022, 0.030, 0.009, 0.9, 1.2, 0.7, 'cartilage', false);
}

function digits(fig, nodeName, base, count, length, spread, forward) {
  const H = fig.height;
  for (let i = 0; i < count; i++) {
    const f = count > 1 ? i / (count - 1) - 0.5 : 0;
    const a = new THREE.Vector3(base.x + f * spread * H, base.y, base.z);
    const b = new THREE.Vector3(base.x + f * spread * H * 1.1, base.y - length * H, base.z + forward * H);
    const finger = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006 * H, 0.005 * H, a.distanceTo(b), 6),
      fig.materials.bone,
    );
    alignY(finger, a, b);
    fig.addMesh(nodeName, finger, 'skeleton', false);
  }
}

function hand(fig, side) {
  const H = fig.height;
  const node = `wrist_${side}`;
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.045 * H, 0.05 * H, 0.016 * H), fig.materials.bone);
  palm.position.set(0, -0.03 * H, 0);
  fig.addMesh(node, palm, 'skeleton');
  digits(fig, node, new THREE.Vector3(0, -0.055 * H, 0), 4, 0.05, 0.038, 0);
  // Thumb.
  const t0 = new THREE.Vector3((side === 'L' ? 1 : -1) * 0.028 * H, -0.03 * H, 0.01 * H);
  const t1 = new THREE.Vector3((side === 'L' ? 1 : -1) * 0.045 * H, -0.055 * H, 0.02 * H);
  const thumb = new THREE.Mesh(new THREE.CylinderGeometry(0.006 * H, 0.005 * H, t0.distanceTo(t1), 6), fig.materials.bone);
  alignY(thumb, t0, t1);
  fig.addMesh(node, thumb, 'skeleton', false);
}

// One leg's bones. Lateral is +X on the left (s = 1), -X on the right; medial
// is the opposite. Femur lives on the hip node, tibia + fibula on the knee
// node, so the malleoli stay with the shank when the ankle flexes.
function legBones(fig, side) {
  const H = fig.height;
  const s = side === 'L' ? 1 : -1;
  const hip = `hip_${side}`;
  const knee = `knee_${side}`;
  const kY = fig.nodes[knee].position.y / H;                  // knee offset in hip frame
  const aY = fig.nodes[`ankle_${side}`].position.y / H;        // ankle offset in knee frame
  const v = (x, y, z) => new THREE.Vector3(x * H, y * H, z * H);

  // Femur: head at the joint, neck out to the greater trochanter, then a
  // shaft that angles back toward the midline (valgus) with a slight bow.
  ball(fig, hip, 0, 0, 0, 0.021, 1, 1, 1, 'cartilage');
  shaft(fig, hip, v(0, 0, 0), v(s * 0.028, -0.014, -0.003), 0.011, 0.012);
  ball(fig, hip, s * 0.028, -0.014, -0.003, 0.016, 0.9, 1.25, 0.9);
  shaft(fig, hip, v(s * 0.026, -0.030, -0.002), v(0, kY + 0.024, 0), 0.015, 0.017);
  // Medial + lateral condyles sweep backward; patella rides in front.
  for (const m of [-1, 1]) {
    ball(fig, hip, m * 0.0135, kY + 0.006, -0.004, 0.0165, 0.95, 0.9, 1.3, 'cartilage');
  }
  ball(fig, hip, 0, kY + 0.012, 0.024, 0.013, 1, 1.15, 0.6);

  // Tibia: plateau under the condyles, tuberosity on the front, strong shaft
  // running slightly medial and ending at the medial malleolus.
  ball(fig, knee, 0, -0.006, -0.002, 0.019, 1.15, 0.55, 1);
  ball(fig, knee, 0, -0.034, 0.016, 0.008, 1, 1.2, 0.8);
  shaft(fig, knee, v(-s * 0.004, -0.014, 0.002), v(-s * 0.008, aY + 0.02, 0.003), 0.0135, 0.010);
  ball(fig, knee, -s * 0.011, aY + 0.004, 0.002, 0.0095, 0.85, 1.15, 0.9, 'cartilage');
  // Fibula: thin lateral splint from below the plateau down to the lateral
  // malleolus, which rides lower than the medial one.
  ball(fig, knee, s * 0.020, -0.028, -0.008, 0.0085, 0.9, 1.1, 0.9);
  shaft(fig, knee, v(s * 0.020, -0.034, -0.008), v(s * 0.016, aY - 0.004, -0.002), 0.005, 0.0045);
  ball(fig, knee, s * 0.016, aY - 0.008, -0.002, 0.008, 0.8, 1.2, 0.9, 'cartilage');
}

// Foot: talus, calcaneus, midfoot tarsals, five arched metatarsal rays and
// toes. Medial (big-toe) side faces the midline: -X on the left foot, +X on
// the right. The sole plane sits at y = -0.039H (FOOT_CORNERS in
// skeletonDef.js); nothing here may dip below it or the floor clamp lifts
// the whole dancer. The phalanges attach to the toes (MTP) joint — at
// ankle-local (0, -0.030, 0.090) — so they hinge at the ball of the foot.
function foot(fig, side) {
  const H = fig.height;
  const s = side === 'L' ? 1 : -1;
  const node = `ankle_${side}`;
  const toes = `toes_${side}`;
  const v = (x, y, z) => new THREE.Vector3(x * H, y * H, z * H);
  // Same authoring coordinates as `v` (ankle-local), re-expressed in the
  // toes joint's frame.
  const tv = (x, y, z) => new THREE.Vector3(x * H, (y + 0.030) * H, (z - 0.090) * H);

  ball(fig, node, 0, -0.008, 0.002, 0.014, 1, 0.8, 1.1, 'cartilage'); // talus dome
  ball(fig, node, 0, -0.024, -0.030, 0.015, 1, 0.95, 1.75);           // calcaneus (heel)
  ball(fig, node, -s * 0.003, -0.018, 0.020, 0.012, 1.35, 0.8, 1.1);  // navicular + cuboid

  for (let i = 0; i < 5; i++) {
    const medial = -s; // ray 0 = big toe on the medial edge
    const bx = medial * (0.014 - i * 0.007);
    const hx = medial * (0.022 - i * 0.011);
    const baseY = -0.015 - i * 0.002;  // longitudinal arch: higher medially
    const headZ = 0.097 - i * 0.0065;  // oblique line of the ball of the foot
    const rMeta = i === 0 ? 0.006 : 0.0044;
    shaft(fig, node, v(bx, baseY, 0.030), v(hx, -0.029, headZ), rMeta, rMeta * 0.9);
    ball(fig, node, hx, -0.030, headZ, i === 0 ? 0.0068 : 0.005, 1, 0.9, 1, 'cartilage', false);
    // Toe descends from the ball to graze the sole plane.
    const tipZ = headZ + (i === 0 ? 0.030 : 0.024 - i * 0.003);
    const rToe = i === 0 ? 0.0052 : 0.0036;
    shaft(fig, toes, tv(hx, -0.029, headZ + 0.004), tv(hx * 1.05, -0.0345, tipZ), rToe, rToe * 0.8);
  }
}

export function buildSkeleton(fig) {
  const H = fig.height;
  const off = (name) => fig.nodes[name].position.clone();

  // Arm long bones stay table-driven; legs get the anatomical builder below.
  const LONG = {
    elbow_L: { rMid: 0.013, rEnd: 0.021 }, elbow_R: { rMid: 0.013, rEnd: 0.021 },
    wrist_L: { rMid: 0.009, rEnd: 0.015, double: true, sep: 0.009 },
    wrist_R: { rMid: 0.009, rEnd: 0.015, double: true, sep: 0.009 },
    shoulder_L: { rMid: 0.009, rEnd: 0.013 }, shoulder_R: { rMid: 0.009, rEnd: 0.013 },
  };
  for (const [child, style] of Object.entries(LONG)) {
    const parent = fig.nodes[child].userData.def.parent;
    longBone(fig, parent, new THREE.Vector3(), off(child), style);
  }

  skull(fig);
  spineColumn(fig);
  ribcage(fig);
  pelvisBone(fig);
  for (const side of ['L', 'R']) { legBones(fig, side); hand(fig, side); foot(fig, side); }
}

// -------------------------------------------------------------------- muscles

const MUSCLES_LEFT = [
  // Thigh.
  { node: 'hip_L', pa: [0.006, -0.02, 0.032], pb: [0.004, -0.20, 0.026], r: 0.028, name: 'Rectus femoris' },
  { node: 'hip_L', pa: [0.03, -0.03, 0.02], pb: [0.016, -0.20, 0.024], r: 0.024, name: 'Vastus lateralis' },
  { node: 'hip_L', pa: [-0.02, -0.05, 0.018], pb: [-0.006, -0.20, 0.024], r: 0.02, name: 'Vastus medialis' },
  { node: 'hip_L', pa: [0.004, -0.03, -0.03], pb: [0.002, -0.215, -0.024], r: 0.03, name: 'Hamstrings' },
  // Glute max: sacrum/posterior ilium (above the joint) down-and-out to the
  // gluteal tuberosity about a third of the way down the femur.
  { node: 'hip_L', pa: [0.006, 0.025, -0.038], pb: [0.014, -0.085, -0.022], r: 0.042, name: 'Gluteus maximus' },
  // Glute med: lateral hip stabiliser, iliac crest to greater trochanter.
  { node: 'hip_L', pa: [0.030, 0.028, -0.006], pb: [0.033, -0.028, -0.004], r: 0.021, name: 'Gluteus medius' },
  // Iliopsoas: crosses the front of the hip to the lesser trochanter (medial).
  { node: 'hip_L', pa: [0.004, 0.030, 0.018], pb: [-0.002, -0.045, 0.030], r: 0.016, name: 'Iliopsoas' },
  { node: 'hip_L', pa: [-0.018, -0.02, 0.0], pb: [-0.006, -0.18, 0.008], r: 0.024, name: 'Adductors' },
  { node: 'hip_L', pa: [0.028, -0.01, 0.026], pb: [-0.012, -0.2, 0.014], r: 0.011, name: 'Sartorius' },
  // Shank. Gastroc heads originate on the femoral condyles (knee level);
  // soleus runs on toward the Achilles.
  { node: 'knee_L', pa: [0.014, -0.004, -0.028], pb: [0.01, -0.12, -0.02], r: 0.026, name: 'Gastrocnemius (lat)' },
  { node: 'knee_L', pa: [-0.014, -0.004, -0.028], pb: [-0.01, -0.12, -0.02], r: 0.026, name: 'Gastrocnemius (med)' },
  { node: 'knee_L', pa: [0.0, -0.06, -0.025], pb: [0.0, -0.195, -0.02], r: 0.02, name: 'Soleus' },
  // Tib ant: lateral upper tibia, crossing to insert at the medial ankle.
  { node: 'knee_L', pa: [0.012, -0.03, 0.022], pb: [-0.004, -0.19, 0.016], r: 0.014, name: 'Tibialis anterior' },
  // Peroneals: down the lateral face of the fibula toward the lateral malleolus.
  { node: 'knee_L', pa: [0.018, -0.035, -0.006], pb: [0.014, -0.20, -0.002], r: 0.010, name: 'Peroneals' },
  // Upper arm.
  { node: 'shoulder_L', pa: [0.016, 0.014, 0], pb: [0.006, -0.06, 0], r: 0.032, name: 'Deltoid' },
  { node: 'shoulder_L', pa: [0.004, -0.05, 0.02], pb: [0.002, -0.16, 0.014], r: 0.022, name: 'Biceps' },
  { node: 'shoulder_L', pa: [0.002, -0.05, -0.022], pb: [0.002, -0.17, -0.014], r: 0.022, name: 'Triceps' },
  // Forearm.
  { node: 'elbow_L', pa: [0.006, -0.02, 0.014], pb: [0.003, -0.11, 0.006], r: 0.018, name: 'Forearm flexors' },
  { node: 'elbow_L', pa: [-0.008, -0.02, -0.012], pb: [-0.004, -0.11, -0.006], r: 0.015, name: 'Forearm extensors' },
];

// Central / trunk muscles (not mirrored, placed once per side inline).
const MUSCLES_CENTER = [
  { node: 'chest', pa: [0.085, 0.09, 0.04], pb: [0.012, 0.055, 0.055], r: 0.03, name: 'Pectoralis L' },
  { node: 'chest', pa: [-0.085, 0.09, 0.04], pb: [-0.012, 0.055, 0.055], r: 0.03, name: 'Pectoralis R' },
  { node: 'chest', pa: [0.05, 0.12, -0.03], pb: [0.01, 0.02, -0.03], r: 0.026, name: 'Trapezius L' },
  { node: 'chest', pa: [-0.05, 0.12, -0.03], pb: [-0.01, 0.02, -0.03], r: 0.026, name: 'Trapezius R' },
  // Lats sweep from the armpit down to the thoracolumbar fascia — they stay
  // on the back, so the lower end keeps a negative z.
  { node: 'chest', pa: [0.07, 0.0, -0.02], pb: [0.02, -0.12, -0.028], r: 0.024, name: 'Latissimus L' },
  { node: 'chest', pa: [-0.07, 0.0, -0.02], pb: [-0.02, -0.12, -0.028], r: 0.024, name: 'Latissimus R' },
  // Rectus abdominis runs pubis → ribs; start below the spine node to reach
  // toward the pubic attachment.
  { node: 'spine', pa: [0.02, -0.04, 0.05], pb: [0.02, 0.095, 0.048], r: 0.022, name: 'Rectus abdominis L' },
  { node: 'spine', pa: [-0.02, -0.04, 0.05], pb: [-0.02, 0.095, 0.048], r: 0.022, name: 'Rectus abdominis R' },
  { node: 'spine', pa: [0.05, 0.005, 0.014], pb: [0.038, 0.085, 0.032], r: 0.02, name: 'Obliques L' },
  { node: 'spine', pa: [-0.05, 0.005, 0.014], pb: [-0.038, 0.085, 0.032], r: 0.02, name: 'Obliques R' },
  { node: 'spine', pa: [0.02, 0.0, -0.046], pb: [0.02, 0.095, -0.046], r: 0.017, name: 'Erector spinae L' },
  { node: 'spine', pa: [-0.02, 0.0, -0.046], pb: [-0.02, 0.095, -0.046], r: 0.017, name: 'Erector spinae R' },
  // SCM: sternum/clavicle up to the mastoid process just behind the ear
  // (head node sits at neck-local y=0.05, mastoid a little above that).
  { node: 'neck', pa: [0.02, 0.005, 0.03], pb: [0.04, 0.075, -0.01], r: 0.012, name: 'Sternocleidomastoid L' },
  { node: 'neck', pa: [-0.02, 0.005, 0.03], pb: [-0.04, 0.075, -0.01], r: 0.012, name: 'Sternocleidomastoid R' },
];

const MUSCLES = [
  ...MUSCLES_LEFT,
  ...MUSCLES_LEFT.map((m) => ({
    ...m,
    node: m.node.replace('_L', '_R'),
    pa: [-m.pa[0], m.pa[1], m.pa[2]],
    pb: [-m.pb[0], m.pb[1], m.pb[2]],
    name: m.name.replace('(lat)', '(lat R)'),
  })),
  ...MUSCLES_CENTER,
];

export function buildMuscles(fig) {
  const H = fig.height;
  const geo = spindleGeometry();
  MUSCLES.forEach((m, i) => {
    const a = new THREE.Vector3(m.pa[0] * H, m.pa[1] * H, m.pa[2] * H);
    const b = new THREE.Vector3(m.pb[0] * H, m.pb[1] * H, m.pb[2] * H);
    const len = a.distanceTo(b);
    const mesh = new THREE.Mesh(geo, i % 2 ? fig.materials.muscleA : fig.materials.muscleB);
    alignY(mesh, a, b);
    mesh.scale.set(m.r * H, len, m.r * H);
    mesh.userData.muscleName = m.name;
    fig.addMesh(m.node, mesh, 'muscle');
  });
}
