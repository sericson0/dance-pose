// Dev check for the turn controls: whole-figure rotation in Move mode about a
// chosen vertical axis (support foot / centre of gravity / body centre), and
// the hips twist that turns the pelvis under a still chest (tango
// dissociation). Both are checked through the app API *and* through a real
// pointer drag on the gizmo ring, plus the topbar wiring.
//
// The COG is read from the balance viz's own ball, which the render loop
// recomputes from analysis.js every frame — an independent measurement, not the
// same call the pivot code makes. Honours DEV_URL.
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const mm = (v) => `${(v * 1000).toFixed(1)} mm`;
const deg = (v) => `${v.toFixed(2)}°`;

// Everything the turn checks need, measured in one page pass. Yaws are read
// off the nodes' WORLD quaternions (the local rotations are what the code
// writes, so reading those back would only restate the arithmetic).
async function probe() {
  await sleep(120); // let a frame land so the COG viz is current
  return page.evaluate(() => {
    const app = window.__app;
    // Read everything straight off matrixWorld (column-major): no THREE
    // constructors needed in page scope, and it is the rendered transform.
    // Column 2 is the node's local +Z in world space, so yaw = atan2(x, z).
    const yawOf = (obj) => {
      const e = obj.matrixWorld.elements;
      return Math.atan2(e[8], e[10]) * 180 / Math.PI;
    };
    const posOf = (obj) => {
      const e = obj.matrixWorld.elements;
      return { x: e[12], y: e[13], z: e[14] };
    };
    // The node's three world axes, unit length — an orientation we can compare
    // without quaternion sign ambiguity.
    const basisOf = (obj) => {
      const e = obj.matrixWorld.elements;
      return [0, 1, 2].map((c) => {
        const [x, y, z] = [e[c * 4], e[c * 4 + 1], e[c * 4 + 2]];
        const n = Math.hypot(x, y, z) || 1;
        return [x / n, y / n, z / n];
      });
    };
    const v = (p) => ({ x: p.x, y: p.y, z: p.z });
    const out = {};
    for (const [key, fig] of [['leader', app.leader], ['follower', app.follower]]) {
      fig.group.updateMatrixWorld(true);
      out[key] = {
        rootYaw: fig.group.rotation.y * 180 / Math.PI,
        rootPos: v(fig.group.position),
        pelvisYaw: yawOf(fig.nodes.pelvis),
        chestYaw: yawOf(fig.nodes.chest),
        pelvisLocalYaw: fig.nodes.pelvis.rotation.y * 180 / Math.PI,
        support: app.supportAnkle(fig),
        ball: v(app.ballOfFoot(fig, app.supportAnkle(fig))),
        ballL: v(app.ballOfFoot(fig, 'ankle_L')),
        ballR: v(app.ballOfFoot(fig, 'ankle_R')),
        low: fig.lowestPointY(),
        ankleL: posOf(fig.nodes.ankle_L),
        ankleR: posOf(fig.nodes.ankle_R),
        soleL: basisOf(fig.nodes.ankle_L),
        soleR: basisOf(fig.nodes.ankle_R),
      };
    }
    out.cogLeader = v(app.cogViz.leader.cogBall.position);
    out.cogCouple = v(app.cogViz.couple.cogBall.position);
    out.movePivot = app.movePivot;
    out.hipsTool = app.hipsTool;
    out.mode = app.mode;
    return out;
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dYaw = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
// Which way a foot points on the floor: the yaw of its node's world +Z axis.
const soleYaw = (basis) => Math.atan2(basis[2][0], basis[2][2]) * 180 / Math.PI;

const report = {};

// ---- 1. Turn about the ball of the support foot (the default, unchanged).
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.linkCouple = false;
  app.setMovePivot('foot');
});
let before = await probe();
await page.evaluate(() => window.__app.turnFigure(window.__app.leader, 40 * Math.PI / 180));
let after = await probe();
report.footPivot = {
  ballDrift: dist(before.leader.ball, after.leader.ball),
  yaw: dYaw(after.leader.rootYaw, before.leader.rootYaw),
};
check(report.footPivot.ballDrift < 0.001,
  `foot pivot: the ball of the support foot moved ${mm(report.footPivot.ballDrift)} (want < 1 mm)`);
check(Math.abs(report.footPivot.yaw - 40) < 0.1,
  `foot pivot: turned ${deg(report.footPivot.yaw)}, wanted 40°`);

// ---- 2. Turn about the centre of gravity.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.linkCouple = false;
  app.setMovePivot('cog');
});
before = await probe();
await page.evaluate(() => window.__app.turnFigure(window.__app.leader, 50 * Math.PI / 180));
after = await probe();
report.cogPivot = {
  cogDrift: dist(before.cogLeader, after.cogLeader),
  ballMoved: dist(before.leader.ball, after.leader.ball),
  yaw: dYaw(after.leader.rootYaw, before.leader.rootYaw),
};
check(report.cogPivot.cogDrift < 0.003,
  `COG pivot: the COG moved ${mm(report.cogPivot.cogDrift)} (want < 3 mm)`);
check(Math.abs(report.cogPivot.yaw - 50) < 0.1,
  `COG pivot: turned ${deg(report.cogPivot.yaw)}, wanted 50°`);
// The pivot setting must actually change the axis — if the foot also stayed
// put, the turn is still a foot pivot and the COG check proves nothing.
check(report.cogPivot.ballMoved > 0.01,
  `COG pivot: the support foot stayed put too (${mm(report.cogPivot.ballMoved)}) — the pivot setting had no effect`);

// ---- 3. Linked couple turning about their SHARED COG, as one rigid unit.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.setEmbrace({ hands: true, close: true });
  app.linkCouple = true;
  app.setMovePivot('cog');
});
await sleep(400); // the embrace settles over a few frames
before = await probe();
await page.evaluate(() => window.__app.turnFigure(window.__app.leader, 60 * Math.PI / 180));
after = await probe();
report.couplePivot = {
  coupleCogDrift: dist(before.cogCouple, after.cogCouple),
  leaderYaw: dYaw(after.leader.rootYaw, before.leader.rootYaw),
  followerYaw: dYaw(after.follower.rootYaw, before.follower.rootYaw),
  spacingBefore: dist(before.leader.rootPos, before.follower.rootPos),
  spacingAfter: dist(after.leader.rootPos, after.follower.rootPos),
};
const spacingChange = Math.abs(report.couplePivot.spacingAfter - report.couplePivot.spacingBefore);
report.couplePivot.spacingChange = spacingChange;
check(report.couplePivot.coupleCogDrift < 0.005,
  `couple COG pivot: the shared COG moved ${mm(report.couplePivot.coupleCogDrift)} (want < 5 mm)`);
check(Math.abs(report.couplePivot.leaderYaw - 60) < 0.5 && Math.abs(report.couplePivot.followerYaw - 60) < 0.5,
  `couple COG pivot: yaws ${deg(report.couplePivot.leaderYaw)} / ${deg(report.couplePivot.followerYaw)}, wanted 60° each`);
check(spacingChange < 0.003,
  `couple COG pivot: the pair's spacing changed by ${mm(spacingChange)} — they did not turn as one unit`);

// ---- 4. Hips twist: the pelvis turns and the legs and feet go round WITH it
//         as one unit, while the spine twists so the chest holds its facing.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.setEmbrace({ hands: false, close: false });
  app.linkCouple = false;
});
await sleep(300);
before = await probe();
const applied = await page.evaluate(() => window.__app.pivotHips(window.__app.leader, 25 * Math.PI / 180) * 180 / Math.PI);
after = await probe();
report.hipsTwist = {
  requested: 25,
  applied,
  pelvisTurned: dYaw(after.leader.pelvisYaw, before.leader.pelvisYaw),
  chestDrift: dYaw(after.leader.chestYaw, before.leader.chestYaw),
  footTurnedL: dYaw(soleYaw(after.leader.soleL), soleYaw(before.leader.soleL)),
  footTurnedR: dYaw(soleYaw(after.leader.soleR), soleYaw(before.leader.soleR)),
  lowBefore: before.leader.low,
  lowAfter: after.leader.low,
};
const t = report.hipsTwist;
check(Math.abs(t.applied - 25) < 0.5, `hips twist: applied ${deg(t.applied)} of the 25° asked`);
check(Math.abs(t.pelvisTurned - 25) < 1.5, `hips twist: the pelvis turned ${deg(t.pelvisTurned)}, wanted ~25°`);
check(Math.abs(t.chestDrift) < 2,
  `hips twist: the chest turned ${deg(t.chestDrift)} — the spine is supposed to twist so it holds its facing (< 2°)`);
// The legs are part of the unit that turns: a foot left behind would mean the
// rotation was applied above the hips instead of at the pelvis.
check(Math.abs(t.footTurnedL - t.pelvisTurned) < 1.5 && Math.abs(t.footTurnedR - t.pelvisTurned) < 1.5,
  `hips twist: the feet turned ${deg(t.footTurnedL)} / ${deg(t.footTurnedR)} but the pelvis turned ${deg(t.pelvisTurned)} — the legs should go round with the hips as one unit`);
check(Math.abs(t.lowAfter - t.lowBefore) < 0.004,
  `hips twist: the dancer left the floor (lowest point ${mm(t.lowBefore)} → ${mm(t.lowAfter)})`);

// ---- 5. Past the trunk's twist range the yaw is CLAMPED, not saturated:
//         asking for 90° must spend the chest+spine budget and stop, with the
//         chest still holding its facing.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
});
await sleep(300);
before = await probe();
const bigApplied = await page.evaluate(() => window.__app.pivotHips(window.__app.leader, 90 * Math.PI / 180) * 180 / Math.PI);
after = await probe();
report.hipsClamp = {
  requested: 90,
  applied: bigApplied,
  chestDrift: dYaw(after.leader.chestYaw, before.leader.chestYaw),
};
// chest ±35° + lumbar spine ±8° = 43° of counter-twist from neutral.
check(bigApplied > 20 && bigApplied < 46,
  `hips twist clamp: applied ${deg(bigApplied)} of 90° — expected the trunk's ~43° budget`);
check(Math.abs(report.hipsClamp.chestDrift) < 2.5,
  `hips twist clamp: the chest turned ${deg(report.hipsClamp.chestDrift)} once clamped — it should still hold`);

// ---- 6. Topbar wiring: the sub-toolbars appear with their mode and drive app state.
// Move mode no longer has a Slide/Turn toggle — the gizmo slides and turns in
// one — so only the pivot picker shows there; the Move-hips Slide/Twist toggle
// stays.
const ui = await page.evaluate(() => {
  const app = window.__app;
  const vis = (id) => !document.getElementById(id).hidden;
  const click = (sel) => document.querySelector(sel).click();
  click('#mode-buttons button[data-mode="move"]');
  const inMove = { pivotBox: vis('move-pivot-box'), hipsTools: vis('hips-tools') };
  const sel = document.getElementById('move-pivot');
  sel.value = 'cog';
  sel.dispatchEvent(new Event('change'));
  const movePivot = app.movePivot;
  click('#mode-buttons button[data-mode="hips"]');
  click('#hips-tools button[data-hips-tool="slide"]');
  const inHips = { hipsTools: vis('hips-tools'), plant: vis('hips-plant') };
  click('#hips-tools button[data-hips-tool="twist"]');
  return {
    inMove, movePivot, inHips,
    hipsTool: app.hipsTool, mode: app.mode, plantInTwist: vis('hips-plant'),
  };
});
report.ui = ui;
check(ui.inMove.pivotBox && !ui.inMove.hipsTools,
  `topbar: Move mode should show the pivot picker only (${JSON.stringify(ui.inMove)})`);
check(ui.movePivot === 'cog', `topbar: the pivot dropdown left movePivot = ${ui.movePivot}`);
check(ui.inHips.hipsTools && ui.inHips.plant,
  `topbar: Move-hips should show Slide/Twist + Planted only (${JSON.stringify(ui.inHips)})`);
check(ui.hipsTool === 'twist', `topbar: the Twist button left hipsTool = ${ui.hipsTool}`);
// Planted feet are a Slide-only choice: the twist turns the legs on purpose.
check(!ui.plantInTwist, 'topbar: the Planted checkboxes are still showing in Twist, where they do nothing');

// ---- 7. Real pointer drags on the gizmo rings.
// The rotate ring's on-screen radius depends on the camera distance, so find it
// by sweeping (with orbit disabled a miss does nothing at all). Take the
// STRONGEST radius, not the first that twitches: a graze at the ring's edge
// turns the object a fraction of a degree, and accepting that would let the
// check pass on a drag that barely happened.
async function gizmoCentre() {
  return page.evaluate(() => {
    const app = window.__app;
    app.orbit.enabled = false;
    const v = window.__gizmoObject.getWorldPosition(app.leader.group.position.clone());
    v.project(app.camera);
    return [(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight];
  });
}

// One drag starting at (x, y), HORIZONTAL on screen. TransformControls turns a
// single-axis ring by `drag · (axis × eye)`, and for the vertical Y axis that
// sensitive direction is screen-horizontal — dragging vertically (the ring's
// apparent tangent at its rightmost point) is nearly orthogonal to it and
// barely moves the object at all.
async function dragAt(x, y, len = 120) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let s = 1; s <= 9; s++) await page.mouse.move(x + s * (len / 9), y);
  await page.mouse.up();
  await sleep(70);
}

async function dragRing(readAngle, reset) {
  const profile = [];
  for (let r = 20; r <= 230; r += 6) {
    await reset();
    const c = await gizmoCentre();
    const a0 = await readAngle();
    await dragAt(c[0] + r, c[1]);
    profile.push({ r, turned: dYaw(await readAngle(), a0) });
  }
  const best = profile.reduce((m, p) => (Math.abs(p.turned) > Math.abs(m.turned) ? p : m), { r: 0, turned: 0 });
  if (Math.abs(best.turned) < 2) return { found: false, profile };
  // One clean drag at the strongest radius, from a fresh pose — that is the
  // one the assertions below measure.
  await reset();
  const c = await gizmoCentre();
  const pre = await probe();
  await dragAt(c[0] + best.r, c[1]);
  const post = await probe();
  return { found: true, radius: best.r, turned: dYaw(await readAngle(), 0), pre, post };
}

// 7a. Move-mode turn ring, pivoting on the support foot.
const resetMove = () => page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.setEmbrace({ hands: false, close: false });
  app.linkCouple = false;
  app.setMovePivot('foot');
  app.setMode('move');
  app.selectFigure(app.leader); // attaches the slide arrows + the yaw ring
  window.__gizmoObject = app.leader.group;
});
const moveDrag = await dragRing(
  () => page.evaluate(() => window.__app.leader.group.rotation.y * 180 / Math.PI),
  resetMove,
);
if (!moveDrag.found) {
  report.moveRingDrag = null;
  problems.push('move turn ring: no drag radius turned the figure — the rotate gizmo was never engaged (UNTESTED, not a pass)');
} else {
  // Measure the drift of the foot that WAS the support at drag start — which is
  // the one the pivot was captured on. `supportAnkle` picks the lower ankle, so
  // on a two-footed stance it can flip between samples on floating-point noise,
  // and comparing "the support ball" before against after would then compare
  // two different feet and read the gap between them as drift.
  const supportBall = (p) => (moveDrag.pre.leader.support === 'ankle_L' ? p.leader.ballL : p.leader.ballR);
  report.moveRingDrag = {
    radius: moveDrag.radius,
    turned: dYaw(moveDrag.post.leader.rootYaw, moveDrag.pre.leader.rootYaw),
    ballDrift: dist(supportBall(moveDrag.pre), supportBall(moveDrag.post)),
    supportBefore: moveDrag.pre.leader.support,
    supportAfter: moveDrag.post.leader.support,
    naiveBallDrift: dist(moveDrag.pre.leader.ball, moveDrag.post.leader.ball),
  };
  check(Math.abs(report.moveRingDrag.turned) > 5,
    `move turn ring: the drag only turned the figure ${deg(report.moveRingDrag.turned)} — too small to test the pivot`);
  check(report.moveRingDrag.ballDrift < 0.002,
    `move turn ring: dragging the ring moved the support foot ${mm(report.moveRingDrag.ballDrift)} (want < 2 mm — the pivot must hold under a real drag)`);
}

// 7b. Hips twist ring: the chest holds while the pelvis turns under it.
const resetHips = () => page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.orbit.enabled = false;
  app.setMode('hips');
  app.setHipsTool('twist');
  app.selectFigure(app.leader);
  window.__gizmoObject = app.leader.nodes.pelvis;
});
const hipsDrag = await dragRing(
  () => page.evaluate(() => window.__app.leader.nodes.pelvis.rotation.y * 180 / Math.PI),
  resetHips,
);
if (!hipsDrag.found) {
  report.hipsRingDrag = null;
  problems.push('hips twist ring: no drag radius turned the pelvis — the rotate gizmo was never engaged (UNTESTED, not a pass)');
} else {
  report.hipsRingDrag = {
    radius: hipsDrag.radius,
    pelvisTurned: dYaw(hipsDrag.post.leader.pelvisYaw, hipsDrag.pre.leader.pelvisYaw),
    chestDrift: dYaw(hipsDrag.post.leader.chestYaw, hipsDrag.pre.leader.chestYaw),
    footTurnedL: dYaw(soleYaw(hipsDrag.post.leader.soleL), soleYaw(hipsDrag.pre.leader.soleL)),
  };
  const h = report.hipsRingDrag;
  check(Math.abs(h.pelvisTurned) > 5,
    `hips twist ring: the pelvis only turned ${deg(h.pelvisTurned)} — too small to test the dissociation`);
  check(Math.abs(h.chestDrift) < 2.5,
    `hips twist ring: the chest turned ${deg(h.chestDrift)} under a real drag (want < 2.5°)`);
  check(Math.abs(h.footTurnedL - h.pelvisTurned) < 2,
    `hips twist ring: the foot turned ${deg(h.footTurnedL)} against the pelvis's ${deg(h.pelvisTurned)} under a real drag`);
}
await page.evaluate(() => { window.__app.orbit.enabled = true; });

// ---- screenshots. Drive the real topbar buttons, not the app API, so the
// toolbar in the picture matches the mode the picture is showing.
const clickUI = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const setLayer = (v) => page.evaluate((val) => {
  const el = document.getElementById('layer-mode');
  el.value = val;
  el.dispatchEvent(new Event('change'));
}, v);

// The twist reads clearest from above on the skeleton: hips turned, shoulders
// square to where they started.
await page.evaluate(() => window.__app.applyPreset(0));
await clickUI('#mode-buttons button[data-mode="hips"]');
await clickUI('#hips-tools button[data-hips-tool="twist"]');
await setLayer('skeleton');
await page.evaluate(() => {
  const app = window.__app;
  app.selectFigure(app.leader);
  app.pivotHips(app.leader, 40 * Math.PI / 180);
  app.setView('top');
});
await sleep(500);
await page.screenshot({ path: `${outDir}/turns-hips-twist-top.png` });

await setLayer('body');
await clickUI('#mode-buttons button[data-mode="move"]');
await page.evaluate(() => {
  const el = document.getElementById('move-pivot');
  el.value = 'cog';
  el.dispatchEvent(new Event('change'));
  window.__app.setView('three');
  window.__app.selectFigure(window.__app.leader);
});
await sleep(500);
await page.screenshot({ path: `${outDir}/turns-move-ring.png` });

console.log(JSON.stringify(report, null, 2));
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(`  - ${p}`);
} else {
  console.log('\nAll turn checks passed.');
}
console.log(logs.length ? `\nConsole errors:\n${logs.join('\n')}` : '\nNo console errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);
