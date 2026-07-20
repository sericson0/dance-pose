// Dev check for the grounded keyframe interpolation (a foot planted at both
// ends of a segment stays connected to the floor — holding its spot, or
// gliding when the keyframes place it differently — while a foot airborne at
// either end lerps freely) and the keyboard nudges in the editing modes
// (selected joint rotation, IK-handle moves, hips crouch with planted feet).
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

// ---- 1. Feet glued through interpolation. A = standing; B = one snapped step
// forward (both feet grounded at both ends, both moved). Halfway, both feet
// must still touch the floor (glide, not arc) and the support ankle must sit
// on the lerped line between its two keyframe spots.
const glide = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  app.linkCouple = false;
  document.getElementById('embrace-hands').checked = false;
  document.getElementById('embrace-hands').dispatchEvent(new Event('change', { bubbles: true }));
  app.setVisibleFigures('leader');
  const f = app.leader;
  const A = app.getCoupleState('A');
  const ankleAt = (side) => f.worldPos(`ankle_${side}`).clone();
  const aL = ankleAt('L');
  const aR = ankleAt('R');
  app.animateSteps = false;
  app.stepFigure(f, 1); // snap one step
  const B = app.getCoupleState('B');
  const bL = ankleAt('L');
  const bR = ankleAt('R');
  app.setInterpStates(A, B);
  app.applyInterp(0.5);
  const midL = ankleAt('L');
  const midR = ankleAt('R');
  const expL = aL.clone().lerp(bL, 0.5);
  const expR = aR.clone().lerp(bR, 0.5);
  return {
    lowL: +f.footLowY('L').toFixed(4),
    lowR: +f.footLowY('R').toFixed(4),
    devL: +Math.hypot(midL.x - expL.x, midL.z - expL.z).toFixed(4),
    devR: +Math.hypot(midR.x - expR.x, midR.z - expR.z).toFixed(4),
  };
});
console.log(`--- Glide at t=0.5: low L=${glide.lowL} R=${glide.lowR} · ankle deviation L=${glide.devL} R=${glide.devR} m`);
if (glide.lowL < -0.005 || glide.lowL > 0.015) problems.push(`glide: left foot left the floor mid-interp (low ${glide.lowL})`);
if (glide.lowR < -0.005 || glide.lowR > 0.015) problems.push(`glide: right foot left the floor mid-interp (low ${glide.lowR})`);
if (glide.devL > 0.02) problems.push(`glide: left ankle off the lerped track by ${glide.devL} m`);
if (glide.devR > 0.02) problems.push(`glide: right ankle off the lerped track by ${glide.devR} m`);
await sleep(200);
await page.screenshot({ path: `${outDir}/interp-glide-mid.png` });

// ---- 2. Standing leg holds while the free leg flies. A = standing; B = left
// leg kicked forward (airborne). Halfway the RIGHT (standing) foot must still
// be grounded on its spot; the LEFT must be well off the floor — the grounding
// rule must not pin a foot that lifts.
const kick = await page.evaluate(async () => {
  const app = window.__app;
  app.applyPreset(0);
  const f = app.leader;
  const A = app.getCoupleState('A');
  const supA = f.worldPos('ankle_R').clone();
  f.setJointDegrees({ hip_L: { x: -55 }, knee_L: { x: 25 }, ankle_L: { x: 25 } });
  f.clampToFloor();
  const B = app.getCoupleState('B');
  const liftedB = +f.footLowY('L').toFixed(3);
  app.setInterpStates(A, B);
  app.applyInterp(0.5);
  const supMid = f.worldPos('ankle_R').clone();
  return {
    liftedB,
    lowFreeMid: +f.footLowY('L').toFixed(4),
    lowSupMid: +f.footLowY('R').toFixed(4),
    supDrift: +Math.hypot(supMid.x - supA.x, supMid.z - supA.z).toFixed(4),
  };
});
console.log(`--- Kick at t=0.5: free low=${kick.lowFreeMid} (B lifted ${kick.liftedB}) · support low=${kick.lowSupMid}, drift ${kick.supDrift} m`);
if (kick.liftedB < 0.05) problems.push(`kick keyframe did not lift the foot (${kick.liftedB})`);
if (kick.lowFreeMid < 0.02) problems.push(`kick: free foot was pinned down mid-interp (low ${kick.lowFreeMid})`);
if (kick.lowSupMid < -0.005 || kick.lowSupMid > 0.015) problems.push(`kick: standing foot left the floor (low ${kick.lowSupMid})`);
if (kick.supDrift > 0.01) problems.push(`kick: standing foot drifted ${kick.supDrift} m mid-interp`);
await sleep(200);
await page.screenshot({ path: `${outDir}/interp-kick-mid.png` });

// ---- 3. Keyboard: rotate a selected joint with the arrows (tap = nudge).
const press = `(key, shiftKey = false) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))`;
const rot = await page.evaluate(async (pressSrc) => {
  const press = eval(pressSrc);
  const app = window.__app;
  app.applyPreset(0);
  document.querySelector('#mode-buttons button[data-mode="rotate"]').click();
  const f = app.leader;
  app.selectJoint(f, 'elbow_L');
  const x0 = f.nodes.elbow_L.rotation.x;
  for (let i = 0; i < 5; i++) press('ArrowUp'); // ↑ = −x = bend the elbow
  const dxUp = f.nodes.elbow_L.rotation.x - x0;
  app.selectJoint(f, 'shoulder_L');
  const z0 = f.nodes.shoulder_L.rotation.z;
  for (let i = 0; i < 5; i++) press('ArrowRight');
  const dzRight = f.nodes.shoulder_L.rotation.z - z0;
  const y0 = f.nodes.shoulder_L.rotation.y;
  for (let i = 0; i < 5; i++) press('PageUp');
  const dyPage = f.nodes.shoulder_L.rotation.y - y0;
  app.deselect();
  return {
    dxUp: +(dxUp * 180 / Math.PI).toFixed(2),
    dzRight: +(dzRight * 180 / Math.PI).toFixed(2),
    dyPage: +(dyPage * 180 / Math.PI).toFixed(2),
  };
}, press);
console.log(`--- Joint keys: elbow ↑ ${rot.dxUp}° · shoulder → ${rot.dzRight}° (z) · PageUp ${rot.dyPage}° (y)`);
if (rot.dxUp > -8) problems.push(`ArrowUp did not flex the selected elbow (${rot.dxUp}°)`);
if (rot.dzRight < 8) problems.push(`ArrowRight did not drive the shoulder Z axis (${rot.dzRight}°)`);
if (rot.dyPage < 8) problems.push(`PageUp did not twist the shoulder Y axis (${rot.dyPage}°)`);

// ---- 4. Keyboard: nudge an IK drag handle — the hand follows across the
// floor plane and vertically.
const ik = await page.evaluate(async (pressSrc) => {
  const press = eval(pressSrc);
  const app = window.__app;
  document.querySelector('#mode-buttons button[data-mode="ik"]').click();
  const f = app.leader;
  app.startIK(f, 'hand_L');
  const w0 = f.worldPos('wrist_L').clone();
  for (let i = 0; i < 6; i++) press('ArrowUp');
  const wMoved = f.worldPos('wrist_L').clone();
  for (let i = 0; i < 6; i++) press('PageUp');
  const wRaised = f.worldPos('wrist_L').clone();
  app.deselect();
  return {
    planar: +Math.hypot(wMoved.x - w0.x, wMoved.z - w0.z).toFixed(4),
    rise: +(wRaised.y - wMoved.y).toFixed(4),
  };
}, press);
console.log(`--- IK keys: hand slid ${ik.planar} m, rose ${ik.rise} m`);
if (ik.planar < 0.04) problems.push(`arrow keys did not move the IK hand (${ik.planar} m)`);
if (ik.rise < 0.04) problems.push(`PageUp did not raise the IK hand (${ik.rise} m)`);

// ---- 5. Keyboard + auto-select: entering Move-hips arms the handle on its
// own (no click), PageDown crouches while planted feet hold, and the handle
// re-seats when its dancer is hidden.
const hips = await page.evaluate(async (pressSrc) => {
  const press = eval(pressSrc);
  const app = window.__app;
  app.applyPreset(0);
  app.deselect();
  document.querySelector('#mode-buttons button[data-mode="hips"]').click();
  const autoArmed = !!app.hipsState;
  const f = app.hipsState?.figure ?? app.leader;
  const p0 = f.nodes.pelvis.position.y;
  const aL0 = f.worldPos(`ankle_L`).clone();
  for (let i = 0; i < 8; i++) press('PageDown');
  const aL1 = f.worldPos(`ankle_L`);
  const out = {
    autoArmed,
    sank: +(p0 - f.nodes.pelvis.position.y).toFixed(4),
    footDrift: +Math.hypot(aL1.x - aL0.x, aL1.z - aL0.z).toFixed(5),
  };
  app.setVisibleFigures('follower');
  out.reseated = app.hipsState?.figure === app.follower;
  app.setVisibleFigures('both');
  document.querySelector('#mode-buttons button[data-mode="rotate"]').click();
  out.cleared = !app.hipsState;
  return out;
}, press);
console.log(`--- Hips keys: auto-armed ${hips.autoArmed}, sank ${hips.sank} m, planted-foot drift ${hips.footDrift} m, `
  + `re-seated on hide ${hips.reseated}, cleared on mode exit ${hips.cleared}`);
if (!hips.autoArmed) problems.push('Move-hips mode did not auto-select a dancer');
if (hips.sank < 0.05) problems.push(`PageDown did not crouch the hips (${hips.sank} m)`);
if (hips.footDrift > 2e-3) problems.push(`hips crouch moved a planted foot (${hips.footDrift} m)`);
if (!hips.reseated) problems.push('hips handle did not re-seat on the shown dancer');
if (!hips.cleared) problems.push('hips handle survived leaving the mode');
await sleep(200);
await page.screenshot({ path: `${outDir}/keys-hips-crouch.png` });

// ---- 6. Foot map: still paints with the new silhouette; grab it for a look.
const footmap = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0);
  app.setVisibleFigures('both');
  return new Promise((resolve) => setTimeout(() => {
    const canvas = document.getElementById('footmap-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    const r = canvas.getBoundingClientRect();
    resolve({ painted, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
  }, 600));
});
console.log(`--- Foot map: ${footmap.painted} px painted`);
if (footmap.painted < 500) problems.push(`foot map nearly blank (${footmap.painted} px)`);
await page.screenshot({
  path: `${outDir}/footmap-shape.png`,
  clip: { x: footmap.rect.x, y: footmap.rect.y - 30, width: footmap.rect.w, height: footmap.rect.h + 60 },
});

if (problems.length) console.log(`PROBLEMS:\n${problems.join('\n')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
