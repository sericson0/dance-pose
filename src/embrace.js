import * as THREE from 'three';
import { JOINT_BY_NAME, DEG, clampAngle } from './skeletonDef.js';
import { solveTwoBone, swivelLimb } from './ik.js';

// The tango embrace as a set of per-frame constraints (see main.js's loop),
// modelled on the real embrace:
//
//  * Closed side — the leader's right arm passes UNDER the follower's left
//    arm and around her, palm resting flat on her back below her left
//    shoulder blade; the follower's left arm drapes OVER his right arm, palm
//    on the outside of his right deltoid. The over/under layering comes from
//    the authored embrace pose (presets.js) and survives because the
//    two-bone solve preserves each arm's swivel.
//  * Open side — the leader's LEFT hand holds the follower's RIGHT palm to
//    palm: the palms meet along the ray from his chest through the clasp,
//    his palm facing her, hers facing him, the palm surfaces in contact.
//    The joined hands are held like a vertical handshake — fingers pointing
//    up, tilted from vertical by the user-set clasp tilt (UI slider) — with
//    a soft wrap: each hand's fingers lean a few degrees over the back of
//    the partner's hand, and on the clothed avatars the finger bones curl
//    lightly (Figure.setFingerCurl).
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

const UP = new THREE.Vector3(0, 1, 0);

// Open-side clasp: distance between the two palm centers (fraction of mean
// height) — the skin-to-skin thickness of two palms pressed together, true
// palm-to-palm contact. The palms meet along the horizontal ray from the
// leader's chest through the clasp: his hand on his side of it facing her,
// hers beyond it facing him.
const PALM_GAP = 0.008;

// Soft wrap: each clasped hand's fingers lean this much past the shared
// finger direction toward the back of the partner's hand — the way its own
// palm faces. (Exported for the dev verification script.)
export const CLASP_WRAP_DEG = 10;

// The clasped open-side fingers close lightly around the partner's hand —
// palm contact carries the connection, so well short of a full fist curl.
const CLASP_CURL = 0.65;

// The closed-side hands rest ON the partner (his right on her back, her left on
// his shoulder), so their fingers close softly onto the body instead of staying
// splayed like the avatar's rest hand — a gentle curl, not the full clasp grip.
const CLOSED_CURL = 0.45;

// A palm cannot fold in closer to its own shoulder than roughly this (fraction
// of height). Goals inside this radius are pushed out to it — without the
// clamp a too-near clasp point makes the per-frame solve ratchet the arm
// around its joint limits instead of settling.
const MIN_REACH = 0.12;

// Working pronation span the embrace arm solves within, in degrees. The elbow
// joint itself allows a wider palm turn (±120°) for free posing, but the clasp
// branch-ranking (#demandBranches / #poseError) and the closed-side #pronate
// were tuned to the forearm's natural ±85° range: letting the solve reach past
// it lets it pick a strained pronation branch that leaves the joined hands
// gapping after a pivot. So the embrace caps pronation to this range while the
// joint limit still governs the UI slider and gizmo.
const CLASP_PRONATION_DEG = 85;
const claspPronationRange = (arm) => {
  const [lo, hi] = JOINT_BY_NAME[arm.elbow].limits.y;
  return [Math.max(lo, -CLASP_PRONATION_DEG), Math.min(hi, CLASP_PRONATION_DEG)];
};

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
    this.tiltDeg = 20; // joined hands' finger tilt from vertical (UI slider)
    // Height of the seeded clasp above the open-side shoulders, as a fraction
    // of mean stature (UI "Clasp height" slider). 0 = shoulder level, the
    // natural close-embrace frame — the hands join at collarbone height and
    // the elbows hang. Raising it lifts the hands (and the elbows with them)
    // toward a raised salon frame; the elbow height follows the clasp, not
    // the finger tilt (the hand is above the shoulder, so the elbow must rise
    // to reach it).
    this.claspHeight = 0;
    // The clasp point stored in each dancer's chest frame; the live target is
    // the midpoint of the two, so it follows both torsos as they move.
    this.claspLocal = { leader: null, follower: null };
    // ALTERNATIVE OPEN-SIDE MODEL: each dancer's open-side elbow swivel, in
    // degrees around the shoulder→wrist axis (0 = elbow hanging straight
    // down). Set by hand from the UI (Embrace panel); the clasp holds the
    // wrists, this only swings the elbow between them (see #maintainOpenSide
    // / #setElbowSwivel). Replaces the old auto-searched swivel (#swivelForPalm).
    this.openElbow = { leader: 0, follower: 0 };
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
    this.leader.setFingerCurl('L', on ? CLASP_CURL : 0);
    this.follower.setFingerCurl('R', on ? CLASP_CURL : 0);
    this.leader.setFingerCurl('R', on ? CLOSED_CURL : 0);
    this.follower.setFingerCurl('L', on ? CLOSED_CURL : 0);
  }

  setClose(on) {
    this.close = on;
  }

  // Finger tilt of the joined hands, degrees from vertical (0 = fingers up).
  setTilt(deg) {
    this.tiltDeg = deg;
  }

  // ALTERNATIVE OPEN-SIDE MODEL: swing one dancer's open-side elbow to `deg`
  // around its shoulder→wrist axis (0 = elbow hanging down). The joined hands
  // stay pinned, so moving the elbow never disturbs the partner's hand.
  setOpenElbow(role, deg) {
    this.openElbow[role] = deg;
  }

  // Height of the joined open-side hands, as a fraction of mean stature above
  // the open-side shoulders (0 = shoulder level). Re-seats the live clasp at
  // the new height, keeping its horizontal position, so the elbows rise or
  // fall to follow it (see #swivelForPalm — the elbow tracks the clasp, the
  // hand being above the shoulder is what forces it up).
  setClaspHeight(frac) {
    this.claspHeight = frac;
    const clasp = this.claspWorld();
    if (!clasp) return; // not engaged yet; defaultClasp() will use it
    clasp.y = this.#claspShoulderY() + frac * this.#meanHeight();
    this.captureClasp(clasp);
  }

  #meanHeight() {
    return (this.leader.height + this.follower.height) / 2;
  }

  // Mean height of the two open-side shoulders (the clasp's height reference).
  #claspShoulderY() {
    return (this.leader.worldPos('shoulder_L').y
      + this.follower.worldPos('shoulder_R').y) / 2;
  }

  // Where the hands join when the clasp engages: the canonical tango hold —
  // out to the open side past the couple's open-side shoulders, midway
  // between the two chests, at the clasp height (`claspHeight`, default
  // shoulder level — the natural close-embrace frame, elbows hanging; the
  // "Clasp height" slider raises it toward a salon frame). The horizontal
  // placement is chosen so that both arms can really deliver the clasp
  // orientation (palms facing each other along the couple axis): seeding the
  // clasp from wherever the hands happen to hang can land it where that
  // orientation is anatomically unreachable — too close over the shoulders,
  // the demanded pronation sits in the dead zone at every swivel and a hand
  // turns its back on the partner. Dragging an open-side hand afterwards
  // re-captures the clasp wherever the user puts it.
  defaultClasp() {
    const base = this.leader.worldPos('shoulder_L')
      .add(this.follower.worldPos('shoulder_R'))
      .multiplyScalar(0.5);
    const meanH = this.#meanHeight();
    const mid = this.leader.worldPos('chest')
      .add(this.follower.worldPos('chest')).multiplyScalar(0.5);
    const out = base.clone().sub(mid);
    out.y = 0;
    if (out.lengthSq() > 1e-6) base.addScaledVector(out.normalize(), 0.10 * meanH);
    base.y += this.claspHeight * meanH; // shoulder level by default
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
    const t = this.palmGap() / 2;

    // Open side (ALTERNATIVE MODEL): the joined hands are held in palm
    // contact and turned to face each other, and each dancer's open-side
    // elbow is swung by hand (UI) rather than auto-solved — see
    // #maintainOpenSide. The original auto-solved clasp orientation is kept
    // below, commented out, for a side-by-side comparison.
    this.#maintainOpenSide(edited, t);
    /* --- original open-side clasp (superseded by #maintainOpenSide) -------
    // Open side: palms joined around the shared clasp point — the leader's
    // half a gap on his side of it, the follower's half a gap beyond — with
    // both hands' fingers aimed up the clasp's tilted vertical and the palm
    // surfaces facing each other across it (his toward her, hers toward
    // him).
    if (edited === 'leaderOpen' || edited === 'followerOpen') {
      const arm = ARMS[edited];
      const palm = handCenter(this.figure(arm.role), arm.wrist, arm.hand);
      const out = this.#claspOutward();
      // Store the midpoint between the palms as the clasp.
      const clasp = palm.clone().addScaledVector(out, edited === 'leaderOpen' ? t : -t);
      this.captureClasp(clasp);
      const other = edited === 'leaderOpen' ? 'followerOpen' : 'leaderOpen';
      const dir = this.#claspFingerDir(out, clasp, other);
      const palmDir = out.clone().multiplyScalar(other === 'leaderOpen' ? 1 : -1);
      this.#solveArm(other, clasp.clone().addScaledVector(out, other === 'leaderOpen' ? -t : t), dir, palmDir);
    } else {
      const clasp = this.claspWorld();
      if (!clasp) return;
      const out = this.#claspOutward();
      const dirL = this.#claspFingerDir(out, clasp, 'leaderOpen');
      const dirF = this.#claspFingerDir(out, clasp, 'followerOpen');
      const palmF = out.clone().negate();
      this.#solveArm('leaderOpen', clasp.clone().addScaledVector(out, -t), dirL, out);
      this.#solveArm('followerOpen', clasp.clone().addScaledVector(out, t), dirF, palmF);
      // If joint limits kept an arm short of the clasp point, meet halfway:
      // re-target both palms around the midpoint of where they landed. The
      // signed check also catches palms that met at the right distance but
      // stacked in the wrong order along the axis.
      const a = handCenter(this.leader, 'wrist_L', 'hand_L');
      const b = handCenter(this.follower, 'wrist_R', 'hand_R');
      const signed = b.clone().sub(a).dot(out);
      if (Math.abs(signed - 2 * t) > 0.004 || Math.abs(a.distanceTo(b) - 2 * t) > 0.004) {
        const mid = a.add(b).multiplyScalar(0.5);
        this.#solveArm('leaderOpen', mid.clone().addScaledVector(out, -t), dirL, out);
        this.#solveArm('followerOpen', mid.clone().addScaledVector(out, t), dirF, palmF);
      }
    }
    --- end original open-side clasp ------------------------------------- */

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

  // ALTERNATIVE OPEN-SIDE MODEL ------------------------------------------
  //
  // Two rules replace the old auto-solved clasp:
  //   1. Palm contact + facing. The two open-side hands are held around a
  //      shared clasp point (the midpoint between them, stored in both chest
  //      frames so it rides the couple) no farther apart than PALM_GAP, each
  //      palm turned to face the other along the couple axis.
  //   2. Manual elbow. Each dancer's open-side elbow swivel is set from the
  //      UI (openElbow), not searched. Swivelling rotates the arm about the
  //      shoulder→wrist line, which leaves the pinned wrist — and so the
  //      partner's clasped hand — exactly where it is.
  #maintainOpenSide(edited, t) {
    const out = this.#claspOutward();
    const fingerDir = this.#simpleFingerDir(out);
    // The user is posing one open hand: re-anchor the clasp on it and solve
    // only the partner to meet it (the edited hand is left alone).
    if (edited === 'leaderOpen' || edited === 'followerOpen') {
      const arm = ARMS[edited];
      const palm = handCenter(this.figure(arm.role), arm.wrist, arm.hand);
      const clasp = palm.clone().addScaledVector(out, edited === 'leaderOpen' ? t : -t);
      this.captureClasp(clasp);
      const other = edited === 'leaderOpen' ? 'followerOpen' : 'leaderOpen';
      const palmDir = out.clone().multiplyScalar(other === 'leaderOpen' ? 1 : -1);
      const goal = clasp.clone().addScaledVector(out, other === 'leaderOpen' ? -t : t);
      this.#solveOpenArm(other, goal, fingerDir, palmDir, this.openElbow[ARMS[other].role]);
      return;
    }
    const clasp = this.claspWorld();
    if (!clasp) return;
    const palmF = out.clone().negate();
    this.#solveOpenArm('leaderOpen', clasp.clone().addScaledVector(out, -t), fingerDir, out, this.openElbow.leader);
    this.#solveOpenArm('followerOpen', clasp.clone().addScaledVector(out, t), fingerDir, palmF, this.openElbow.follower);
    // Rule 1's distance cap: if joint limits left the palms more than a hair
    // apart (or stacked in the wrong order along the axis), meet halfway.
    const a = handCenter(this.leader, 'wrist_L', 'hand_L');
    const b = handCenter(this.follower, 'wrist_R', 'hand_R');
    const signed = b.clone().sub(a).dot(out);
    if (Math.abs(signed - 2 * t) > 0.004 || Math.abs(a.distanceTo(b) - 2 * t) > 0.004) {
      const mid = a.add(b).multiplyScalar(0.5);
      this.#solveOpenArm('leaderOpen', mid.clone().addScaledVector(out, -t), fingerDir, out, this.openElbow.leader);
      this.#solveOpenArm('followerOpen', mid.clone().addScaledVector(out, t), fingerDir, palmF, this.openElbow.follower);
    }
  }

  // Finger direction for the joined hands: up (a vertical handshake), leaned
  // `tiltDeg` from vertical toward the couple's midline. Shared by both hands
  // so they read as facing each other. (The old per-hand wrap is dropped in
  // this model — see #claspFingerDir for the original.)
  #simpleFingerDir(out) {
    const tangent = out.clone().cross(UP);
    if (tangent.lengthSq() < 1e-8) return UP.clone();
    tangent.normalize();
    const clasp = this.claspWorld();
    if (clasp) {
      const toMid = this.leader.worldPos('chest')
        .add(this.follower.worldPos('chest')).multiplyScalar(0.5).sub(clasp);
      toMid.y = 0;
      if (tangent.dot(toMid) < 0) tangent.negate(); // lean in over the couple
    }
    const tilt = this.tiltDeg * DEG;
    return UP.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(tangent, Math.sin(tilt)).normalize();
  }

  // Reach an open-side palm to `goal` and hold it there, palm facing
  // `palmDir`, fingers along `fingerDir`, with the elbow parked at the user's
  // swivel angle `elbowDeg`. Mirrors #solveArm's iterate-and-correct loop but
  // sets the elbow from the manual control (#setElbowSwivel) instead of
  // searching it (#swivelForPalm). #orientHand still turns the palm to face
  // the partner through elbow pronation + wrist flex/deviation.
  #solveOpenArm(armKey, goal, fingerDir, palmDir, elbowDeg) {
    const arm = ARMS[armKey];
    const f = this.figure(arm.role);
    const chain = { root: arm.shoulder, mid: arm.elbow, effector: arm.wrist, hingeSign: -1 };
    goal = this.#minReachClamp(f, arm, goal);
    const target = goal.clone().addScaledVector(fingerDir, -HAND_HALF * f.height);
    for (let i = 0; i < 6; i++) {
      solveTwoBone(f, chain, target); // preserves the arm's current swivel
      this.#setElbowSwivel(f, arm, elbowDeg); // park the elbow, wrist pinned
      this.#orientHand(f, arm, fingerDir, palmDir);
      const palm = handCenter(f, arm.wrist, arm.hand);
      if (palm.distanceTo(goal) < 0.002) break;
      const handVec = palm.sub(f.nodes[arm.wrist].getWorldPosition(new THREE.Vector3()));
      target.copy(goal).sub(handVec);
    }
  }

  // Swing an arm's elbow to swivel angle `deg` around the shoulder→wrist
  // axis (0 = elbow hanging straight down), keeping the shoulder and the
  // wrist pinned so the clasp — and the partner's hand — never move. We
  // build the target elbow point on that circle and hand the actual roll to
  // swivelLimb, which walks the roll only as far as the shoulder limits allow
  // (bisecting for feasibility) so the endpoints stay put even when `deg`
  // asks for more than the joint can give. The circle reference (world-down,
  // or the figure's forward when the axis is vertical) is the manual
  // counterpart of the old #swivelForPalm search, so `deg` reads the same.
  #setElbowSwivel(f, arm, deg) {
    const shoulder = f.nodes[arm.shoulder].getWorldPosition(new THREE.Vector3());
    const wrist = f.nodes[arm.wrist].getWorldPosition(new THREE.Vector3());
    const elbowPos = f.nodes[arm.elbow].getWorldPosition(new THREE.Vector3());
    const axis = wrist.clone().sub(shoulder);
    if (axis.lengthSq() < 1e-8) return;
    axis.normalize();
    const center = shoulder.clone().addScaledVector(axis, elbowPos.clone().sub(shoulder).dot(axis));
    const u0 = new THREE.Vector3(0, -1, 0).addScaledVector(axis, axis.y);
    if (u0.lengthSq() < 1e-4) {
      u0.set(0, 0, 1).applyQuaternion(f.group.quaternion).addScaledVector(axis, -axis.dot(u0));
    }
    if (u0.lengthSq() < 1e-8) return;
    u0.normalize();
    const v0 = new THREE.Vector3().crossVectors(axis, u0);
    const theta = deg * DEG;
    const des = u0.multiplyScalar(Math.cos(theta)).addScaledVector(v0, Math.sin(theta));
    swivelLimb(f, { root: arm.shoulder, mid: arm.elbow, effector: arm.wrist }, center.add(des));
  }

  // Where the clasp says an open-side hand's fingers should point right now
  // (null until the clasp is captured). Public for the dev verification
  // script.
  claspFingerTarget(armKey) {
    const clasp = this.claspWorld();
    if (!clasp) return null;
    return this.#claspFingerDir(this.#claspOutward(), clasp, armKey);
  }

  // Direction the joined hands' fingers point: vertical (a handshake hold,
  // fingers up) tilted `tiltDeg` toward the couple's midline — rotating in
  // the palm contact plane, so 0° is fingers straight up — then wrapped a
  // further CLASP_WRAP_DEG toward the back of the partner's hand (each
  // hand's tips lean the way its own palm faces: the soft finger wrap).
  #claspFingerDir(out, clasp, armKey) {
    const tangent = out.clone().cross(UP).normalize();
    const toMid = this.leader.worldPos('chest')
      .add(this.follower.worldPos('chest')).multiplyScalar(0.5).sub(clasp);
    toMid.y = 0;
    if (tangent.dot(toMid) < 0) tangent.negate(); // lean in over the couple
    const tilt = this.tiltDeg * DEG;
    const d = UP.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(tangent, Math.sin(tilt));
    const wrap = CLASP_WRAP_DEG * DEG;
    const facing = armKey === 'leaderOpen' ? 1 : -1; // each palm's facing along `out`
    return d.multiplyScalar(Math.cos(wrap)).addScaledVector(out, facing * Math.sin(wrap)).normalize();
  }

  // The hand's full target orientation: at rest the fingers run along local
  // -Y and the palm normal is local +Z (anatomical position, palms
  // forward), so a finger direction plus a palm facing pin the whole frame
  // (the palm component is made perpendicular to the fingers — the finger
  // wrap tilts the palm with it). Returns { q, palmAxis } (the world palm
  // normal, the axis an in-palm-plane finger lean rotates about), or null
  // if degenerate.
  #handTarget(fingerDir, palmDir) {
    const y = fingerDir.clone().negate().normalize();
    const z = palmDir.clone().addScaledVector(y, -y.dot(palmDir));
    if (z.lengthSq() < 1e-8) return null; // palm target parallel to the fingers
    z.normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    return {
      q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)),
      palmAxis: z,
    };
  }

  // When the geometry is strained, the ideal clasp orientation can sit
  // outside the joint limits at every swivel. Rather than let the clamps
  // scatter the error anywhere (which is what turns a palm away from the
  // partner), concede the one thing a real dancer concedes: the fingers
  // lean over in the palm's contact plane — palm-to-palm contact holds, the
  // hands tip into a diagonal clasp. Candidate leans, radians, tried on
  // both sides of the tilt direction.
  static #LEANS = [0, 20, 40, 60].flatMap((d) => (d ? [d * DEG, -d * DEG] : [0]));

  #leanedTarget(target, lean) {
    if (!lean) return target.q;
    return new THREE.Quaternion().setFromAxisAngle(target.palmAxis, lean).multiply(target.q);
  }

  // What the hand would actually do with the clamped joint angles `d`: the
  // achieved palm/finger directions, scored against the ideal (palm error
  // weighs double — palm-to-palm facing is the truth of the clasp; finger
  // error is the visible lean). This is what candidate swivels and leans
  // are ranked by: ranking by raw limit violation instead lets a candidate
  // "win" while its clamped remainder lands entirely on the palm.
  #poseError(f, arm, d, preRot, fingerDir, palmAxis) {
    const elbow = f.nodes[arm.elbow];
    const q = elbow.parent.getWorldQuaternion(new THREE.Quaternion())
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), elbow.rotation.x));
    if (preRot) q.premultiply(preRot);
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(d.x, d.y, d.z, 'YXZ')));
    const palm = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const fingers = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
    const palmErr = palm.angleTo(palmAxis);
    const fingerErr = fingers.angleTo(fingerDir);
    return 2 * palmErr + fingerErr;
  }

  // Joint angles that reach `targetQ` through the arm's three orientation
  // dofs. The chain from the flexed elbow to the hand is
  // Ry(pronation)·Rx(wristX)·Rz(wristZ) — elbow Euler order XYZ puts
  // pronation after its flexion, the wrist has no y — which is exactly a
  // YXZ Euler decomposition of the required relative rotation. Euler
  // solutions come in pairs, so both branches are returned, each clamped
  // to the joint limits (the caller ranks them by #poseError); `preRot`
  // optionally pre-rotates the arm in world space (a candidate swivel,
  // #swivelForPalm) without touching the pose.
  #demandBranches(f, arm, targetQ, preRot = null) {
    const elbow = f.nodes[arm.elbow];
    // Frame after the elbow's flexion but before its pronation.
    const postFlex = elbow.parent.getWorldQuaternion(new THREE.Quaternion())
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), elbow.rotation.x));
    if (preRot) postFlex.premultiply(preRot);
    const m = new THREE.Matrix4().makeRotationFromQuaternion(postFlex.invert())
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(targetQ));
    const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
    const wrap = (a) => THREE.MathUtils.euclideanModulo(a + Math.PI, 2 * Math.PI) - Math.PI;
    const ly = claspPronationRange(arm);
    const lw = JOINT_BY_NAME[arm.wrist].limits;
    return [
      [e.y, e.x, e.z],
      [wrap(e.y + Math.PI), wrap(Math.PI - e.x), wrap(e.z + Math.PI)],
    ].map(([y, x, z]) => ({
      y: clampAngle(y, ly),
      x: clampAngle(x, lw.x),
      z: clampAngle(z, lw.z),
    }));
  }

  // Coarser lean grid for scoring swivel candidates (the applied lean is
  // re-picked from the full #LEANS afterwards).
  static #SEARCH_LEANS = [0, 40 * DEG, -40 * DEG];

  // The best clamped joint solution for the clasp ideal at the arm's
  // current (or candidate, `preRot`) swivel: every finger lean × Euler
  // branch, ranked by the achieved-orientation error. A small lean penalty
  // keeps the fingers exactly on the tilt whenever the ideal is reachable.
  #bestHandPose(f, arm, target, fingerDir, preRot = null, leans = Embrace.#LEANS) {
    let best = null;
    for (const lean of leans) {
      const tq = this.#leanedTarget(target, lean);
      for (const d of this.#demandBranches(f, arm, tq, preRot)) {
        // The lean penalty keeps the fingers answering the tilt slider: a
        // lean must buy a clearly better palm/finger fit to be worth it.
        const score = this.#poseError(f, arm, d, preRot, fingerDir, target.palmAxis)
          + 0.3 * Math.abs(lean);
        if (!best || score < best.score) best = { score, d };
      }
    }
    return best;
  }

  // Orient the whole hand: fingers along `fingerDir` (leaning in the palm
  // plane only if the limits demand it — see #LEANS), palm surface facing
  // `palmDir` — solved exactly through the arm's three real orientation
  // dofs (elbow pronation, wrist flexion, wrist deviation), each clamped to
  // its joint limit. Solving them together matters: pronation set with a
  // neutral wrist gets undone the moment the wrist bends to point the
  // fingers (that ordering left the follower's palm ~90° off).
  #orientHand(f, arm, fingerDir, palmDir) {
    const target = this.#handTarget(fingerDir, palmDir);
    if (!target) return;
    const best = this.#bestHandPose(f, arm, target, fingerDir);
    f.nodes[arm.elbow].rotation.y = best.d.y;
    f.nodes[arm.wrist].rotation.set(best.d.x, 0, best.d.z);
    f.group.updateMatrixWorld(true);
  }

  // Choose a clasp arm's swivel — the elbow's position on its circle around
  // the shoulder→wrist axis — so the demanded hand orientation actually
  // fits the joint limits. The swivel is the arm's spare dof and the
  // deciding one: pronation only spans ±85°, so with the wrong swivel a
  // palm-out clasp sits in the unreachable 190° (the follower's palm ended
  // up backwards exactly this way). Candidates are sampled absolutely
  // around the circle (referenced to world-down, so the result is a pure
  // function of the pose — a per-frame feedback roll ratchets, this
  // cannot), scored by orientation-demand violation + how far the shoulder
  // must clamp + a mild preference for a low, naturally hanging elbow.
  // Rotating about the shoulder→wrist axis leaves the wrist — the clasp —
  // in place.
  #swivelForPalm(f, arm, fingerDir, palmDir) {
    const target = this.#handTarget(fingerDir, palmDir);
    if (!target) return;
    // Settled pose already delivering the clasp (≲11° combined error):
    // keep the current swivel and skip the search — this is the steady
    // state, so the per-frame cost stays low.
    if (this.#bestHandPose(f, arm, target, fingerDir).score < 0.2) return;
    const root = f.nodes[arm.shoulder];
    const shoulder = root.getWorldPosition(new THREE.Vector3());
    const wrist = f.nodes[arm.wrist].getWorldPosition(new THREE.Vector3());
    const elbowPos = f.nodes[arm.elbow].getWorldPosition(new THREE.Vector3());
    const axis = wrist.clone().sub(shoulder);
    if (axis.lengthSq() < 1e-8) return;
    axis.normalize();
    const center = shoulder.clone().addScaledVector(axis, elbowPos.clone().sub(shoulder).dot(axis));
    const cur = elbowPos.clone().sub(center);
    if (cur.lengthSq() < 1e-8) return; // arm straight along the axis
    cur.normalize();
    // Absolute reference around the circle: world-down (the hanging elbow),
    // or the figure's forward when the axis itself is vertical.
    const u0 = new THREE.Vector3(0, -1, 0).addScaledVector(axis, axis.y);
    if (u0.lengthSq() < 1e-4) {
      u0.set(0, 0, 1).applyQuaternion(f.group.quaternion).addScaledVector(axis, -axis.dot(u0));
    }
    if (u0.lengthSq() < 1e-8) return;
    u0.normalize();
    const v0 = new THREE.Vector3().crossVectors(axis, u0);
    const parentQ = root.parent.getWorldQuaternion(new THREE.Quaternion());
    const parentQInv = parentQ.clone().invert();
    const shoulderLimits = JOINT_BY_NAME[arm.shoulder].limits;
    let best = null;
    for (let deg = -180; deg < 180; deg += 15) {
      const theta = deg * DEG;
      const des = u0.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v0, Math.sin(theta));
      const psi = Math.atan2(axis.dot(new THREE.Vector3().crossVectors(cur, des)), cur.dot(des));
      const preRot = new THREE.Quaternion().setFromAxisAngle(axis, psi);
      // How much of the candidate the shoulder's own limits would give
      // back: a clamped-away swivel would not land where it was scored.
      const localQ = parentQInv.clone().multiply(preRot).multiply(parentQ).multiply(root.quaternion);
      const le = new THREE.Euler().setFromQuaternion(localQ, 'XYZ');
      const shoulderViolation = Math.abs(le.x - clampAngle(le.x, shoulderLimits.x))
        + Math.abs(le.y - clampAngle(le.y, shoulderLimits.y))
        + Math.abs(le.z - clampAngle(le.z, shoulderLimits.z));
      const score = this.#bestHandPose(f, arm, target, fingerDir, preRot, Embrace.#SEARCH_LEANS).score
        + 3 * shoulderViolation + 0.05 * Math.abs(theta);
      if (!best || score < best.score) best = { score, psi };
    }
    root.quaternion.premultiply(parentQInv.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(axis, best.psi),
    ).multiply(parentQ));
    f.clampJoint(arm.shoulder);
    f.group.updateMatrixWorld(true);
  }

  // Horizontal direction of the clasp's contact normal: the couple axis,
  // leader's chest toward the follower's — a vertical handshake between two
  // facing people meets palm to palm along the line between them, his palm
  // facing her, hers facing him. Both facings point across the owner's own
  // body (medially), which stays anatomically reachable even with the
  // hands held close-in beside the shoulders (close embrace); any normal
  // that asks a close-in palm to face laterally away from its own chest —
  // e.g. the ray from either chest out through the clasp — lands in the
  // pronation dead zone and the hand turns its back on the partner. The
  // joined hands stack along it: the leader's palm half a gap on his side
  // of the clasp, the follower's half a gap beyond it.
  #claspOutward() {
    const out = this.follower.worldPos('chest').sub(this.leader.worldPos('chest'));
    out.y = 0;
    if (out.lengthSq() < 1e-6) {
      // Chests vertically aligned (degenerate): use the leader's forward.
      out.set(0, 0, 1).applyQuaternion(this.leader.group.quaternion);
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

  // Reach the palm center to `goal`, then iterate the two-bone solve — each
  // pass re-solves the chain, re-orients the hand (clasp arms point their
  // fingers along `fingerDir` with the palm facing `palmDir`; closed-side
  // palms keep a neutral, flat wrist), measures where the palm actually
  // landed and moves the wrist target by the remaining error.
  #solveArm(armKey, goal, fingerDir = null, palmDir = null) {
    const arm = ARMS[armKey];
    const f = this.figure(arm.role);
    const chain = { root: arm.shoulder, mid: arm.elbow, effector: arm.wrist, hingeSign: -1 };
    if (!fingerDir) f.nodes[arm.wrist].rotation.set(0, 0, 0);
    // Keep the goal outside the palm's minimum fold-in radius — without the
    // clamp a too-near goal makes the per-frame solve ratchet the arm around
    // its joint limits instead of settling.
    goal = this.#minReachClamp(f, arm, goal);
    // Closed-side arms keep whatever swivel the pose was authored with (see
    // presets.js: elbows down, the leader's right forearm layered under the
    // follower's left arm, hers above his) — the two-bone solve preserves
    // it, and no roll is forced; a forced roll fights the joint limits on
    // these close-in reaches and destabilizes the per-frame solve. Clasp
    // arms instead set their swivel deterministically each pass
    // (#swivelForPalm): the elbow position from which the demanded palm
    // facing actually fits the pronation and wrist limits.
    // First pass aims the wrist half a hand short of the goal along the
    // finger direction (or the current forearm when there is none); later
    // passes re-aim it a measured wrist→palm vector short of the goal. (The
    // correction is recomputed from the goal each pass, never accumulated,
    // so an unreachable goal cannot make the target run away — the arm just
    // settles as close as its limits allow.)
    const target = goal.clone();
    const fore = fingerDir ? fingerDir.clone()
      : f.nodes[arm.wrist].getWorldPosition(new THREE.Vector3())
        .sub(f.nodes[arm.elbow].getWorldPosition(new THREE.Vector3()));
    if (fore.lengthSq() > 1e-10) target.addScaledVector(fore.normalize(), -HAND_HALF * f.height);
    for (let i = 0; i < 6; i++) {
      solveTwoBone(f, chain, target);
      if (fingerDir) {
        // Swivel once per solve — it changes little between passes, and
        // the search is the expensive part of the constraint.
        if (i === 0) this.#swivelForPalm(f, arm, fingerDir, palmDir);
        this.#orientHand(f, arm, fingerDir, palmDir);
      }
      const palm = handCenter(f, arm.wrist, arm.hand);
      if (palm.distanceTo(goal) < 0.002) break;
      const handVec = palm.sub(f.nodes[arm.wrist].getWorldPosition(new THREE.Vector3()));
      target.copy(goal).sub(handVec);
    }
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
    elbow.rotation.y = clampAngle(theta, claspPronationRange(arm));
  }
}
