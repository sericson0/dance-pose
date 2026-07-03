import * as THREE from 'three';
import { MASS_SEGMENTS, FOOT_CORNERS_L, FOOT_CORNERS_R } from './skeletonDef.js';

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

// World-space sole corners of feet that are touching the floor.
export function footContactPoints(figure, threshold = 0.035) {
  const points = [];
  figure.group.updateMatrixWorld(true);
  const feet = [
    ['ankle_L', FOOT_CORNERS_L],
    ['ankle_R', FOOT_CORNERS_R],
  ];
  for (const [ankleName, corners] of feet) {
    const node = figure.nodes[ankleName];
    for (const [x, y, z] of corners) {
      const p = node.localToWorld(new THREE.Vector3(
        x * figure.height, y * figure.height, z * figure.height,
      ));
      if (p.y < threshold) points.push({ x: p.x, z: p.z });
    }
  }
  return points;
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

// Full balance report for one figure (or a couple, via extraPoints/extraCOG).
export function balanceReport(figure) {
  const cog = computeCOG(figure);
  const contacts = footContactPoints(figure);
  const hull = convexHull2D(contacts);
  const margin = stabilityMargin({ x: cog.x, z: cog.z }, hull);
  return { cog, contacts, hull, margin };
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
    ['Spine twist', `${((rot('spine').y + rot('chest').y) * R2D).toFixed(0)}°`],
  ];
}
