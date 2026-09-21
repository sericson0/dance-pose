// The arm FRAME: a dancer's two elbows treated as a rigid pair that the body
// can turn underneath — the part of a tango pivot that lives in the shoulders.
//
// In an embrace the arms belong to the COUPLE: the elbows (and everything from
// them down — forearms, hands, the partner they hold) stay where the embrace
// put them while the dancer's own trunk turns. What pays for that is the
// shoulder girdle: the blade on the side whose elbow ends up further FORWARD of
// the chest protracts, the other retracts, and the glenohumeral joints re-aim
// the upper arms at elbows that have not moved. Two tools are built on the one
// solve here:
//
//   • the frame TURN (main.js `app.turnFrame`, Move hips → Frame): the elbows
//     orbit the chest's vertical axis as one rigid pair — same height, same
//     distance apart — while the trunk stays put;
//   • the elbow HOLD (`ElbowHold`, the Embrace panel's "Fix elbows"): the
//     elbows stay where they are IN THE ROOM while anything else moves the
//     body — a chest rotation, a hips twist, a whole-figure pivot on the
//     support foot.
//
// They are the same motion seen from two frames, which is why they share
// `solveElbow` and cannot disagree about what the shoulders do.
//
// The arm chain has ONE frame (the rig arm nodes sit on the anatomical joint
// centres — see skeletonDef.js), so an elbow solved on `elbow_*` is the elbow
// the viewer sees; none of the rig-vs-mesh care the hands need applies here.
import * as THREE from 'three';
import { JOINT_BY_NAME } from './skeletonDef.js';
import { STRAIN_COLOR, makeStrainLine, setStrainLine } from './pins.js';

const DEG = Math.PI / 180;

// How much of the frame's turn about the chest the BLADE takes before the
// glenohumeral joint is asked for the rest. Protraction/retraction is where
// this movement anatomically lives — a frame turned by the shoulder joints
// alone leaves the girdle square to the chest, which is exactly the stiff
// "arms move, shoulders don't" look the tool exists to avoid. At 0.5 the
// blade's ±25° is spent at ~50° of frame turn, about where the shoulder's own
// range starts to run out too, so the two saturate together.
//
// It is a PREFERENCE, not a rule: an embrace arm often rests a few degrees from
// one of the shoulder's limits (the leader's right, round her back, sits 6°
// from its forward limit in the Close-embrace preset), and at the preferred
// share the glenohumeral joint then runs out long before the girdle has given
// what it could. So when the preferred share leaves the elbow short, the blade
// is asked for more — the later entries — and the first share that reaches
// wins, which keeps the answer a function of the target alone (no ratchet).
const SCAPULA_SHARES = [0.5, 0.8, 1.1];

// An elbow this far from where it was asked to be counts as "could not get
// there" (metres): the strain marker lights, and a frame turn backs off.
export const ELBOW_TOL = 0.008;

const _S = new THREE.Vector3();
const _M = new THREE.Vector3();
const _u = new THREE.Vector3();
const _h = new THREE.Vector3();
const _k = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _hx = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);

const clampDeg = (rad, [lo, hi]) => Math.min(hi * DEG, Math.max(lo * DEG, rad));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// The mirrored right side carries its limits mirrored too; Figure.clampJoint is
// the authority, so limits are only READ here to keep the blade's own solve
// inside them (the final clamp still runs through the figure).
function scapLimits(figure, side) {
  const def = JOINT_BY_NAME[`scapula_${side}`];
  return def?.limits ?? { x: [0, 0], y: [-25, 25], z: [-12, 25] };
}

// Where the shoulder joint would sit (world) with the blade at (ry, rz) —
// computed from the parent's matrix, so probing a candidate costs no scene
// graph update.
function shoulderAt(scap, shoulder, ry, rz, out) {
  _e.set(scap.rotation.x, ry, rz, 'XYZ');
  _q1.setFromEuler(_e);
  return out.copy(shoulder.position).applyQuaternion(_q1).add(scap.position)
    .applyMatrix4(scap.parent.matrixWorld);
}

// The azimuth of a world point about the chest's own vertical axis, in the
// chest's frame — the angle a frame turn changes and a lean does not.
function chestAzimuth(figure, world) {
  const chest = figure.nodes.chest;
  _v.copy(world).applyMatrix4(_m.copy(chest.matrixWorld).invert());
  return Math.atan2(_v.x, _v.z);
}

// What one arm looked like when it was captured: where the elbow was and how
// the forearm was turned (both WORLD), plus the reference the blade's share is
// measured from — its own angles, and the elbow's azimuth about the chest.
export function captureArm(figure, side) {
  figure.group.updateMatrixWorld(true);
  const el = figure.nodes[`elbow_${side}`];
  const scap = figure.nodes[`scapula_${side}`];
  const pos = el.getWorldPosition(new THREE.Vector3());
  return {
    pos,
    quat: el.getWorldQuaternion(new THREE.Quaternion()),
    ref: { y: scap.rotation.y, z: scap.rotation.z, az: chestAzimuth(figure, pos) },
  };
}

// Put `side`'s elbow at `target` (world) with the forearm turned to `quat`
// (world), moving ONLY that arm's scapula, shoulder and elbow. Returns how far
// the elbow ended up from the target, in metres (0 = exact).
//
//  1. The BLADE takes its share of the turn: the elbow's azimuth about the
//     chest, relative to the reference it was captured at, times its share
//     (SCAPULA_SHARES). A rotation of the elbow about the chest's vertical and a
//     rotation of the blade about its own y are the same sense on both sides,
//     so there is no per-side sign here.
//  2. The blade then closes the DISTANCE: the upper arm is one bone, so the
//     elbow can only land on the target if the shoulder joint sits exactly one
//     humerus away from it. A damped Gauss–Newton step on (protraction,
//     elevation), taken from step 1's pose so the answer stays the nearest one
//     to it — which is what makes a turn and its reverse retrace each other
//     instead of ratcheting.
//  3. The SHOULDER aims the humerus at the target (the minimal world rotation,
//     as solveTwoBone's root does), then rolls about it so the elbow's hinge
//     axis lies square to the forearm's own long axis — the closed-form
//     condition for the forearm's captured orientation to be reachable by
//     flexion + pronation alone (see the algebra at `twist`).
//  4. The ELBOW takes whatever orientation is left.
// Every joint is clamped through Figure.clampJoint, so an unreachable target
// degrades into a residual rather than into an impossible arm.
export function solveElbow(figure, side, target, quat, ref) {
  const nodes = ['scapula', 'shoulder', 'elbow'].map((n) => figure.nodes[`${n}_${side}`]);
  const start = nodes.map((n) => n.rotation.clone());
  let best = null;
  for (const share of (ref ? SCAPULA_SHARES : [0])) {
    // Every try starts from the SAME pose, so which share wins depends on the
    // target and not on what the previous try left behind.
    nodes.forEach((n, i) => n.rotation.copy(start[i]));
    const miss = solveWithShare(figure, side, target, quat, ref, share);
    if (!best || miss < best.miss - 1e-5) best = { miss, rot: nodes.map((n) => n.rotation.clone()) };
    if (miss <= ELBOW_TOL / 4) break;
  }
  // Still short: the closed-form blade placement only knows about DISTANCE, and
  // what is stopping the elbow now is a shoulder LIMIT it cannot see. So search
  // the blade directly against the thing that matters — where the elbow really
  // ends up after the clamps — by pattern search on (protraction, elevation).
  // Only a strained arm ever gets here, so the ~dozen extra arm solves cost
  // nothing on the ordinary frame.
  if (ref && best.miss > ELBOW_TOL / 4) {
    const lim = scapLimits(figure, side);
    let step = 5 * DEG;
    for (let iter = 0; iter < 16 && step > 0.2 * DEG && best.miss > ELBOW_TOL / 4; iter++) {
      let improved = false;
      for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const blade = {
          y: clampDeg(best.rot[0].y + dy * step, lim.y),
          z: clampDeg(best.rot[0].z + dz * step, lim.z),
        };
        if (blade.y === best.rot[0].y && blade.z === best.rot[0].z) continue;
        nodes.forEach((n, i) => n.rotation.copy(start[i]));
        const miss = solveWithShare(figure, side, target, quat, ref, 0, blade);
        if (miss < best.miss - 1e-5) {
          best = { miss, rot: nodes.map((n) => n.rotation.clone()) };
          improved = true;
        }
      }
      if (!improved) step /= 2;
    }
  }
  nodes.forEach((n, i) => n.rotation.copy(best.rot[i]));
  figure.group.updateMatrixWorld(true);
  return best.miss;
}

// An elbow's local rotation is Rx(flex)·Ry(pron) with z locked, and its
// pronation runs to ±120° — past the ±90° a canonical XYZ Euler extraction can
// return for y (three folds the rest into x and z = ±180°, which the z lock
// then clamps into a broken arm; the follower's embrace elbows sit at 88°, so
// this is the ordinary case, not a corner). Read the two angles straight off
// the matrix instead:  Rx(a)·Ry(b) = [[cb, 0, sb], [sa·sb, ca, −sa·cb], …],
// so b = atan2(m02, m00) and a = atan2(m21, m11), each over the full circle.
// `zErr` is how far the rotation is from having z = 0 at all.
function flexPron(q, out) {
  _m.makeRotationFromQuaternion(q);
  const e = _m.elements; // column-major: m(r,c) = e[c * 4 + r]
  out.pron = Math.atan2(e[8], e[0]);
  out.flex = Math.atan2(e[6], e[5]);
  out.zErr = Math.abs(e[4]); // m01 = −cos(pron)·sin(z)
  return out;
}
const _fp = { flex: 0, pron: 0, zErr: 0 };

// `blade` ({ y, z }) places the scapula outright and skips steps 1–2.
function solveWithShare(figure, side, target, quat, ref, share, blade = null) {
  const scap = figure.nodes[`scapula_${side}`];
  const sh = figure.nodes[`shoulder_${side}`];
  const el = figure.nodes[`elbow_${side}`];
  figure.group.updateMatrixWorld(true);
  const lim = scapLimits(figure, side);
  const L = el.position.length() * sh.getWorldScale(_v).x;

  // 1. the blade's share of the turn
  let ry = scap.rotation.y;
  let rz = scap.rotation.z;
  if (ref) {
    const dAz = wrapPi(chestAzimuth(figure, target) - ref.az);
    ry = clampDeg(ref.y + share * dAz, lim.y);
    rz = clampDeg(ref.z, lim.z);
  }

  // 2. close the distance |target − shoulder| = L
  const EPS = 1e-3;
  if (blade) { ry = blade.y; rz = blade.z; }
  for (let i = 0; i < 8 && !blade; i++) {
    const e0 = shoulderAt(scap, sh, ry, rz, _S).distanceTo(target) - L;
    if (Math.abs(e0) < 1e-4) break;
    const gy = (shoulderAt(scap, sh, ry + EPS, rz, _S).distanceTo(target) - L - e0) / EPS;
    const gz = (shoulderAt(scap, sh, ry, rz + EPS, _S).distanceTo(target) - L - e0) / EPS;
    const gg = gy * gy + gz * gz;
    if (gg < 1e-10) break;
    // Damped: near a fully-stretched configuration the gradient collapses and
    // an undamped step would fling the blade to its limit for a millimetre.
    const k = e0 / (gg + 1e-4);
    ry = clampDeg(ry - k * gy, lim.y);
    rz = clampDeg(rz - k * gz, lim.z);
  }
  scap.rotation.y = ry;
  scap.rotation.z = rz;
  figure.clampJoint(`scapula_${side}`);
  figure.group.updateMatrixWorld(true);

  // 3a. aim the humerus
  sh.getWorldPosition(_S);
  el.getWorldPosition(_M);
  const from = _M.sub(_S).normalize();
  _u.copy(target).sub(_S);
  if (_u.lengthSq() < 1e-10 || from.lengthSq() < 1e-10) return el.getWorldPosition(_v).distanceTo(target);
  _u.normalize();
  const parentQ = sh.parent.getWorldQuaternion(_q2);
  const parentInv = _q3.copy(parentQ).invert();
  // world shoulder orientation after the aim: Δ · P · local
  _qs.setFromUnitVectors(from, _u).multiply(parentQ).multiply(sh.quaternion);

  // 3b. twist about the humerus. The elbow's local rotation is Rx(flex)·Ry(pron)
  // — its z is locked — and for such a rotation the matrix element (0,1) is
  // zero: the parent's x axis (the hinge, h) is perpendicular to the child's y
  // axis (the forearm's long axis, k). With the humerus rolled by φ about u,
  //   h(φ) = h∥ + cos φ · h⊥ + sin φ · (u × h⊥),
  // so h(φ)·k = A + B cos φ + C sin φ, which has the closed-form roots below.
  // Of the two, the one the elbow can actually adopt (flexion inside its
  // limits) wins, then the smaller roll — the continuous choice frame to frame.
  if (quat) {
    _h.copy(_X).applyQuaternion(_qs);
    _k.copy(_Y).applyQuaternion(quat);
    const hPar = _h.dot(_u);
    _hp.copy(_h).addScaledVector(_u, -hPar);
    _hx.crossVectors(_u, _hp);
    const A = hPar * _u.dot(_k);
    const B = _hp.dot(_k);
    const C = _hx.dot(_k);
    const R = Math.hypot(B, C);
    if (R > 1e-8) {
      const delta = Math.atan2(C, B);
      const roots = Math.abs(A) <= R
        ? [delta + Math.acos(-A / R), delta - Math.acos(-A / R)]
        : [delta + (A > 0 ? Math.PI : 0)]; // no exact root: the nearest miss
      const elLim = JOINT_BY_NAME[`elbow_${side}`]?.limits;
      let best = null;
      for (const raw of roots) {
        const phi = wrapPi(raw);
        _q1.setFromAxisAngle(_u, phi).multiply(_qs);      // candidate shoulder (world)
        flexPron(_q1.invert().multiply(quat), _fp); // elbow local
        let bad = 0;
        if (elLim) {
          // The second root usually bends the elbow the WRONG WAY (flexion
          // outside its range) — the mirror-image arm, which the joint cannot
          // adopt.
          bad = Math.max(0, elLim.x[0] * DEG - _fp.flex, _fp.flex - elLim.x[1] * DEG)
            + Math.max(0, elLim.y[0] * DEG - _fp.pron, _fp.pron - elLim.y[1] * DEG);
        }
        const cost = bad * 10 + Math.abs(phi);
        if (!best || cost < best.cost) best = { phi, cost };
      }
      _qs.premultiply(_q1.setFromAxisAngle(_u, best.phi));
    }
  }
  sh.quaternion.copy(parentInv.multiply(_qs));
  figure.clampJoint(`shoulder_${side}`);
  figure.group.updateMatrixWorld(true);

  // 4. the elbow takes what is left of the forearm's orientation
  if (quat) {
    sh.getWorldQuaternion(_q1).invert();
    flexPron(_q1.multiply(quat), _fp);
    el.rotation.set(_fp.flex, _fp.pron, 0);
    figure.clampJoint(`elbow_${side}`);
    figure.group.updateMatrixWorld(true);
  }
  return el.getWorldPosition(_v).distanceTo(target);
}

// ------------------------------------------------------------------ the hold
// "Fix elbows": a per-frame constraint holding a dancer's two elbows where they
// are in the room. Run LAST in main.js's constraint pass — after the embrace
// hands and the contact pins — because it is the most specific intent on those
// arms; the embrace is told which arms it owns (`owns`) and treats them as it
// treats an arm the user is posing: it leaves them alone, and on the open side
// re-captures the clasp from that hand so the PARTNER's arm follows instead.
const MARK_R = 0.022;
const MARK_COLOR = 0xffffff;

export class ElbowHold {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'elbow-hold';
    this.held = new Map(); // figure → { L: arm, R: arm, marks: {L, R}, lines: {L, R}, strained }
  }

  has(figure) { return this.held.has(figure); }

  owns(figure /* , side */) { return this.held.has(figure); }

  get count() { return this.held.size; }

  set(figure, on) {
    if (!on) {
      const h = this.held.get(figure);
      if (h) {
        for (const side of ['L', 'R']) {
          for (const o of [h.marks[side], h.lines[side]]) {
            this.group.remove(o);
            o.geometry.dispose();
            o.material.dispose();
          }
        }
        this.held.delete(figure);
      }
      return false;
    }
    if (this.held.has(figure)) { this.recapture(figure); return true; }
    const h = { marks: {}, lines: {}, strained: { L: false, R: false } };
    for (const side of ['L', 'R']) {
      // Drawn THROUGH the dancer: the elbow of an embrace arm is usually behind
      // a torso from wherever the camera is, and a pin you cannot see is a pin
      // you forget is on.
      const mark = new THREE.Mesh(
        new THREE.SphereGeometry(MARK_R, 16, 12),
        new THREE.MeshBasicMaterial({ color: MARK_COLOR, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
      );
      mark.renderOrder = 7;
      const line = makeStrainLine();
      line.visible = false;
      line.material.depthTest = false;
      line.renderOrder = 7;
      h.marks[side] = mark;
      h.lines[side] = line;
      this.group.add(mark, line);
    }
    this.held.set(figure, h);
    this.recapture(figure);
    return true;
  }

  // Take the elbows' targets from the pose as it stands. Called when the hold
  // is switched on, and whenever a pose is applied OUTRIGHT (a preset, an undo,
  // a slide, a scrub, a playing sequence): the hold is about keeping the elbows
  // still while the user moves the body, and a pose that arrives whole is not
  // the user moving the body — holding the old spot through it would wrench
  // the new pose's arms back to the old one's elbows.
  recapture(figure = null) {
    for (const [fig, h] of this.held) {
      if (figure && fig !== figure) continue;
      for (const side of ['L', 'R']) {
        h[side] = captureArm(fig, side);
        h.marks[side].position.copy(h[side].pos);
        h.lines[side].visible = false;
        h.marks[side].material.color.set(MARK_COLOR);
        h.strained[side] = false;
      }
    }
  }

  // Re-solve every held arm. `editing` is main.js's { figure, jointName }: a
  // FOREARM the user is posing (elbow / wrist / hand) keeps the orientation
  // they are giving it — the elbow's POSITION is what is fixed, and a hold that
  // also froze the forearm would make the elbow joint itself un-editable for
  // as long as the box stayed ticked. Returns the worst residual (metres).
  maintain(editing = null) {
    let worst = 0;
    for (const [fig, h] of this.held) {
      for (const side of ['L', 'R']) {
        const arm = h[side];
        if (!arm) continue;
        const m = editing?.figure === fig
          && editing.jointName?.match(/^(elbow|wrist|hand)_([LR])$/);
        if (m && m[2] === side) {
          fig.group.updateMatrixWorld(true);
          fig.nodes[`elbow_${side}`].getWorldQuaternion(arm.quat);
        }
        const miss = solveElbow(fig, side, arm.pos, arm.quat, arm.ref);
        worst = Math.max(worst, miss);
        const strained = miss > ELBOW_TOL;
        h.strained[side] = strained;
        h.marks[side].material.color.set(strained ? STRAIN_COLOR : MARK_COLOR);
        h.lines[side].visible = strained;
        if (strained) {
          setStrainLine(h.lines[side], arm.pos, fig.nodes[`elbow_${side}`].getWorldPosition(_v));
        }
      }
      fig.syncAtlasNodes();
    }
    return worst;
  }

  // The first strained elbow, as { figure, side }, or null — for the status line.
  strained() {
    for (const [figure, h] of this.held) {
      for (const side of ['L', 'R']) if (h.strained[side]) return { figure, side };
    }
    return null;
  }
}
