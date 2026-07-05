import * as THREE from 'three';
import { COLLIDERS } from './skeletonDef.js';

// Dancer-vs-dancer body collision: the two dancers may touch — the whole
// point of the embrace — but never occupy each other's space. Each dancer is
// a set of capsules around the body core (COLLIDERS in skeletonDef.js; arms
// and hands are deliberately not colliders, the embrace rests them ON the
// partner). Every frame the deepest capsule-pair penetration is resolved by
// sliding one dancer horizontally along the contact normal until the two
// surfaces just touch — so walking into your partner displaces them, exactly
// like a real floor, and contact is preserved at zero distance rather than
// pushed apart. Whichever dancer the user is editing keeps their ground; the
// partner yields (same convention as the embrace constraints).

// Penetration deeper than this gets resolved; shallower counts as contact.
const TOL = 0.002;
// Resolve to just past touching so float noise doesn't re-trigger next frame.
const SLACK = 0.0005;

const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();

// Closest points between segments p1→q1 and p2→q2 (Ericson, Real-Time
// Collision Detection §5.1.9), written into c1/c2; returns the distance.
function closestSegSeg(p1, q1, p2, q2, c1, c2) {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);
  const a = _d1.dot(_d1);
  const e = _d2.dot(_d2);
  const f = _d2.dot(_r);
  const EPS = 1e-10;
  let s, t;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = _d1.dot(_r);
    if (e <= EPS) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      s = denom > EPS ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }
  c1.copy(p1).addScaledVector(_d1, s);
  c2.copy(p2).addScaledVector(_d2, t);
  return c1.distanceTo(c2);
}

// World-space capsules for a figure's current pose.
function capsules(figure) {
  const H = figure.height;
  return COLLIDERS.map(({ from, to, r }) => ({
    p: figure.worldPos(from),
    q: figure.worldPos(to),
    r: r * H,
  }));
}

// Smallest surface-to-surface clearance between the two dancers' capsule
// sets: positive = air between them, 0 = touching, negative = penetration
// depth. Used by the dev verification script.
export function bodyClearance(a, b) {
  return bodyContacts(a, b)[0]?.clearance ?? Infinity;
}

// All capsule pairs sorted tightest-first: [{ a, b, clearance }] with the
// COLLIDERS row names — for the dev verification scripts and radius tuning.
export function bodyContacts(a, b) {
  a.group.updateMatrixWorld(true);
  b.group.updateMatrixWorld(true);
  const capsA = capsules(a);
  const capsB = capsules(b);
  const out = [];
  for (let i = 0; i < capsA.length; i++) {
    for (let j = 0; j < capsB.length; j++) {
      const dist = closestSegSeg(capsA[i].p, capsA[i].q, capsB[j].p, capsB[j].q, _c1, _c2);
      out.push({
        a: `${COLLIDERS[i].from}→${COLLIDERS[i].to}`,
        b: `${COLLIDERS[j].from}→${COLLIDERS[j].to}`,
        clearance: dist - (capsA[i].r + capsB[j].r),
      });
    }
  }
  return out.sort((x, y) => x.clearance - y.clearance);
}

// Deepest penetration between the two capsule sets (pen ≤ 0 means clear),
// with the contact points of the deepest pair.
function maxPenetration(a, b) {
  const capsA = capsules(a);
  const capsB = capsules(b);
  const worst = { pen: -Infinity, onA: new THREE.Vector3(), onB: new THREE.Vector3() };
  for (const ca of capsA) {
    for (const cb of capsB) {
      const dist = closestSegSeg(ca.p, ca.q, cb.p, cb.q, _c1, _c2);
      const pen = ca.r + cb.r - dist;
      if (pen > worst.pen) {
        worst.pen = pen;
        worst.onA.copy(_c1);
        worst.onB.copy(_c2);
      }
    }
  }
  return worst;
}

// Resolve body penetration between the two dancers by translating `mover`
// (the partner of the actively edited dancer; default: the follower yields,
// matching Embrace.maintainTorso). Horizontal only — dancers stand on the
// floor, a vertical shove would lift them off it. The slide direction comes
// from the deepest contact's normal; the slide LENGTH is found by bracketing
// and bisecting the whole capsule-set clearance, because interleaved limbs
// (crossed shins in a colgada, a foot between the partner's feet) make the
// clearance along a slide non-monotone — a fixed-step push can oscillate
// across a segment crossing and never settle. The bisection lands the two
// surfaces just touching, to half a millimeter.
export function resolveBodyCollision(a, b, activeFigure) {
  if (!a.group.visible || !b.group.visible) return;
  const mover = activeFigure === b ? a : b;
  const other = mover === a ? b : a;
  mover.group.updateMatrixWorld(true);
  other.group.updateMatrixWorld(true);
  const worst = maxPenetration(mover, other);
  if (worst.pen <= TOL) return;

  // Horizontal part of the deepest contact's normal; a near-vertical contact
  // (one body part directly above the other) falls back to the chest-to-chest
  // direction, and exactly coaxial dancers to world +Z.
  const dir = worst.onA.clone().sub(worst.onB);
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) {
    dir.copy(mover.worldPos('chest')).sub(other.worldPos('chest'));
    dir.y = 0;
  }
  if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
  dir.normalize();

  const base = mover.group.position.clone();
  const penAt = (t) => {
    mover.group.position.copy(base).addScaledVector(dir, t);
    mover.group.updateMatrixWorld(true);
    return maxPenetration(mover, other).pen;
  };
  // Bracket: grow the slide until everything clears (a horizontal slide far
  // enough along any direction separates two bounded bodies).
  let hi = worst.pen + SLACK;
  let bracketed = false;
  for (let i = 0; i < 10; i++) {
    if (penAt(hi) <= 0) { bracketed = true; break; }
    hi *= 2;
  }
  if (!bracketed) {
    // Cannot separate along this direction (should not happen) — stay put
    // rather than catapult the dancer.
    mover.group.position.copy(base);
    mover.group.updateMatrixWorld(true);
    return;
  }
  // Bisect down to the touching point.
  let lo = 0;
  for (let i = 0; i < 24 && hi - lo > 0.0005; i++) {
    const mid = (lo + hi) / 2;
    if (penAt(mid) > 0) lo = mid;
    else hi = mid;
  }
  mover.group.position.copy(base).addScaledVector(dir, hi + SLACK);
  mover.group.updateMatrixWorld(true);
}
