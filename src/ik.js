import * as THREE from 'three';

const _R = new THREE.Vector3();
const _M = new THREE.Vector3();
const _E = new THREE.Vector3();
// Reused quaternion scratch. solveTwoBone and swivelLimb never nest, so they
// can share these without aliasing.
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

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
  const from = eff.getWorldPosition(_E).sub(_R).normalize(); // _E free after `b`
  const to = _M.copy(targetWorld).sub(_R).normalize();       // _M free after `b`
  if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
  const qDelta = _q1.setFromUnitVectors(from, to);

  const parentQ = root.parent.getWorldQuaternion(_q2);
  const parentQInv = _q3.copy(parentQ).invert();
  // local' = P⁻¹ · Δ · P · local
  root.quaternion.copy(parentQInv.multiply(qDelta).multiply(parentQ).multiply(root.quaternion));
  figure.clampJoint(chain.root);
  figure.group.updateMatrixWorld(true);
}

// Swivel a two-bone limb about the line through its root and effector: with
// the shoulder (root) and wrist (effector) both pinned in world space, the
// elbow (mid) can only travel on a circle around that axis. This rolls the
// whole limb about the axis so the elbow swings toward `targetWorld` (a
// pole-vector handle). The roll is applied at the root joint, and because a
// rotation about an axis that passes through the root's origin AND the
// effector (which sits on it) leaves both of those points fixed exactly, the
// endpoints never move. The one thing that would move them is a joint-limit
// clamp turning the roll into some other rotation, so instead we clamp the
// roll *angle*: the largest roll toward the target that still keeps the root
// within its limits. The mid joint's own flexion is untouched, so the root's
// rotation range is what bounds the elbow's travel.
export function swivelLimb(figure, chain, targetWorld) {
  const root = figure.nodes[chain.root];
  const mid = figure.nodes[chain.mid];
  const eff = figure.nodes[chain.effector];

  figure.group.updateMatrixWorld(true);
  root.getWorldPosition(_R);
  mid.getWorldPosition(_M);
  eff.getWorldPosition(_E);

  const axis = _E.clone().sub(_R);
  if (axis.lengthSq() < 1e-10) return; // limb folded flat: no swivel axis
  axis.normalize();

  // Elbow's current radial direction from the axis, and the desired one from
  // the pole handle (both projected into the plane perpendicular to the axis).
  const center = _R.clone().addScaledVector(axis, _M.clone().sub(_R).dot(axis));
  const cur = _M.clone().sub(center);
  if (cur.lengthSq() < 1e-10) return; // elbow on the axis (limb straight)
  cur.normalize();
  const rel = targetWorld.clone().sub(center);
  const des = rel.addScaledVector(axis, -rel.dot(axis));
  if (des.lengthSq() < 1e-10) return; // handle on the axis: no direction
  des.normalize();
  const desired = Math.atan2(axis.dot(new THREE.Vector3().crossVectors(cur, des)), cur.dot(des));

  const parentQ = root.parent.getWorldQuaternion(new THREE.Quaternion());
  const parentQInv = parentQ.clone().invert();
  const q0 = root.quaternion.clone(); // the root's local rotation before the roll
  // The root's local rotation after rolling the whole limb by `theta` about the
  // world axis: local' = P⁻¹ · Rot(axis, θ) · P · local. Returns shared scratch
  // (_q1); every caller copies it into root.quaternion before the next roll.
  const rolled = (theta) => _q1.copy(parentQInv)
    .multiply(_q2.setFromAxisAngle(axis, theta))
    .multiply(parentQ).multiply(q0);
  // A roll is feasible if it lands the root within its joint limits — i.e. the
  // clamp leaves it unchanged (so the applied rotation stays a pure axis roll
  // and the endpoints stay pinned).
  const feasible = (theta) => {
    root.quaternion.copy(rolled(theta));
    const before = root.quaternion.clone();
    figure.clampJoint(chain.root);
    return root.quaternion.angleTo(before) < 1e-3;
  };
  // Largest fraction of the desired roll that stays in range (θ = 0 always is).
  let frac = 1;
  if (!feasible(desired)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const midF = (lo + hi) / 2;
      if (feasible(desired * midF)) lo = midF; else hi = midF;
    }
    frac = lo;
  }
  root.quaternion.copy(rolled(desired * frac));
  figure.clampJoint(chain.root); // a no-op at a feasible angle; keeps endpoints pinned
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

// One-step correction that pitches the ankle so the sole sits level — or, with
// `pitchRad`, rolled that far off level (plantarflex > 0 onto the ball, dorsi-
// flex < 0 onto the heel). The flatten error and the roll are composed BEFORE
// the joint clamp: clamping the flatten alone first would eat range the roll
// still had (a shank tipped back 30° plus a 28° roll is a legal -2°, but
// flatten-then-roll clamps at -25° and lands at +3°).
export function flattenFoot(figure, side, pitchRad = 0) {
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
  ankleNode.rotation.x += err + pitchRad; // pitch toe down by the error, then roll
  figure.clampJoint(`ankle_${side}`);
  figure.group.updateMatrixWorld(true);
}
