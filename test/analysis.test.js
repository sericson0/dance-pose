// Unit fence for the pure balance geometry in src/analysis.js. These lock the
// statics the whole balance/weight readout is built on, so a refactor (or the
// embrace rework) can't silently move them. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { convexHull2D, stabilityMargin, weightDistribution } from '../src/analysis.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const hasPoint = (hull, x, z) => hull.some((p) => near(p.x, x) && near(p.z, z));

test('convexHull2D drops an interior point and keeps the 4 corners', () => {
  const hull = convexHull2D([
    { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 },
    { x: 0.5, z: 0.5 }, // interior — must be excluded
  ]);
  assert.equal(hull.length, 4);
  for (const [x, z] of [[0, 0], [1, 0], [1, 1], [0, 1]]) assert.ok(hasPoint(hull, x, z));
  assert.ok(!hasPoint(hull, 0.5, 0.5));
});

test('convexHull2D collapses collinear points to the 2 endpoints', () => {
  const hull = convexHull2D([
    { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 },
  ]);
  assert.equal(hull.length, 2);
});

test('convexHull2D returns <=2 inputs unchanged', () => {
  assert.equal(convexHull2D([{ x: 0, z: 0 }]).length, 1);
  assert.equal(convexHull2D([]).length, 0);
});

const SQUARE = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }];

test('stabilityMargin is positive inside, = distance to the nearest edge', () => {
  assert.ok(near(stabilityMargin({ x: 0.5, z: 0.5 }, SQUARE), 0.5));
  assert.ok(near(stabilityMargin({ x: 0.9, z: 0.5 }, SQUARE), 0.1));
});

test('stabilityMargin is negative outside the hull', () => {
  assert.ok(near(stabilityMargin({ x: 1.5, z: 0.5 }, SQUARE), -0.5));
  assert.ok(stabilityMargin({ x: 2, z: 2 }, SQUARE) < 0);
});

test('stabilityMargin degenerates gracefully on a point / edge hull', () => {
  assert.equal(stabilityMargin({ x: 0, z: 0 }, []), null);
  assert.ok(near(stabilityMargin({ x: 3, z: 4 }, [{ x: 0, z: 0 }]), -5)); // -hypot(3,4)
  assert.ok(near(stabilityMargin({ x: 0.5, z: 1 }, [{ x: 0, z: 0 }, { x: 1, z: 0 }]), -1));
});

// A minimal stand-in for a Figure: weightDistribution only reads worldPos for
// the support foot's ankle/toe. Positions are a plain lookup written into the
// THREE.Vector3 the function passes in.
function fakeFigure(positions) {
  return {
    worldPos(name, out) {
      const p = positions[name] ?? { x: 0, y: 0, z: 0 };
      return out.set(p.x, p.y, p.z);
    },
  };
}

test('weightDistribution splits 50/50 when the COG sits between both feet', () => {
  const fig = fakeFigure({
    ankle_R: { x: 0.1, y: 0, z: 0 }, toe_R: { x: 0.1, y: 0, z: 0.2 },
  });
  const w = weightDistribution(
    fig,
    new THREE.Vector3(0, 0, 0),
    { L: [{ x: -0.1, z: 0 }], R: [{ x: 0.1, z: 0 }] },
  );
  assert.ok(near(w.shareR, 0.5));
  assert.ok(near(w.shareL, 0.5));
});

test('weightDistribution reports a single support foot, on-axis, mid-foot load', () => {
  const patch = [
    { x: 0.05, z: -0.05 }, { x: 0.15, z: -0.05 },
    { x: 0.15, z: 0.05 }, { x: 0.05, z: 0.05 },
  ];
  const fig = fakeFigure({
    ankle_R: { x: 0.1, y: 0, z: -0.05 }, toe_R: { x: 0.1, y: 0, z: 0.15 },
  });
  const w = weightDistribution(fig, new THREE.Vector3(0.1, 0, 0.03), { L: [], R: patch });
  assert.equal(w.support, 'R');
  assert.equal(w.shareR, 1);
  assert.equal(w.onAxis, true);
  assert.equal(w.footPart, 'mid-foot');
});

test('weightDistribution returns null when both feet are airborne', () => {
  assert.equal(weightDistribution(fakeFigure({}), new THREE.Vector3(), { L: [], R: [] }), null);
});
