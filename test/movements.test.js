// Unit fence for the presentation data: the MOVEMENTS clip table and the bone
// naming used by labels. The table is only data, but every way it can be wrong
// is SILENT at runtime — a target past a joint limit is clamped (the clip just
// stops short of the range its title advertises), a misspelt muscle is skipped
// (no callout, no error) — so the integrity is pinned here. Direction (does
// "pronation" actually pronate?) needs the posed figure and lives in
// scripts/dev-verify-studio.mjs. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOVEMENTS, MOVEMENT_BY_ID, NEUTRAL, PLANES, FRAMES } from '../src/movements.js';
import { JOINT_BY_NAME } from '../src/skeletonDef.js';
import { classifyMuscle, LIMB_BASES } from '../src/skeletonMesh.js';
import { boneLabel } from '../src/labels.js';

// Rows are authored for the left side; a bare limb base resolves to `_L`.
const leftName = (joint) => (JOINT_BY_NAME[joint] ? joint : `${joint}_L`);

test('movement ids are unique and every pair points back', () => {
  assert.equal(new Set(MOVEMENTS.map((m) => m.id)).size, MOVEMENTS.length);
  for (const m of MOVEMENTS) {
    if (!m.pair) continue;
    assert.ok(MOVEMENT_BY_ID[m.pair], `${m.id}: pair "${m.pair}" does not exist`);
    assert.equal(MOVEMENT_BY_ID[m.pair].pair, m.id, `${m.id} ↔ ${m.pair} is not mutual`);
  }
});

test('every movement names a real plane and camera frame', () => {
  for (const m of MOVEMENTS) {
    assert.ok(PLANES[m.plane], `${m.id}: unknown plane "${m.plane}"`);
    assert.ok(FRAMES[m.frame], `${m.id}: unknown frame "${m.frame}"`);
  }
});

test('every driven / base / marker joint exists', () => {
  for (const m of MOVEMENTS) {
    const names = [
      ...m.drive.map((d) => d.joint),
      ...Object.keys(m.base ?? {}),
      ...(Array.isArray(m.marker) ? m.marker : m.marker ? [m.marker.node] : []),
      ...(m.center ? [m.center] : []),
    ];
    for (const n of names) assert.ok(JOINT_BY_NAME[leftName(n)], `${m.id}: no joint "${n}"`);
    // A LIMB marker must use seated joints, not the hand/toe endpoints: those
    // have no seat on the visible skeleton, so pairing one with a seated joint
    // mixes two frames (measured: toe extension read 26° for a 70° drive). The
    // axial headTop is fine — rig and surface coincide along the spine.
    if (Array.isArray(m.marker)) {
      for (const n of m.marker) {
        const def = JOINT_BY_NAME[leftName(n)];
        assert.ok(!(def.endpoint && /_[LR]$/.test(def.name)), `${m.id}: marker uses limb endpoint "${n}"`);
      }
    }
  }
});

test('every target and test position is inside the joint limits (nothing gets clamped)', () => {
  const within = (joint, axis, deg, what) => {
    const def = JOINT_BY_NAME[leftName(joint)];
    const [lo, hi] = def.limits[axis];
    assert.ok(deg >= lo && deg <= hi, `${what}: ${joint}.${axis} = ${deg}° is outside [${lo}, ${hi}]`);
  };
  for (const m of MOVEMENTS) {
    for (const d of m.drive) within(d.joint, d.axis, d.to, m.id);
    for (const [joint, axes] of Object.entries(m.base ?? {})) {
      for (const [axis, deg] of Object.entries(axes)) within(joint, axis, deg, `${m.id} base`);
    }
  }
  for (const [joint, axes] of Object.entries(NEUTRAL)) {
    for (const [axis, deg] of Object.entries(axes)) {
      const [lo, hi] = JOINT_BY_NAME[joint].limits[axis];
      assert.ok(deg >= lo && deg <= hi, `NEUTRAL ${joint}.${axis}`);
    }
  }
});

test('a coupled row SPLITS the range it advertises and never exceeds it', () => {
  // Joints coupled in one plane ADD (scapulohumeral rhythm: the scapula
  // carries the arm), so a row driving several of them has to say what the
  // total is — `complex` — or the two halves drift apart silently. Driving the
  // scapula on top of a 170° shoulder instead of splitting it swings the arm
  // 190°, past the vertical and down the far side, and every per-joint limit
  // still passes. The total is bounded by the PRIMARY joint's own limits
  // because that is where this rig keeps complex ROM rather than
  // glenohumeral-only ROM (docs/rom-research.md).
  for (const m of MOVEMENTS) {
    if (m.complex === undefined) continue;
    const { joint, axis } = m.drive[0];
    const sum = m.drive.filter((d) => d.axis === axis).reduce((t, d) => t + d.to, 0);
    assert.equal(sum, m.complex, `${m.id}: ${axis} drives sum to ${sum}°, advertised ${m.complex}°`);
    const [lo, hi] = JOINT_BY_NAME[leftName(joint)].limits[axis];
    assert.ok(m.complex >= lo && m.complex <= hi,
      `${m.id}: complex ${m.complex}° is outside ${joint}.${axis} limits [${lo}, ${hi}]`);
  }
});

test('a full sweep never drives the same joint axis from two different bases', () => {
  // Both halves share one base-angle table, so a pair may only be swept when
  // their test positions agree — buildTimeline checks this; here we make sure
  // at least the flagship pairs qualify, so "Full sweep" is not an empty promise.
  for (const id of ['sh_flex', 'hp_flex', 'an_df', 'fa_pro', 'wr_flex', 'sc_elev']) {
    const m = MOVEMENT_BY_ID[id];
    const p = MOVEMENT_BY_ID[m.pair];
    assert.equal(JSON.stringify(m.base ?? null), JSON.stringify(p.base ?? null), `${id} / ${m.pair} cannot sweep`);
  }
});

test('every prime mover is a muscle the atlas actually ships', () => {
  const shipped = (label) => classifyMuscle(`${label}.r`) || classifyMuscle(`${label} muscle.r`);
  for (const m of MOVEMENTS) {
    for (const g of m.movers ?? []) {
      const bellies = Array.isArray(g) ? g.slice(1) : [g];
      assert.ok(bellies.length, `${m.id}: a mover group with no bellies`);
      for (const b of bellies) assert.ok(shipped(b), `${m.id}: "${b}" is not a shipped muscle`);
    }
  }
});

test('limb bases used by the table are the rig\'s limb bases', () => {
  for (const m of MOVEMENTS) {
    for (const d of m.drive) {
      if (!JOINT_BY_NAME[d.joint]) assert.ok(LIMB_BASES.has(d.joint), `${m.id}: "${d.joint}" is not a limb base`);
    }
  }
});

test('boneLabel: paired bones lose the merged side letter, axial bones keep their r', () => {
  assert.equal(boneLabel('Femurr', true), 'Femur');
  assert.equal(boneLabel('Ulnar', true), 'Ulna');
  assert.equal(boneLabel('Vomer', false), 'Vomer');
  assert.equal(boneLabel('Hip_boner', true), 'Hip bone');
});

test('boneLabel: atlas spellings become textbook names', () => {
  assert.equal(boneLabel('Rib_(10th)r', true), '10th rib');
  assert.equal(boneLabel('Thoracic_vertebrae_(T4)', false), 'T4 vertebra');
  assert.equal(boneLabel('Atlas_(C1)', false), 'Atlas (C1)');
  assert.equal(boneLabel('Costal_cart_of_7th_ribr', true), '7th costal cartilage');
  assert.equal(boneLabel('Distal_phalanx_of_2d_fingerr', true), 'Distal phalanx of 2nd finger');
  assert.equal(boneLabel('Proximal_phalanx_of_first_finger_of_footr', true), 'Proximal phalanx of first toe');
  assert.equal(boneLabel('Mandible_bone', false), 'Mandible');
  assert.equal(boneLabel('Ethmoid_Bone', false), 'Ethmoid');
});
