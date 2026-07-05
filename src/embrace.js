import * as THREE from 'three';
import { JOINT_BY_NAME, DEG, clampAngle } from './skeletonDef.js';
import { solveTwoBone } from './ik.js';

// The tango embrace as a set of per-frame constraints (see main.js's loop),
// modelled on the real embrace:
//
//  * Closed side — the leader's right arm passes UNDER the follower's left
//    arm and around her, palm resting flat on her back below her left
//    shoulder blade; the follower's left arm drapes OVER his right arm, palm
//    on the outside of his right deltoid. The over/under layering comes from
//    the authored embrace pose (presets.js) and survives because the
//    two-bone solve preserves each arm's swivel.
//  * Open side — the leader's LEFT hand holds the follower's RIGHT on the
//    outside of the embrace: his palm is on the outside facing in, hers
//    inside it facing out (her forearm rolls into external rotation to
//    present the palm), the two palm centers a hand's thickness apart.
//    Both clasped hands flex at the wrist so the fingers close around the
//    back of the partner's hand, and on the clothed avatars the finger bones
//    curl (Figure.setFingerCurl).
//  * Close embrace — the torsos stay in contact. Each torso is treated as a
//    vertical cylinder around its chest node; only the horizontal distance
//    between the two chests is constrained, so the point of contact is free
//    to rotate around either torso (giros, apilado shifts).
//
// All four arms re-solve every frame so the frame survives any movement,
// with the closed-side wrists neutral (flat palms) — shoulders and elbows do
// the reaching. The constraints never fight the user: whichever dancer (or
// arm joint) is being edited is left alone and the partner adapts.

const ARMS = {
  // Open side: the hand clasp.
  leaderOpen: { role: 'leader', shoulder: 'shoulder_L', elbow: 'elbow_L', wrist: 'wrist_L', hand: 'hand_L' },
  followerOpen: { role: 'follower', shoulder: 'shoulder_R', elbow: 'elbow_R', wrist: 'wrist_R', hand: 'hand_R' },
  // Closed side: the hand rests on the partner.
  leaderClosed: { role: 'leader', shoulder: 'shoulder_R', elbow: 'elbow_R', wrist: 'wrist_R', hand: 'hand_R' },
  followerClosed: { role: 'follower', shoulder: 'shoulder_L', elbow: 'elbow_L', wrist: 'wrist_L', hand: 'hand_L' },
};

// Closed-side palm rest points in the PARTNER's chest frame, as fractions of
// the partner's height: the leader's right palm on the follower's back below
// her left shoulder blade (low enough that his forearm passes under her
// armpit); the follower's left palm on the outside of the leader's right
// deltoid, so her arm lies over his.
const CLOSED_TARGETS = {
  leaderClosed: new THREE.Vector3(0.085, 0.025, -0.075),
  followerClosed: new THREE.Vector3(-0.135, 0.075, 0.035),
};

// Chest-to-chest distance when the torsos touch, as a fraction of the two
// heights combined (the chest node sits on the body axis, so this is the sum
// of the two half-depths of the ribcage plus a little soft tissue).
const CONTACT_FRACTION = 0.062;

// The palm center sits about half the hand length beyond the wrist.
const HAND_HALF = 0.050;

// Open-side clasp: distance between the two palm centers (fraction of mean
// height) — about two palm thicknesses, hands lightly interlaced. The leader's
// palm sits on the OUTSIDE of the embrace, the follower's inside it.
const PALM_GAP = 0.014;

// "Fingers closed around each other": both clasped hands flex at the wrist by
// this much, wrapping each hand around the back of the partner's. (Exported
// for the dev verification script.)
export const CLASP_WRAP_DEG = 18;

// The closed-side hands rest ON the partner (his right on her back, her left on
// his shoulder), so their fingers close softly onto the body instead of staying
// splayed like the avatar's rest hand — a gentle curl, not the full clasp grip.
const CLOSED_CURL = 0.45;

// A palm cannot fold in closer to its own shoulder than roughly this (fraction
// of height). Goals inside this radius are pushed out to it — without the
// clamp a too-near clasp point makes the per-frame solve ratchet the arm
// around its joint limits instead of settling.
const MIN_REACH = 0.12;

// If the hands are farther apart than this when the clasp engages, the pose is
// nowhere near an embrace — start from a sensible default point instead.
const ENGAGE_RADIUS = 0.5;

// Center of the palm: halfway from the wrist to the hand endpoint.
export function handCenter(figure, wristName, handName, target = new THREE.Vector3()) {
  figure.group.updateMatrixWorld(true);
  target.setFromMatrixPosition(figure.nodes[wristName].matrixWorld);
  const tip = new THREE.Vector3().setFromMatrixPosition(figure.nodes[handName].matrixWorld);
  return target.add(tip).multiplyScalar(0.5);
}

export function openSideHandGap(leader, follower) {
  const a = handCenter(leader, 'wrist_L', 'hand_L');
  const b = handCenter(follower, 'wrist_R', 'hand_R');
  return a.distanceTo(b);
}

export class Embrace {
  constructor(leader, follower) {
    this.leader = leader;
    this.follower = follower;
    this.hands = false; // keep the arm frame (clasp + closed-side palms)
    this.close = false; // keep chest-to-chest torso contact
    // The clasp point stored in each dancer's chest frame; the live target is
    // the midpoint of the two, so it follows both torsos as they move.
    this.claspLocal = { leader: null, follower: null };
  }

  figure(role) {
    return role === 'leader' ? this.leader : this.follower;
  }

  partner(role) {
    return role === 'leader' ? this.follower : this.leader;
  }

  setHands(on) {
    this.hands = on;
    if (on) this.captureClasp(this.defaultClasp());
    // Close the clasped open-side hands' fingers around each other, and curl
    // the closed-side resting hands softly onto the partner (body avatars).
    this.leader.setFingerCurl('L', on ? 1 : 0);
    this.follower.setFingerCurl('R', on ? 1 : 0);
    this.leader.setFingerCurl('R', on ? CLOSED_CURL : 0);
    this.follower.setFingerCurl('L', on ? CLOSED_CURL : 0);
  }

  setClose(on) {
    this.close = on;
  }

  // Where the hands should join when the clasp engages: where they are now if
  // they are already near each other, otherwise a point out to the open side —
  // pushed laterally out of the mid-shoulder point and dropped a little, so
  // the joined hands sit beside the couple at about shoulder height with the
  // elbows hanging, not tucked between the two chests.
  defaultClasp() {
    const a = handCenter(this.leader, 'wrist_L', 'hand_L');
    const b = handCenter(this.follower, 'wrist_R', 'hand_R');
    if (a.distanceTo(b) <= ENGAGE_RADIUS) return a.add(b).multiplyScalar(0.5);
    const base = this.leader.worldPos('shoulder_L')
      .add(this.follower.worldPos('shoulder_R'))
      .multiplyScalar(0.5);
    const meanH = (this.leader.height + this.follower.height) / 2;
    const mid = this.leader.worldPos('chest')
      .add(this.follower.worldPos('chest')).multiplyScalar(0.5);
    const out = base.clone().sub(mid);
    out.y = 0;
    // Tango holds the joined open-side hands UP by the couple's heads and only
    // a little out past the open-side shoulders (not stretched horizontally),
    // elbows hanging — so nudge out a touch and lift toward head height.
    if (out.lengthSq() > 1e-6) base.addScaledVector(out.normalize(), 0.03 * meanH);
    base.y += 0.07 * meanH;
    return base;
  }

  captureClasp(world) {
    for (const role of ['leader', 'follower']) {
      const f = this.figure(role);
      f.group.updateMatrixWorld(true);
      this.claspLocal[role] = f.nodes.chest.worldToLocal(world.clone());
    }
  }

  claspWorld() {
    if (!this.claspLocal.leader || !this.claspLocal.follower) return null;
    const a = this.leader.nodes.chest.localToWorld(this.claspLocal.leader.clone());
    const b = this.follower.nodes.chest.localToWorld(this.claspLocal.follower.clone());
    return a.add(b).multiplyScalar(0.5);
  }

  contactDistance() {
    return CONTACT_FRACTION * (this.leader.height + this.follower.height);
  }

  // Horizontal chest-to-chest distance (the torso-contact measure).
  chestGap() {
    const a = this.leader.worldPos('chest');
    const b = this.follower.worldPos('chest');
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  handGap() {
    return openSideHandGap(this.leader, this.follower);
  }

  // Palm-center separation the clasp aims for (leader's hand on the outside,
  // follower's inside, palms in contact).
  palmGap() {
    return PALM_GAP * (this.leader.height + this.follower.height) / 2;
  }

  // World position a closed-side palm should rest at, on the partner's body.
  closedTargetWorld(armKey) {
    const p = this.partner(ARMS[armKey].role);
    p.group.updateMatrixWorld(true);
    return p.nodes.chest.localToWorld(CLOSED_TARGETS[armKey].clone().multiplyScalar(p.height));
  }

  // The rest point the arm actually solves to: the raw target pushed out to
  // the palm's minimum fold-in radius. In close embrace the follower's rest
  // point on the leader's deltoid sits nearer her own shoulder than a palm
  // can fold, so her hand comes to rest on this clamped point instead.
  closedGoalWorld(armKey) {
    const arm = ARMS[armKey];
    return this.#minReachClamp(this.figure(arm.role), arm, this.closedTargetWorld(armKey));
  }

  // Keep an arm goal outside the palm's minimum fold-in radius around its
  // own shoulder (see MIN_REACH).
  #minReachClamp(f, arm, goal) {
    const shoulder = f.nodes[arm.shoulder].getWorldPosition(new THREE.Vector3());
    const offset = goal.clone().sub(shoulder);
    const minR = MIN_REACH * f.height;
    if (offset.lengthSq() >= minR * minR) return goal;
    return offset.lengthSq() < 1e-8
      ? shoulder.addScaledVector(new THREE.Vector3(0, -1, 0), minR)
      : shoulder.addScaledVector(offset.normalize(), minR);
  }

  // Close embrace: restore the contact distance by sliding the partner of the
  // actively edited dancer (default: the follower keeps the embrace).
  maintainTorso(activeFigure) {
    if (!this.close) return;
    this.leader.group.updateMatrixWorld(true);
    this.follower.group.updateMatrixWorld(true);
    const cL = this.leader.worldPos('chest');
    const cF = this.follower.worldPos('chest');
    const dx = cL.x - cF.x;
    const dz = cL.z - cF.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return;
    const err = dist - this.contactDistance();
    if (Math.abs(err) < 1e-4) return;
    const mover = activeFigure === this.follower ? this.leader : this.follower;
    const sign = mover === this.follower ? 1 : -1; // move toward the other chest
    mover.group.position.x += sign * (dx / dist) * err;
    mover.group.position.z += sign * (dz / dist) * err;
    mover.group.updateMatrixWorld(true);
  }

  // The arm frame. `editing` is { figure, jointName } (or null): if the user
  // is posing one of the four embrace arms, that arm is left alone — on the
  // open side the clasp follows its hand and only the partner's arm re-solves.
  maintainHands(editing) {
    if (!this.hands) return;
    const edited = this.#editedArm(editing);
    const wrap = -CLASP_WRAP_DEG * DEG; // wrist flexion closing the fingers
    const t = this.palmGap() / 2;

    // Open side: palms joined around the shared clasp point — the leader's
    // half a gap outside it, the follower's half a gap inside.
    if (edited === 'leaderOpen' || edited === 'followerOpen') {
      const arm = ARMS[edited];
      const palm = handCenter(this.figure(arm.role), arm.wrist, arm.hand);
      const out = this.#claspOutward(palm);
      // Store the midpoint between the palms as the clasp.
      const clasp = palm.clone().addScaledVector(out, edited === 'leaderOpen' ? -t : t);
      this.captureClasp(clasp);
      const other = edited === 'leaderOpen' ? 'followerOpen' : 'leaderOpen';
      this.#solveArm(other, clasp.clone().addScaledVector(out, other === 'leaderOpen' ? t : -t), wrap);
      this.#facePalms(edited, out);
    } else {
      const clasp = this.claspWorld();
      if (!clasp) return;
      const out = this.#claspOutward(clasp);
      this.#solveArm('leaderOpen', clasp.clone().addScaledVector(out, t), wrap);
      this.#solveArm('followerOpen', clasp.clone().addScaledVector(out, -t), wrap);
      // If joint limits kept an arm short of the clasp point, meet halfway:
      // re-target both palms around the midpoint of where they landed.
      const a = handCenter(this.leader, 'wrist_L', 'hand_L');
      const b = handCenter(this.follower, 'wrist_R', 'hand_R');
      if (Math.abs(a.distanceTo(b) - 2 * t) > 0.004) {
        const mid = a.add(b).multiplyScalar(0.5);
        this.#solveArm('leaderOpen', mid.clone().addScaledVector(out, t), wrap);
        this.#solveArm('followerOpen', mid.clone().addScaledVector(out, -t), wrap);
      }
      this.#facePalms(null, out);
    }

    // Closed side: each palm to its rest point on the partner, turned to lie
    // against the surface it rests on. Only while the couple roughly face
    // each other — otherwise the rest points sit behind the shoulder's range
    // and the solve would strain the arms into overhead poses.
    if (!this.#facing()) return;
    if (edited !== 'leaderClosed') {
      this.#solveArm('leaderClosed', this.closedTargetWorld('leaderClosed'));
      const dir = this.follower.worldPos('chest')
        .sub(handCenter(this.leader, 'wrist_R', 'hand_R'));
      if (dir.lengthSq() > 1e-8) this.#pronate(this.leader, ARMS.leaderClosed, dir.normalize());
    }
    if (edited !== 'followerClosed') {
      this.#solveArm('followerClosed', this.closedTargetWorld('followerClosed'));
      const upperArm = this.leader.worldPos('shoulder_R')
        .add(this.leader.worldPos('elbow_R')).multiplyScalar(0.5);
      const dir = upperArm.sub(handCenter(this.follower, 'wrist_L', 'hand_L'));
      if (dir.lengthSq() > 1e-8) this.#pronate(this.follower, ARMS.followerClosed, dir.normalize());
    }
  }

  // Horizontal direction of the clasp's contact normal: from the follower's
  // chest out through the clasp point. The joined hands stack along it —
  // the leader's hand half a palm beyond the clasp (the OUTSIDE of the
  // embrace), the follower's half a palm inside — and the palms face along
  // it, his inward, hers outward.
  #claspOutward(clasp) {
    const out = clasp.clone().sub(this.follower.worldPos('chest'));
    out.y = 0;
    if (out.lengthSq() < 1e-6) {
      // Clasp on the follower's axis (degenerate): use the leader's left.
      out.set(1, 0, 0).applyQuaternion(this.leader.group.quaternion);
      out.y = 0;
    }
    return out.normalize();
  }

  // True while the dancers are in embrace-like geometry: each partner is in
  // front of the other and their facings are roughly opposed.
  #facing() {
    const fwdL = new THREE.Vector3(0, 0, 1).applyQuaternion(this.leader.group.quaternion);
    const fwdF = new THREE.Vector3(0, 0, 1).applyQuaternion(this.follower.group.quaternion);
    fwdL.y = 0; fwdF.y = 0;
    if (fwdL.lengthSq() < 1e-8 || fwdF.lengthSq() < 1e-8) return false;
    fwdL.normalize(); fwdF.normalize();
    if (fwdL.dot(fwdF) > -0.35) return false; // within ~70° of face-to-face
    const toF = this.follower.worldPos('chest').sub(this.leader.worldPos('chest'));
    toF.y = 0;
    if (toF.lengthSq() < 1e-8) return false;
    toF.normalize();
    return fwdL.dot(toF) > 0.2 && fwdF.dot(toF) < -0.2;
  }

  // Which embrace arm the user is currently editing, if any.
  #editedArm(editing) {
    if (!editing || !editing.jointName) return null;
    for (const [key, arm] of Object.entries(ARMS)) {
      if (editing.figure !== this.figure(arm.role)) continue;
      if ([arm.shoulder, arm.elbow, arm.wrist, arm.hand].includes(editing.jointName)) return key;
    }
    return null;
  }

  // Reach the palm center to `goal`: preset the wrist (neutral for the flat
  // closed-side palms, flexed by the finger wrap for the clasp), then iterate
  // the two-bone solve — each pass re-solves the chain, rolls the elbow to
  // its down-and-out hint, measures where the palm actually landed and moves
  // the wrist target by the remaining error.
  #solveArm(armKey, goal, wristX = 0) {
    const arm = ARMS[armKey];
    const f = this.figure(arm.role);
    const chain = { root: arm.shoulder, mid: arm.elbow, effector: arm.wrist, hingeSign: -1 };
    f.nodes[arm.wrist].rotation.set(wristX, 0, 0);
    // Keep the goal outside the palm's minimum fold-in radius — without the
    // clamp a too-near goal makes the per-frame solve ratchet the arm around
    // its joint limits instead of settling.
    goal = this.#minReachClamp(f, arm, goal);
    // The arm is rolled toward the elbow hint before each solve, so the
    // two-bone solve — which preserves swivel and always runs last — has the
    // final word on reaching the goal even when the hint fights the
    // shoulder's limits.
    // The solve preserves each arm's swivel, so the elbows keep hanging the
    // way the pose was authored (see presets.js: elbows down, the leader's
    // right forearm layered under the follower's left arm, hers above his) —
    // no roll is forced here; forcing one fights the joint limits on these
    // close-in reaches and destabilizes the per-frame solve.
    // First pass aims the wrist half a hand short of the goal along the
    // current forearm; later passes re-aim it a measured wrist→palm vector
    // short of the goal. (The correction is recomputed from the goal each
    // pass, never accumulated, so an unreachable goal cannot make the target
    // run away — the arm just settles as close as its limits allow.)
    const target = goal.clone();
    const fore = f.nodes[arm.wrist].getWorldPosition(new THREE.Vector3())
      .sub(f.nodes[arm.elbow].getWorldPosition(new THREE.Vector3()));
    if (fore.lengthSq() > 1e-10) target.addScaledVector(fore.normalize(), -HAND_HALF * f.height);
    for (let i = 0; i < 5; i++) {
      solveTwoBone(f, chain, target);
      const palm = handCenter(f, arm.wrist, arm.hand);
      if (palm.distanceTo(goal) < 0.002) break;
      const handVec = palm.sub(f.nodes[arm.wrist].getWorldPosition(new THREE.Vector3()));
      target.copy(goal).sub(handVec);
    }
  }

  // Turn the open-side palms onto the clasp: the leader's palm faces inward
  // (his hand is the outside of the hold), the follower's faces outward — for
  // her right arm that is the external forearm rotation that presents the
  // palm. Elbow pronation/supination only; the wrist keeps its finger wrap.
  #facePalms(skipArm, outward) {
    if (skipArm !== 'leaderOpen') this.#pronate(this.leader, ARMS.leaderOpen, outward.clone().negate());
    if (skipArm !== 'followerOpen') this.#pronate(this.follower, ARMS.followerOpen, outward);
  }

  // Set elbow twist so the palm normal (with a neutral wrist) points as close
  // to `dirWorld` as the pronation range allows. The palm normal is +Z in the
  // hand's frame at rest (anatomical position, palms forward); with XYZ Euler
  // order it becomes Rx(flex)·Ry(θ)·(0,0,1) in the elbow's parent frame, so
  // θ comes from `dirWorld` expressed in the post-flexion frame.
  #pronate(figure, arm, dirWorld) {
    const elbow = figure.nodes[arm.elbow];
    const parentQ = elbow.parent.getWorldQuaternion(new THREE.Quaternion());
    const local = dirWorld.clone().applyQuaternion(parentQ.invert());
    local.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), -elbow.rotation.x,
    ));
    if (Math.hypot(local.x, local.z) < 1e-4) return; // clasp along the forearm axis
    const theta = Math.atan2(local.x, local.z);
    elbow.rotation.y = clampAngle(theta, JOINT_BY_NAME[arm.elbow].limits.y);
  }
}
