import * as THREE from 'three';

const _R = new THREE.Vector3();
const _M = new THREE.Vector3();
const _E = new THREE.Vector3();

// Analytic two-bone IK (shoulder→elbow→wrist, hip→knee→ankle).
//  1. Set the hinge (mid) angle from the law of cosines.
//  2. Apply a world-space delta rotation to the root joint so the effector
//     lands on the target direction. This preserves the current swivel of the
//     limb, so dragging feels continuous.
//  3. Clamp both joints to their anatomical limits (the limb then reaches as
//     close to the target as anatomy allows).
export function solveTwoBone(figure, chain, targetWorld) {
  const root = figure.nodes[chain.root];
  const mid = figure.nodes[chain.mid];
  const eff = figure.nodes[chain.effector];

  figure.group.updateMatrixWorld(true);
  root.getWorldPosition(_R);
  mid.getWorldPosition(_M);
  eff.getWorldPosition(_E);

  const a = _R.distanceTo(_M);
  const b = _M.distanceTo(_E);
  const d = THREE.MathUtils.clamp(
    _R.distanceTo(targetWorld), Math.abs(a - b) + 1e-4, a + b - 1e-4,
  );

  // Hinge angle at the mid joint (local X).
  const cosMid = THREE.MathUtils.clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1);
  mid.rotation.x = chain.hingeSign * (Math.PI - Math.acos(cosMid));
  figure.clampJoint(chain.mid);

  // Swing the root so the effector points at the target.
  figure.group.updateMatrixWorld(true);
  const effNow = eff.getWorldPosition(new THREE.Vector3());
  const from = effNow.sub(_R).normalize();
  const to = targetWorld.clone().sub(_R).normalize();
  if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
  const qDelta = new THREE.Quaternion().setFromUnitVectors(from, to);

  const parentQ = root.parent.getWorldQuaternion(new THREE.Quaternion());
  const parentQInv = parentQ.clone().invert();
  // local' = P⁻¹ · Δ · P · local
  const newLocal = new THREE.Quaternion()
    .copy(parentQInv).multiply(qDelta).multiply(parentQ).multiply(root.quaternion);
  root.quaternion.copy(newLocal);
  figure.clampJoint(chain.root);
  figure.group.updateMatrixWorld(true);
}

// Drop each foot back to standing ankle height directly below its current
// position — handy after lowering the pelvis or leaning a figure.
export function feetToFloor(figure) {
  const ankleRestY = 0.039 * figure.height;
  for (const side of ['L', 'R']) {
    const chain = { root: `hip_${side}`, mid: `knee_${side}`, effector: `ankle_${side}`, hingeSign: 1 };
    const ankle = figure.nodes[chain.effector].getWorldPosition(new THREE.Vector3());
    solveTwoBone(figure, chain, new THREE.Vector3(ankle.x, ankleRestY, ankle.z));
    flattenFoot(figure, side);
  }
}

// ---------------------------------------------------------------- closed chain
//
// In a *closed kinetic chain* the distal end (a planted foot, a joined hand) is
// fixed in space, so rotating a joint moves everything *proximal* — bend the
// knee and the pelvis/torso lower over a stationary foot. We model this by
// letting the joint rotate normally (which moves its distal subtree, including
// the anchor) and then applying a single rigid transform to the whole figure so
// the anchor snaps back to where it was. Everything except the anchor and its
// distal subtree ends up moved; the anchor stays put in both position and
// orientation (so a planted foot also stays flat).

// Move the figure so `anchorNode` sits at `targetMatrix` (a world matrix).
export function pinAnchor(figure, anchorNode, targetMatrix) {
  figure.group.updateMatrixWorld(true);
  // delta · anchorWorld = target  ⇒  delta = target · anchorWorld⁻¹
  const delta = targetMatrix.clone().multiply(anchorNode.matrixWorld.clone().invert());
  figure.group.matrix.premultiply(delta);
  figure.group.matrix.decompose(figure.group.position, figure.group.quaternion, figure.group.scale);
  figure.group.updateMatrixWorld(true);
}

// Run `mutate` (a joint edit) while keeping `anchorNode` fixed in world space.
export function editWithAnchor(figure, anchorNode, mutate) {
  figure.group.updateMatrixWorld(true);
  const before = anchorNode.matrixWorld.clone();
  mutate();
  pinAnchor(figure, anchorNode, before);
}

// One-step correction that pitches the ankle so the sole sits level.
export function flattenFoot(figure, side) {
  const ankleNode = figure.nodes[`ankle_${side}`];
  const toeNode = figure.nodes[`toe_${side}`];
  // A flat sole includes flat toes; the toe-tip height math below assumes it.
  figure.nodes[`toes_${side}`].rotation.set(0, 0, 0);
  figure.group.updateMatrixWorld(true);
  const A = ankleNode.getWorldPosition(new THREE.Vector3());
  const T = toeNode.getWorldPosition(new THREE.Vector3());
  const horiz = Math.hypot(T.x - A.x, T.z - A.z);
  if (horiz < 1e-5) return;
  // Desired toe height: sole depth below the ankle.
  const desiredY = A.y - 0.035 * figure.height;
  const err = Math.atan2(T.y - desiredY, horiz);
  ankleNode.rotation.x += err; // pitch toe down by the error
  figure.clampJoint(`ankle_${side}`);
  figure.group.updateMatrixWorld(true);
}
