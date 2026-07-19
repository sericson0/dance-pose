// Dev check for the pose controls added around the foot:
//   - fitted sole corners (support base hugs the rendered shoe, per figure)
//   - toe caress (big toe pinned to the floor, leg accommodates, body never lifts)
//   - move hips (upper body translates rigidly, planted feet stay put)
//   - photo capture (PNG data URL)
//   - foot map canvas draws, joint grid picks joints
// Screenshots + console errors + numeric diagnostics.
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
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

await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise((r) => setTimeout(r, 2000));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Sole corners hug each avatar's own shoe (the follower's is shorter).
const soles = await page.evaluate(() => {
  const app = window.__app;
  const tipZ = (f) => f.toeCorners._L[0][2] + 0.090; // ankle-frame toe-pad z
  return {
    leaderTip: tipZ(app.leader),
    followerTip: tipZ(app.follower),
    leaderBallHalfW: Math.abs(app.leader.footCorners._L[2][0]),
  };
});
if (soles.leaderTip > 0.105 || soles.leaderTip < 0.09) problems.push(`leader toe-pad at ${soles.leaderTip}H (expected ≈0.100H)`);
if (soles.followerTip > 0.085) problems.push(`follower toe-pad at ${soles.followerTip}H — longer than her shoe (~0.078H)`);
if (soles.leaderBallHalfW > 0.030) problems.push(`ball half-width ${soles.leaderBallHalfW}H still overhangs the shoe`);
console.log(`--- Sole fit: leader tip ${soles.leaderTip.toFixed(3)}H, follower tip ${soles.followerTip.toFixed(3)}H, ball ±${soles.leaderBallHalfW}H`);

// ---- 2. Toe caress: big toe pinned to the floor through near/far/side/back
// targets; the body must never rise and the support foot must not move.
const caress = await page.evaluate(async () => {
  const app = window.__app;
  app.setEmbrace({ hands: false, close: false });
  app.applyPreset(0); // standing reset
  await new Promise((r) => setTimeout(r, 300));
  const f = app.leader;
  const V = f.group.position.constructor;
  f.group.updateMatrixWorld(true);
  const H = f.height;
  const padWorld = () => {
    f.group.updateMatrixWorld(true);
    const tc = f.toeCorners._L;
    const p = new V(
      (tc[0][0] + tc[1][0]) / 2, (tc[0][1] + tc[1][1]) / 2, (tc[0][2] + tc[1][2]) / 2,
    ).multiplyScalar(H);
    return f.nodes.toes_L.localToWorld(p);
  };
  const start = padWorld();
  const supportBefore = f.nodes.ankle_R.getWorldPosition(new V());
  const pelvisBefore = f.nodes.pelvis.getWorldPosition(new V());
  const cases = [
    ['near-fwd', start.x, start.z + 0.10 * H],
    ['far-fwd', start.x, start.z + 0.40 * H],
    ['side', start.x + 0.30 * H, start.z + 0.10 * H],
    ['far-back', start.x + 0.02 * H, start.z - 0.35 * H],
    ['cross', start.x - 0.10 * H, start.z + 0.15 * H],
  ];
  const out = [];
  for (const [label, x, z] of cases) {
    app.caressFoot(f, 'L', { x, z });
    await new Promise((r) => setTimeout(r, 120)); // a couple of frames of constraints
    const pad = padWorld();
    const pelvis = f.nodes.pelvis.getWorldPosition(new V());
    out.push({
      label,
      padY: pad.y,
      padMissXZ: Math.hypot(pad.x - x, pad.z - z),
      lowY: f.footLowY('L'),
      rootLift: f.group.position.y,
      pelvisDrift: pelvis.distanceTo(pelvisBefore),
      supportDrift: f.nodes.ankle_R.getWorldPosition(new V()).distanceTo(supportBefore),
      ankleDeg: f.nodes.ankle_L.rotation.x * 180 / Math.PI,
    });
  }
  return out;
});
for (const c of caress) {
  console.log(`--- Caress ${c.label}: padY ${(c.padY * 1000).toFixed(1)}mm, miss ${(c.padMissXZ * 100).toFixed(1)}cm, `
    + `low ${(c.lowY * 1000).toFixed(1)}mm, lift ${(c.rootLift * 1000).toFixed(1)}mm, ankle ${c.ankleDeg.toFixed(0)}°`);
  if (Math.abs(c.padY) > 0.008) problems.push(`caress ${c.label}: toe pad ${(c.padY * 1000).toFixed(1)}mm off the floor`);
  if (c.lowY < -0.002) problems.push(`caress ${c.label}: sole dug ${(c.lowY * 1000).toFixed(1)}mm into the floor`);
  if (c.rootLift > 0.002) problems.push(`caress ${c.label}: body lifted ${(c.rootLift * 1000).toFixed(1)}mm`);
  if (c.pelvisDrift > 0.002) problems.push(`caress ${c.label}: pelvis drifted ${(c.pelvisDrift * 1000).toFixed(1)}mm`);
  if (c.supportDrift > 0.002) problems.push(`caress ${c.label}: support foot drifted ${(c.supportDrift * 1000).toFixed(1)}mm`);
}
await page.evaluate(() => {
  const app = window.__app;
  app.caressFoot(app.leader, 'L', {
    x: app.leader.group.position.x + 0.1,
    z: app.leader.group.position.z - 0.45,
  });
  app.setVisibleFigures('leader');
});
await sleep(250);
await page.screenshot({ path: `${outDir}/caress-back-point.png` });

// ---- 3. Move hips: posture rigid above, planted feet pinned, free leg rides.
const hips = await page.evaluate(async () => {
  const app = window.__app;
  app.setVisibleFigures('both');
  app.applyPreset(0);
  await new Promise((r) => setTimeout(r, 300));
  const f = app.leader;
  const V = f.group.position.constructor;
  const snap = () => {
    f.group.updateMatrixWorld(true);
    return {
      aL: f.nodes.ankle_L.getWorldPosition(new V()),
      aR: f.nodes.ankle_R.getWorldPosition(new V()),
      pelvis: f.nodes.pelvis.getWorldPosition(new V()),
      chestRel: f.nodes.chest.getWorldPosition(new V()).sub(f.nodes.pelvis.getWorldPosition(new V())),
      spineX: f.nodes.spine.rotation.x,
    };
  };
  const before = snap();
  app.moveHips(f, { x: 0.06, y: -0.05, z: 0.05 }, { L: true, R: true });
  await new Promise((r) => setTimeout(r, 150));
  const both = snap();
  const bothRes = {
    aLdrift: both.aL.distanceTo(before.aL),
    aRdrift: both.aR.distanceTo(before.aR),
    pelvisMoveXZ: Math.hypot(both.pelvis.x - before.pelvis.x, both.pelvis.z - before.pelvis.z),
    pelvisDrop: before.pelvis.y - both.pelvis.y,
    postureDrift: both.chestRel.distanceTo(before.chestRel),
    spineDelta: Math.abs(both.spineX - before.spineX),
  };
  // One foot planted: the free (right) foot must travel with the body.
  app.applyPreset(0);
  await new Promise((r) => setTimeout(r, 300));
  const b2 = snap();
  app.moveHips(f, { x: 0, y: 0, z: 0.07 }, { L: true, R: false });
  await new Promise((r) => setTimeout(r, 150));
  const one = snap();
  return {
    both: bothRes,
    one: {
      aLdrift: one.aL.distanceTo(b2.aL),
      aRtravel: Math.hypot(one.aR.x - b2.aR.x, one.aR.z - b2.aR.z),
    },
  };
});
console.log(`--- Hips (both planted): ankles drift ${(hips.both.aLdrift * 1000).toFixed(1)}/${(hips.both.aRdrift * 1000).toFixed(1)}mm, `
  + `pelvis moved ${(hips.both.pelvisMoveXZ * 100).toFixed(1)}cm + down ${(hips.both.pelvisDrop * 100).toFixed(1)}cm, posture drift ${(hips.both.postureDrift * 1e6).toFixed(0)}µm`);
console.log(`--- Hips (left planted): left drift ${(hips.one.aLdrift * 1000).toFixed(1)}mm, right travelled ${(hips.one.aRtravel * 100).toFixed(1)}cm`);
if (hips.both.aLdrift > 0.008 || hips.both.aRdrift > 0.008) problems.push('moveHips: planted ankle drifted > 8mm');
if (hips.both.pelvisMoveXZ < 0.06) problems.push('moveHips: pelvis did not travel the requested distance');
if (hips.both.postureDrift > 1e-4) problems.push('moveHips: chest moved relative to pelvis (posture changed)');
if (hips.both.spineDelta > 1e-6) problems.push('moveHips: spine angle changed');
if (hips.one.aLdrift > 0.008) problems.push('moveHips one-foot: planted foot drifted');
if (hips.one.aRtravel < 0.05) problems.push('moveHips one-foot: free foot did not ride along');
await sleep(200);
await page.screenshot({ path: `${outDir}/hips-shift.png` });

// ---- 4. Photo capture produces a real PNG.
const photo = await page.evaluate(() => {
  const url = window.__app.photoDataURL();
  return { ok: url.startsWith('data:image/png'), len: url.length };
});
if (!photo.ok || photo.len < 20000) problems.push(`photo data URL wrong (ok=${photo.ok}, len=${photo.len})`);
console.log(`--- Photo: ${(photo.len / 1024).toFixed(0)} kB data URL`);

// ---- 5. Foot map canvas draws pixels; note text reports the COG.
await sleep(600); // let a stats tick redraw it
const footmap = await page.evaluate(() => {
  const canvas = document.getElementById('footmap-canvas');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) painted++; }
  return { painted, note: document.getElementById('footmap-note').textContent };
});
if (footmap.painted < 500) problems.push(`foot map canvas nearly blank (${footmap.painted} px)`);
if (!/COG/.test(footmap.note)) problems.push(`foot map note missing COG: "${footmap.note}"`);
console.log(`--- Foot map: ${footmap.painted} px painted · "${footmap.note}"`);
await page.screenshot({ path: `${outDir}/footmap-panel.png` });

// ---- 6. Joint grid: two-column picker selects joints on either dancer.
const grid = await page.evaluate(() => {
  const app = window.__app;
  const btns = [...document.querySelectorAll('#joint-grid button')];
  const knees = btns.filter((b) => b.textContent === 'Knee');
  if (knees.length !== 2) return { error: `expected 2 Knee buttons, got ${knees.length}` };
  knees[0].click(); // left column
  const first = app.selected && app.selected.jointName;
  document.querySelector('#joint-fig-toggle button[data-role="follower"]').click();
  const second = {
    joint: app.selected && app.selected.jointName,
    fig: app.selected && app.selected.figure.name,
  };
  knees[1].click();
  const third = app.selected && app.selected.jointName;
  return { count: btns.length, first, second, third };
});
if (grid.error) problems.push(grid.error);
else {
  if (grid.first !== 'knee_L') problems.push(`grid left knee selected ${grid.first}`);
  if (grid.second.joint !== 'knee_L' || grid.second.fig !== 'Follower') problems.push(`fig toggle re-select got ${JSON.stringify(grid.second)}`);
  if (grid.third !== 'knee_R') problems.push(`grid right knee selected ${grid.third}`);
  console.log(`--- Joint grid: ${grid.count} buttons, L/R knee + dancer toggle OK`);
}

// ---- 7. Hips mode UI: planted checkboxes appear with the mode.
const hipsUI = await page.evaluate(() => {
  document.querySelector('#mode-buttons button[data-mode="hips"]').click();
  const shown = !document.getElementById('hips-plant').hidden;
  document.querySelector('#mode-buttons button[data-mode="rotate"]').click();
  const hiddenAgain = document.getElementById('hips-plant').hidden;
  return { shown, hiddenAgain };
});
if (!hipsUI.shown || !hipsUI.hiddenAgain) problems.push(`hips planted checkboxes visibility wrong: ${JSON.stringify(hipsUI)}`);

// ---- 8. Support-base overlay vs feet, top view (visual check screenshot).
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.setView('top');
});
await sleep(400);
await page.screenshot({ path: `${outDir}/support-base-top.png` });

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
