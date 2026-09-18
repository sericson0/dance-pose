// Unit fence for the closest-segment-pair distance that dancer collision
// bisects on (src/collision.js). Locks the geometry oracle Ericson §5.1.9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { closestSegSeg } from '../src/collision.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('parallel segments: distance is the perpendicular gap', () => {
  const c1 = V(); const c2 = V();
  const d = closestSegSeg(V(0, 0, 0), V(1, 0, 0), V(0, 0, 1), V(1, 0, 1), c1, c2);
  assert.ok(near(d, 1));
});

test('crossing-in-plan but vertically offset segments: gap is the offset', () => {
  const c1 = V(); const c2 = V();
  // X-axis segment at y=0 and Z-axis segment at y=0.5, both centred at x=z=0.
  const d = closestSegSeg(V(-1, 0, 0), V(1, 0, 0), V(0, 0.5, -1), V(0, 0.5, 1), c1, c2);
  assert.ok(near(d, 0.5));
  assert.ok(near(c1.x, 0) && near(c2.z, 0)); // closest points at the crossing
});

test('intersecting segments report zero distance', () => {
  const c1 = V(); const c2 = V();
  const d = closestSegSeg(V(-1, 0, 0), V(1, 0, 0), V(0, -1, 0), V(0, 1, 0), c1, c2);
  assert.ok(near(d, 0));
});

test('clamps to endpoints when the nearest approach is past a segment end', () => {
  const c1 = V(); const c2 = V();
  // Two colinear-in-x segments that do not overlap: [0,1] and [3,4] on x.
  const d = closestSegSeg(V(0, 0, 0), V(1, 0, 0), V(3, 0, 0), V(4, 0, 0), c1, c2);
  assert.ok(near(d, 2)); // from x=1 to x=3
  assert.ok(near(c1.x, 1) && near(c2.x, 3));
});

test('degenerate (point) segments reduce to point-to-point distance', () => {
  const c1 = V(); const c2 = V();
  const d = closestSegSeg(V(0, 0, 0), V(0, 0, 0), V(3, 4, 0), V(3, 4, 0), c1, c2);
  assert.ok(near(d, 5));
});
