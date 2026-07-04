import * as THREE from 'three';
import {
  MASS_SEGMENTS, FOOT_CORNERS_L, FOOT_CORNERS_R, TOE_CORNERS_L, TOE_CORNERS_R,
} from './skeletonDef.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// Whole-body center of gravity from the segment mass model (de Leva tables).
export function computeCOG(figure, target = new THREE.Vector3()) {
  target.set(0, 0, 0);
  figure.group.updateMatrixWorld(true);
  for (const seg of MASS_SEGMENTS) {
    figure.worldPos(seg.from, _a);
    figure.worldPos(seg.to, _b);
    _a.lerp(_b, seg.com);
    target.addScaledVector(_a, seg.mass);
  }
  return target;
}

// World-space sole corners of feet that are touching the floor, per foot.
export function footContactsBySide(figure, threshold = 0.035) {
  const bySide = { L: [], R: [] };
  figure.group.updateMatrixWorld(true);
  const patches = [
    ['L', 'ankle_L', FOOT_CORNERS_L], ['L', 'toes_L', TOE_CORNERS_L],
    ['R', 'ankle_R', FOOT_CORNERS_R], ['R', 'toes_R', TOE_CORNERS_R],
  ];
  for (const [side, nodeName, corners] of patches) {
    const node = figure.nodes[nodeName];
    for (const [x, y, z] of corners) {
      const p = node.localToWorld(new THREE.Vector3(
        x * figure.height, y * figure.height, z * figure.height,
      ));
      if (p.y < threshold) bySide[side].push({ x: p.x, z: p.z });
    }
  }
  return bySide;
}

export function footContactPoints(figure, threshold = 0.035) {
  const bySide = footContactsBySide(figure, threshold);
  return [...bySide.L, ...bySide.R];
}

// Convex hull in the floor plane (Andrew's monotone chain).
export function convexHull2D(pts) {
  const points = [...pts].sort((p, q) => (p.x - q.x) || (p.z - q.z));
  if (points.length <= 2) return points;
  const cross = (o, p, q) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Signed distance (m) from a floor point to the hull boundary: positive
// inside (stability margin), negative outside. Hull of <3 points → negative
// distance to the segment/point (balancing on an edge at best).
export function stabilityMargin(pt, hull) {
  if (hull.length === 0) return null;
  if (hull.length === 1) {
    return -Math.hypot(pt.x - hull[0].x, pt.z - hull[0].z);
  }
  if (hull.length === 2) {
    return -distToSegment(pt, hull[0], hull[1]);
  }
  // Orientation of the polygon (positive area = CCW in x/z).
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    area += p.x * q.z - q.x * p.z;
  }
  const sign = area > 0 ? 1 : -1;

  let inside = true;
  let minEdge = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    const cross = (q.x - p.x) * (pt.z - p.z) - (q.z - p.z) * (pt.x - p.x);
    if (sign * cross < 0) inside = false;
    minEdge = Math.min(minEdge, distToSegment(pt, p, q));
  }
  return inside ? minEdge : -minEdge;
}

function distToSegment(pt, p, q) {
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq > 0 ? ((pt.x - p.x) * dx + (pt.z - p.z) * dz) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(pt.x - (p.x + t * dx), pt.z - (p.z + t * dz));
}

function centroid2D(pts) {
  const c = { x: 0, z: 0 };
  for (const p of pts) { c.x += p.x; c.z += p.z; }
  c.x /= pts.length;
  c.z /= pts.length;
  return c;
}

// How body weight divides between the feet: the COG's floor position read as
// a lever between the two feet's contact centroids (statics of two supports).
// Also reports the support foot, whether the dancer is "on axis" (COG over
// that single foot's own contact patch), and where along the foot the load
// sits (heel / mid-foot / ball).
export function weightDistribution(figure, cog, bySide) {
  const hasL = bySide.L.length > 0;
  const hasR = bySide.R.length > 0;
  if (!hasL && !hasR) return null; // airborne
  let shareR;
  if (hasL && hasR) {
    const cL = centroid2D(bySide.L);
    const cR = centroid2D(bySide.R);
    const dx = cR.x - cL.x;
    const dz = cR.z - cL.z;
    const lenSq = dx * dx + dz * dz;
    shareR = lenSq > 1e-9
      ? Math.min(1, Math.max(0, ((cog.x - cL.x) * dx + (cog.z - cL.z) * dz) / lenSq))
      : 0.5;
  } else {
    shareR = hasR ? 1 : 0;
  }
  const support = shareR >= 0.5 ? 'R' : 'L';
  const supportPts = bySide[support];
  const onAxis = supportPts.length >= 3
    && stabilityMargin({ x: cog.x, z: cog.z }, convexHull2D(supportPts)) > 0;

  // Load position along the support foot's heel→toe axis.
  figure.worldPos(`ankle_${support}`, _a);
  figure.worldPos(`toe_${support}`, _b);
  const fx = _b.x - _a.x;
  const fz = _b.z - _a.z;
  const fLenSq = fx * fx + fz * fz;
  let footPart = null;
  if (fLenSq > 1e-9) {
    const u = ((cog.x - _a.x) * fx + (cog.z - _a.z) * fz) / fLenSq;
    footPart = u < 0.35 ? 'heel' : (u > 0.7 ? 'ball' : 'mid-foot');
  }
  return { shareL: 1 - shareR, shareR, support, onAxis, footPart };
}

// Full balance report for one figure (or a couple, via extraPoints/extraCOG).
export function balanceReport(figure) {
  const cog = computeCOG(figure);
  const bySide = footContactsBySide(figure);
  const contacts = [...bySide.L, ...bySide.R];
  const hull = convexHull2D(contacts);
  const margin = stabilityMargin({ x: cog.x, z: cog.z }, hull);
  const weight = weightDistribution(figure, cog, bySide);
  return { cog, contacts, hull, margin, weight };
}

export function coupleReport(figA, figB) {
  const ra = balanceReport(figA);
  const rb = balanceReport(figB);
  const mTotal = figA.mass + figB.mass;
  const cog = ra.cog.clone().multiplyScalar(figA.mass / mTotal)
    .addScaledVector(rb.cog, figB.mass / mTotal);
  const hull = convexHull2D([...ra.contacts, ...rb.contacts]);
  const margin = stabilityMargin({ x: cog.x, z: cog.z }, hull);
  return { a: ra, b: rb, cog, hull, margin };
}

const R2D = 180 / Math.PI;

// Key teaching angles derived from the current joint rotations.
export function keyAngles(figure) {
  const rot = (name) => figure.nodes[name].rotation;
  return [
    ['Knee bend L / R', `${(rot('knee_L').x * R2D).toFixed(0)}° / ${(rot('knee_R').x * R2D).toFixed(0)}°`],
    ['Hip flex L / R', `${(-rot('hip_L').x * R2D).toFixed(0)}° / ${(-rot('hip_R').x * R2D).toFixed(0)}°`],
    ['Elbow bend L / R', `${(-rot('elbow_L').x * R2D).toFixed(0)}° / ${(-rot('elbow_R').x * R2D).toFixed(0)}°`],
    ['Spine lean fwd', `${((rot('spine').x + rot('chest').x) * R2D).toFixed(0)}°`],
  ];
}

const wrap180 = (deg) => ((deg % 360) + 540) % 360 - 180;

// Tango-technique metrics measured in world space (they stay correct after
// closed-chain edits that tilt or translate the whole figure).
export function tangoStats(figure) {
  figure.group.updateMatrixWorld(true);
  // Yaw of the line from the right-side joint to its left twin (degrees).
  const lineYaw = (left, right) => {
    figure.worldPos(left, _a);
    figure.worldPos(right, _b);
    return Math.atan2(_a.x - _b.x, _a.z - _b.z) * R2D;
  };
  const shoulderYaw = lineYaw('shoulder_L', 'shoulder_R');
  const hipYaw = lineYaw('hip_L', 'hip_R');
  // Dissociation: shoulders twisted against the hips (+ = shoulders left).
  const dissociation = wrap180(shoulderYaw - hipYaw);

  figure.worldPos('ankle_L', _a);
  figure.worldPos('ankle_R', _b);
  const step = Math.hypot(_a.x - _b.x, _a.z - _b.z);

  // Turnout: each foot's heel→toe direction vs. the pelvis facing (+ = out).
  // Undefined ('—') when the foot points nearly straight down and its floor
  // direction is meaningless.
  const facing = hipYaw - 90;
  const footYaw = (side) => {
    figure.worldPos(`ankle_${side}`, _a);
    figure.worldPos(`toe_${side}`, _b);
    const horiz = Math.hypot(_b.x - _a.x, _b.z - _a.z);
    if (horiz < 0.05 * figure.height) return null;
    return Math.atan2(_b.x - _a.x, _b.z - _a.z) * R2D;
  };
  const yawL = footYaw('L');
  const yawR = footYaw('R');
  const outL = yawL === null ? '—' : `${wrap180(yawL - facing).toFixed(0)}°`;
  const outR = yawR === null ? '—' : `${(-wrap180(yawR - facing)).toFixed(0)}°`;

  return [
    ['Dissociation', `${dissociation.toFixed(0)}°`],
    ['Step length', `${(step * 100).toFixed(0)} cm (${((step / figure.height) * 100).toFixed(0)}% H)`],
    ['Turnout L / R', `${outL} / ${outR}`],
  ];
}
