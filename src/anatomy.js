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
  // Clavicle + scapula per side.
  for (const sx of [-1, 1]) {
    const scap = new THREE.Mesh(new THREE.SphereGeometry(0.03 * H, 12, 8), fig.materials.bone);
    scap.position.set(sx * 0.075 * H, 0.075 * H, -0.045 * H);
    scap.scale.set(0.7, 1.1, 0.35);
    fig.addMesh('chest', scap, 'skeleton', false);
  }
}

function pelvisBone(fig) {
  const H = fig.height;
  // Sacrum.
  const sacrum = new THREE.Mesh(new THREE.SphereGeometry(0.028 * H, 12, 10), fig.materials.bone);
  sacrum.position.set(0, 0.02 * H, -0.028 * H);
  sacrum.scale.set(0.9, 1.1, 0.7);
  fig.addMesh('pelvis', sacrum, 'skeleton');
  // Iliac wings.
  for (const sx of [-1, 1]) {
    const ilium = new THREE.Mesh(new THREE.SphereGeometry(0.05 * H, 16, 12), fig.materials.bone);
    ilium.position.set(sx * 0.045 * H, 0.02 * H, 0.004 * H);
    ilium.scale.set(0.5, 0.95, 0.85);
    ilium.rotation.z = sx * 0.35;
    fig.addMesh('pelvis', ilium, 'skeleton');
    // Ischium / pubis (sit bone) lower and forward.
    const ischium = new THREE.Mesh(new THREE.SphereGeometry(0.024 * H, 10, 8), fig.materials.bone);
    ischium.position.set(sx * 0.03 * H, -0.04 * H, 0.006 * H);
    ischium.scale.set(0.8, 0.8, 0.9);
    fig.addMesh('pelvis', ischium, 'skeleton', false);
  }
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

function foot(fig, side) {
  const H = fig.height;
  const node = `ankle_${side}`;
  // Tarsals / heel block.
  const heel = new THREE.Mesh(new THREE.BoxGeometry(0.05 * H, 0.03 * H, 0.06 * H), fig.materials.bone);
  heel.position.set(0, -0.028 * H, -0.01 * H);
  fig.addMesh(node, heel, 'skeleton');
  // Metatarsals + toes reaching forward.
  digits(fig, node, new THREE.Vector3(0, -0.035 * H, 0.02 * H), 5, -0.005, 0.05, 0.11);
}

export function buildSkeleton(fig) {
  const H = fig.height;
  const off = (name) => fig.nodes[name].position.clone();

  const LONG = {
    knee_L: { rMid: 0.017, rEnd: 0.030 }, knee_R: { rMid: 0.017, rEnd: 0.030 },
    ankle_L: { rMid: 0.011, rEnd: 0.024, double: true, sep: 0.011 },
    ankle_R: { rMid: 0.011, rEnd: 0.024, double: true, sep: 0.011 },
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
  for (const side of ['L', 'R']) { hand(fig, side); foot(fig, side); }
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
