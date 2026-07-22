import * as THREE from 'three';
import { JOINTS, JOINT_TITLES } from './skeletonDef.js';
import { solveTwoBone } from './ik.js';

// User-authored contact constraints: a spot on one dancer pinned to a spot on
// the other, held together every frame (main.js loop) the way the embrace
// holds its clasp — pick his palm and her shoulder blade to author a custom
// hold, or his foot and her foot for a parada. Each spot is stored in the
// local frame of the joint node nearest where the user clicked, so it rides
// that body part through any pose.
//
// Resolution follows the embrace convention — the partner of whoever is being
// edited adapts (default: the follower) — and HOW they adapt depends on where
// the adapting dancer's spot rides:
//  * an arm spot (shoulder → hand): that arm re-solves via two-bone IK so the
//    spot reaches the partner's spot; the body stays put
//  * a leg spot (hip → toe): the leg re-solves the same way (then the dancer
//    re-clamps to the floor, so a pin can never pull a foot underground)
//  * a torso/head spot: the whole dancer slides horizontally, exactly like
//    the close-embrace torso pull; a vertical mismatch is left to the pose
//    (translating a dancer up would just fight the floor)
//
// Pins run AFTER the embrace constraints, so a pin on an embrace arm
// deliberately overrides the embrace's own target for that arm — the pin is
// the more specific intent. Joint limits bound every solve: an out-of-reach
// pin rests at the closest pose anatomy allows, it never teleports anyone.

const ARM = /^(?:shoulder|elbow|wrist|hand)_(L|R)$/;
const LEG = /^(?:hip|knee|ankle|toes|toe)_(L|R)$/;

// A pin end's marker + the line between the two ends when they can't close.
const END_COLOR = 0x69d2a2;
const STRAINED_COLOR = 0xe0a45f;

const _spot = new THREE.Vector3();
const _target = new THREE.Vector3();
const _eff = new THREE.Vector3();

// The frame a pin spot on `nodeName` is stored in — ARM spots ride the atlas
// node the clothed arm is welded to, everything else stays on the rig node.
//
// Arms migrate because the error there is enormous and self-contained: the rig
// elbow sits 97 mm from the visible elbow and wanders 111 mm across poses,
// against 37 mm / 15 mm in the atlas frame, and nothing else depends on where
// an arm spot lives. LEGS deliberately do not, even though they are seated
// too: clampToFloor and the balance hull read this figure's sole corners in
// the RIG ankle's frame, so a leg spot driven in the atlas frame fights the
// floor clamp — measured, it lifted the pinned foot from 9 mm off the floor to
// 66 mm. Migrating legs means moving the corner tables with them and
// re-verifying grounding, which is a separate change (collision.js draws the
// same arm/leg line, for the same reason).
//
// Every site that touches a spot must go through this: nearestJointNode picks
// with it, main.js's authoring stores with it, endWorld plays it back with it,
// and maintainLimbs re-reads it with it. A spot measured in one frame and
// replayed in another lands somewhere the user never clicked — measured at
// ~10 cm on a flexed arm.
export function spotNode(figure, nodeName) {
  return ARM.test(nodeName) ? figure.surfaceNode(nodeName) : figure.nodes[nodeName];
}

// The joint node whose origin sits nearest a world point on `figure` — the
// anchor a clicked spot is stored under. Every joint (endpoints included) is
// a candidate; the arm/leg regexes above decide how the spot later resolves.
export function nearestJointNode(figure, worldPoint) {
  let best = null;
  let bestD = Infinity;
  for (const def of JOINTS) {
    const d = spotNode(figure, def.name).getWorldPosition(_spot).distanceToSquared(worldPoint);
    if (d < bestD) { bestD = d; best = def.name; }
  }
  return best;
}

// Short human label for a pin end ("R wrist", "chest", …) for the UI list.
export function endLabel(end) {
  return JOINT_TITLES[end.node] || end.node;
}

export class ContactPins {
  constructor(leader, follower) {
    this.leader = leader;
    this.follower = follower;
    this.pins = []; // { leader: { node, local:Vector3 }, follower: {...}, viz }
    this.group = new THREE.Group(); // end markers + strain lines, per pin
  }

  count() {
    return this.pins.length;
  }

  #figure(role) {
    return role === 'leader' ? this.leader : this.follower;
  }

  // World position of one pin end (the spot riding its joint node). Must use
  // the same frame nearestJointNode stored it in — see the note there.
  endWorld(role, pin, out = new THREE.Vector3()) {
    const end = pin[role];
    return spotNode(this.#figure(role), end.node).localToWorld(out.copy(end.local));
  }

  // ends: { node: 'wrist_R', local: THREE.Vector3 } per role.
  add(leaderEnd, followerEnd) {
    const mkBall = () => new THREE.Mesh(
      new THREE.SphereGeometry(0.014, 12, 8),
      new THREE.MeshBasicMaterial({ color: END_COLOR, transparent: true, opacity: 0.9 }),
    );
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: STRAINED_COLOR, transparent: true, opacity: 0.9 }),
    );
    const viz = { a: mkBall(), b: mkBall(), line };
    this.group.add(viz.a, viz.b, viz.line);
    this.pins.push({ leader: leaderEnd, follower: followerEnd, viz });
  }

  remove(i) {
    const pin = this.pins[i];
    if (!pin) return;
    for (const o of [pin.viz.a, pin.viz.b, pin.viz.line]) {
      o.geometry.dispose();
      o.material.dispose();
      this.group.remove(o);
    }
    this.pins.splice(i, 1);
  }

  clear() {
    while (this.pins.length) this.remove(this.pins.length - 1);
  }

  // Both dancers must be on stage for a pin to act.
  #active() {
    return this.pins.length && this.leader.group.visible && this.follower.group.visible;
  }

  // The role that adapts: the partner of whoever is being edited (embrace
  // convention; default the follower).
  #moverRole(activeFigure) {
    return activeFigure === this.follower ? 'leader' : 'follower';
  }

  // Torso/head pins — a horizontal slide of the whole adapting dancer. Runs
  // BEFORE collision + floor clamp (like the close-embrace pull) so those can
  // push back.
  maintainBody(activeFigure) {
    if (!this.#active()) return;
    const role = this.#moverRole(activeFigure);
    const mover = this.#figure(role);
    this.leader.group.updateMatrixWorld(true);
    this.follower.group.updateMatrixWorld(true);
    for (const pin of this.pins) {
      if (ARM.test(pin[role].node) || LEG.test(pin[role].node)) continue;
      this.endWorld(role, pin, _spot);
      this.endWorld(role === 'leader' ? 'follower' : 'leader', pin, _target);
      const dx = _target.x - _spot.x;
      const dz = _target.z - _spot.z;
      if (Math.hypot(dx, dz) < 1e-4) continue;
      mover.group.position.x += dx;
      mover.group.position.z += dz;
      mover.group.updateMatrixWorld(true);
    }
  }

  // Arm/leg pins — the adapting dancer's limb re-solves so its spot reaches
  // the partner's spot. Runs AFTER the embrace hands (a pin on an embrace arm
  // wins) and after the floor clamp; a leg solve re-clamps the mover itself.
  maintainLimbs(activeFigure) {
    if (!this.#active()) return;
    const role = this.#moverRole(activeFigure);
    const mover = this.#figure(role);
    this.leader.group.updateMatrixWorld(true);
    this.follower.group.updateMatrixWorld(true);
    let legMoved = false;
    for (const pin of this.pins) {
      const end = pin[role];
      const arm = end.node.match(ARM);
      const leg = arm ? null : end.node.match(LEG);
      if (!arm && !leg) continue;
      const side = (arm || leg)[1];
      const chain = arm
        ? { root: `shoulder_${side}`, mid: `elbow_${side}`, effector: `wrist_${side}`, hingeSign: -1 }
        : { root: `hip_${side}`, mid: `knee_${side}`, effector: `ankle_${side}`, hingeSign: 1 };
      this.endWorld(role === 'leader' ? 'follower' : 'leader', pin, _target);
      // The spot is READ back through the frame it was STORED in (surfaceNode);
      // the effector stays a rig node because that is what the IK actually
      // drives. Mixing the two silently costs ~10 cm on a flexed arm.
      const node = spotNode(mover, end.node);
      const eff = mover.nodes[chain.effector];
      // Aim the chain effector at target + (effector − spot): exact when the
      // spot rides the effector's own subtree, converging for spots up the
      // limb (the offset re-orients as the limb re-solves, so iterate).
      for (let i = 0; i < 3; i++) {
        node.localToWorld(_spot.copy(end.local));
        if (_spot.distanceToSquared(_target) < 1e-8) break;
        eff.getWorldPosition(_eff).add(_target).sub(_spot);
        solveTwoBone(mover, chain, _eff);
        // solveTwoBone writes RIG rotations; the atlas sub-tree the spot rides
        // does not follow until it is synced. Without this the next pass reads
        // the spot for the PREVIOUS pose and the residual correction becomes a
        // divergent feedback loop instead of a fixed point — the same trap
        // documented for the embrace's handCenter.
        mover.syncAtlasNodes();
        mover.group.updateMatrixWorld(true);
      }
      if (leg) legMoved = true;
    }
    if (legMoved) mover.clampToFloor(); // a leg pin never drags a sole underground
    if (legMoved || this.pins.length) mover.syncAtlasNodes();
  }

  // Refresh the end markers and the strain line (visible only while the two
  // ends can't close — anatomy out of reach). Called once per rendered frame.
  updateVisuals() {
    for (const pin of this.pins) {
      const a = this.endWorld('leader', pin, pin.viz.a.position);
      const b = this.endWorld('follower', pin, pin.viz.b.position);
      const gap = a.distanceTo(b);
      const strained = gap > 0.02;
      pin.viz.line.visible = strained;
      if (strained) {
        const pts = pin.viz.line.geometry.attributes.position;
        pts.setXYZ(0, a.x, a.y, a.z);
        pts.setXYZ(1, b.x, b.y, b.z);
        pts.needsUpdate = true;
        pin.viz.line.geometry.computeBoundingSphere();
      }
      const color = strained ? STRAINED_COLOR : END_COLOR;
      pin.viz.a.material.color.setHex(color);
      pin.viz.b.material.color.setHex(color);
    }
  }
}
