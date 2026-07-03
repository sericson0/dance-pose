// Anatomical skeleton definition.
//
// Rest pose: standing upright, arms hanging at the sides, facing +Z. Y is up.
// All joint offsets are fractions of total body height H (standard anthropometric
// proportions, after Drillis & Contini) and get multiplied by the figure's height.
//
// Axis conventions in each joint's local frame:
//   X — sagittal-plane rotation (flexion/extension)
//   Y — twist about the vertical / long bone axis (internal/external rotation)
//   Z — frontal-plane rotation (ab/adduction, side bend)
//
// Limits are degrees [min, max] in the rest-pose frame; [0, 0] locks the axis.
// Signs follow the right-hand rule, so e.g. hip flexion (leg swings forward,
// toward +Z) is negative X. Slider labels below name both directions.

export const DEG = Math.PI / 180;

const free = [-180, 180];

// Left-side and central joints; right side is mirrored automatically.
const LEFT_AND_CENTER = [
  {
    name: 'pelvis', parent: null, offset: [0, 0.530, 0],
    limits: { x: free, y: free, z: free },
    labels: { x: 'Tilt back / forward', y: 'Turn right / left', z: 'Tilt right / left' },
  },
  {
    name: 'spine', parent: 'pelvis', offset: [0, 0.090, 0],
    limits: { x: [-15, 40], y: [-20, 20], z: [-20, 20] },
    labels: { x: 'Extend / bend forward', y: 'Twist right / left', z: 'Bend right / left' },
  },
  {
    name: 'chest', parent: 'spine', offset: [0, 0.100, 0],
    limits: { x: [-20, 25], y: [-25, 25], z: [-20, 20] },
    labels: { x: 'Extend / bend forward', y: 'Twist right / left', z: 'Bend right / left' },
  },
  {
    name: 'neck', parent: 'chest', offset: [0, 0.110, 0],
    limits: { x: [-40, 50], y: [-70, 70], z: [-35, 35] },
    labels: { x: 'Look up / down', y: 'Turn right / left', z: 'Tilt right / left' },
  },
  {
    name: 'head', parent: 'neck', offset: [0, 0.050, 0],
    limits: { x: [-25, 25], y: [-40, 40], z: [-20, 20] },
    labels: { x: 'Nod up / down', y: 'Turn right / left', z: 'Tilt right / left' },
  },
  { name: 'headTop', parent: 'head', offset: [0, 0.110, 0], endpoint: true },

  {
    name: 'shoulder_L', parent: 'chest', offset: [0.115, 0.110, 0],
    limits: { x: [-170, 45], y: [-80, 80], z: [-30, 170] },
    labels: { x: 'Raise forward / lower back', y: 'Rotate in / out', z: 'Across body / out to side' },
  },
  {
    name: 'elbow_L', parent: 'shoulder_L', offset: [0, -0.186, 0],
    limits: { x: [-150, 0], y: [-85, 85], z: [0, 0] },
    labels: { x: 'Bend / straighten', y: 'Palm turn (pronation)' },
  },
  {
    name: 'wrist_L', parent: 'elbow_L', offset: [0, -0.146, 0],
    limits: { x: [-65, 65], y: [0, 0], z: [-30, 30] },
    labels: { x: 'Flex / extend', z: 'Deviate out / in' },
  },
  { name: 'hand_L', parent: 'wrist_L', offset: [0, -0.100, 0], endpoint: true },

  {
    name: 'hip_L', parent: 'pelvis', offset: [0.052, 0, 0],
    limits: { x: [-120, 15], y: [-40, 40], z: [-25, 45] },
    labels: { x: 'Leg forward / back', y: 'Rotate in / out', z: 'Toward midline / out to side' },
  },
  {
    name: 'knee_L', parent: 'hip_L', offset: [0, -0.245, 0],
    limits: { x: [0, 145], y: [0, 0], z: [0, 0] },
    labels: { x: 'Straighten / bend' },
  },
  {
    name: 'ankle_L', parent: 'knee_L', offset: [0, -0.246, 0],
    limits: { x: [-25, 45], y: [0, 0], z: [-20, 20] },
    labels: { x: 'Toes up / point toes', z: 'Roll out / in' },
  },
  { name: 'toe_L', parent: 'ankle_L', offset: [0, -0.035, 0.125], endpoint: true },
];

function mirrorJoint(j) {
  const m = {
    ...j,
    name: j.name.replace('_L', '_R'),
    parent: j.parent.replace('_L', '_R'),
    offset: [-j.offset[0], j.offset[1], j.offset[2]],
  };
  if (j.limits) {
    // Mirroring across the sagittal plane flips the sign of Y and Z rotations.
    m.limits = {
      x: j.limits.x,
      y: [-j.limits.y[1], -j.limits.y[0]],
      z: [-j.limits.z[1], -j.limits.z[0]],
    };
  }
  return m;
}

export const JOINTS = [
  ...LEFT_AND_CENTER,
  ...LEFT_AND_CENTER.filter((j) => j.name.endsWith('_L')).map(mirrorJoint),
];

export const JOINT_BY_NAME = Object.fromEntries(JOINTS.map((j) => [j.name, j]));

// Human-readable joint names for the UI.
export const JOINT_TITLES = {
  pelvis: 'Pelvis', spine: 'Lower spine', chest: 'Upper spine', neck: 'Neck', head: 'Head',
  shoulder_L: 'Left shoulder', elbow_L: 'Left elbow', wrist_L: 'Left wrist',
  shoulder_R: 'Right shoulder', elbow_R: 'Right elbow', wrist_R: 'Right wrist',
  hip_L: 'Left hip', knee_L: 'Left knee', ankle_L: 'Left ankle',
  hip_R: 'Right hip', knee_R: 'Right knee', ankle_R: 'Right ankle',
};

// Segment mass model (de Leva 1996 adjustments of Zatsiorsky's data, simplified).
// mass: fraction of total body mass; com: fraction of segment length measured
// from the proximal (first) joint.
export const MASS_SEGMENTS = [
  { name: 'trunk', from: 'pelvis', to: 'neck', mass: 0.4346, com: 0.55 },
  { name: 'head+neck', from: 'neck', to: 'headTop', mass: 0.0694, com: 0.50 },
  { name: 'upper arm L', from: 'shoulder_L', to: 'elbow_L', mass: 0.0271, com: 0.577 },
  { name: 'upper arm R', from: 'shoulder_R', to: 'elbow_R', mass: 0.0271, com: 0.577 },
  { name: 'forearm L', from: 'elbow_L', to: 'wrist_L', mass: 0.0162, com: 0.457 },
  { name: 'forearm R', from: 'elbow_R', to: 'wrist_R', mass: 0.0162, com: 0.457 },
  { name: 'hand L', from: 'wrist_L', to: 'hand_L', mass: 0.0061, com: 0.79 },
  { name: 'hand R', from: 'wrist_R', to: 'hand_R', mass: 0.0061, com: 0.79 },
  { name: 'thigh L', from: 'hip_L', to: 'knee_L', mass: 0.1416, com: 0.41 },
  { name: 'thigh R', from: 'hip_R', to: 'knee_R', mass: 0.1416, com: 0.41 },
  { name: 'shank L', from: 'knee_L', to: 'ankle_L', mass: 0.0433, com: 0.44 },
  { name: 'shank R', from: 'knee_R', to: 'ankle_R', mass: 0.0433, com: 0.44 },
  { name: 'foot L', from: 'ankle_L', to: 'toe_L', mass: 0.0137, com: 0.50 },
  { name: 'foot R', from: 'ankle_R', to: 'toe_R', mass: 0.0137, com: 0.50 },
];

// Foot sole corner points in the ankle's local frame (fractions of height),
// used to build the base of support. Order: heel-in, heel-out, toe-out, toe-in.
export const FOOT_CORNERS_L = [
  [-0.030, -0.039, -0.055],
  [0.030, -0.039, -0.055],
  [0.038, -0.039, 0.135],
  [-0.038, -0.039, 0.135],
];
export const FOOT_CORNERS_R = FOOT_CORNERS_L.map(([x, y, z]) => [-x, y, z]);

// IK chains: dragging the effector solves root + mid rotations.
// hingeSign: direction the mid joint is allowed to bend around its X axis.
export const IK_CHAINS = {
  hand_L: { root: 'shoulder_L', mid: 'elbow_L', effector: 'wrist_L', hingeSign: -1 },
  hand_R: { root: 'shoulder_R', mid: 'elbow_R', effector: 'wrist_R', hingeSign: -1 },
  wrist_L: { root: 'shoulder_L', mid: 'elbow_L', effector: 'wrist_L', hingeSign: -1 },
  wrist_R: { root: 'shoulder_R', mid: 'elbow_R', effector: 'wrist_R', hingeSign: -1 },
  foot_L: { root: 'hip_L', mid: 'knee_L', effector: 'ankle_L', hingeSign: 1 },
  foot_R: { root: 'hip_R', mid: 'knee_R', effector: 'ankle_R', hingeSign: 1 },
  ankle_L: { root: 'hip_L', mid: 'knee_L', effector: 'ankle_L', hingeSign: 1 },
  ankle_R: { root: 'hip_R', mid: 'knee_R', effector: 'ankle_R', hingeSign: 1 },
  toe_L: { root: 'hip_L', mid: 'knee_L', effector: 'ankle_L', hingeSign: 1 },
  toe_R: { root: 'hip_R', mid: 'knee_R', effector: 'ankle_R', hingeSign: 1 },
};

// Highlightable body parts: every mesh attached under one of `nodes` belongs
// to the part. Bones/muscles that span a joint live on the proximal node, so
// e.g. the thigh (attached to hip_L) highlights with the left leg.
export const BODY_PARTS = [
  { id: 'head', title: 'Head & neck', nodes: ['neck', 'head', 'headTop'] },
  { id: 'torso', title: 'Torso', nodes: ['spine', 'chest'] },
  { id: 'pelvis', title: 'Pelvis', nodes: ['pelvis'] },
  { id: 'arm_L', title: 'Left arm', nodes: ['shoulder_L', 'elbow_L', 'wrist_L', 'hand_L'] },
  { id: 'arm_R', title: 'Right arm', nodes: ['shoulder_R', 'elbow_R', 'wrist_R', 'hand_R'] },
  { id: 'leg_L', title: 'Left leg', nodes: ['hip_L', 'knee_L'] },
  { id: 'leg_R', title: 'Right leg', nodes: ['hip_R', 'knee_R'] },
  { id: 'foot_L', title: 'Left foot', nodes: ['ankle_L', 'toe_L'] },
  { id: 'foot_R', title: 'Right foot', nodes: ['ankle_R', 'toe_R'] },
];

export const PART_OF_NODE = {};
for (const part of BODY_PARTS) {
  for (const node of part.nodes) PART_OF_NODE[node] = part.id;
}

export function clampAngle(value, [min, max]) {
  return Math.min(max * DEG, Math.max(min * DEG, value));
}

// For closed-chain editing: which distal endpoint stays planted when this joint
// is rotated. Leg joints anchor their own foot; arm joints their own hand;
// pelvis anchors a foot chosen at runtime (its descendants include both legs).
// Axial joints (spine/neck/head) have no grounded descendant, so they fall back
// to open-chain behaviour (value null).
export const ANCHOR_FOR = {
  hip_L: 'ankle_L', knee_L: 'ankle_L', ankle_L: 'ankle_L',
  hip_R: 'ankle_R', knee_R: 'ankle_R', ankle_R: 'ankle_R',
  shoulder_L: 'wrist_L', elbow_L: 'wrist_L', wrist_L: 'wrist_L',
  shoulder_R: 'wrist_R', elbow_R: 'wrist_R', wrist_R: 'wrist_R',
  pelvis: 'support-foot', // resolved to the lower ankle at runtime
  spine: null, chest: null, neck: null, head: null,
};
