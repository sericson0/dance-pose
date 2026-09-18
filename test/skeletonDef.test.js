// Unit fence for the joint-limit clamp (src/skeletonDef.js). Every posing path
// funnels rotations through clampAngle, so lock its degrees-in-limits /
// radians-in-value contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampAngle, DEG } from '../src/skeletonDef.js';

const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

test('clampAngle passes a value that is within the limits', () => {
  assert.ok(near(clampAngle(10 * DEG, [-30, 30]), 10 * DEG));
});

test('clampAngle clamps to the max (limits are in degrees, value in radians)', () => {
  assert.ok(near(clampAngle(50 * DEG, [-30, 30]), 30 * DEG));
});

test('clampAngle clamps to the min', () => {
  assert.ok(near(clampAngle(-50 * DEG, [-30, 30]), -30 * DEG));
});

test('clampAngle pins a locked (zero-width) axis to its single value', () => {
  assert.ok(near(clampAngle(1.0, [0, 0]), 0));
  assert.ok(near(clampAngle(-1.0, [45, 45]), 45 * DEG));
});
