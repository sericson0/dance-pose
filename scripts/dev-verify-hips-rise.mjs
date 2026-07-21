// Dev check for the Move-hips RISE LIMIT (planted feet never leave the floor):
//   - raising the hips straightens the leg (knee/hip extend) then rolls the
//     foot up onto its toe (ankle plantarflexes — a relevé),
//   - and once even a full relevé can't hold the foot down, the pelvis stops
//     rising there (a planted foot never lifts off y = 0),
//   - a fresh push up from the clamped top can't go further,
//   - lowering afterwards flattens the foot back down (relevé reverses).
// Honours DEV_URL. Prints numeric diagnostics + console errors; screenshots.
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const URL = process.env.DEV_URL || 'http://localhost:5173';
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

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise((r) => setTimeout(r, 2000));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await page.evaluate(async () => {
  const app = window.__app;
  app.setEmbrace({ hands: false, close: false });
  app.applyPreset(0); // standing
  await new Promise((r) => setTimeout(r, 300));
  const f = app.leader;
  const H = f.height;
  const DEG = Math.PI / 180;
  const snap = () => {
    f.group.updateMatrixWorld(true);
    return {
      pelvisY: f.nodes.pelvis.position.y / H,
      lowL: f.footLowY('L'),
      lowR: f.footLowY('R'),
      kneeL: f.nodes.knee_L.rotation.x / DEG,
      ankleL: f.nodes.ankle_L.rotation.x / DEG,
    };
  };

  const start = snap();

  // 1) One big scripted push up with both feet planted. The rise must clamp so
  //    neither planted foot leaves the floor.
  app.moveHips(f, { x: 0, y: 0.25, z: 0 }, { L: true, R: true });
  await new Promise((r) => setTimeout(r, 100));
  const risen = snap();

  // 2) Push up again from the clamped top — it must not climb further.
  const before2 = f.nodes.pelvis.position.y;
  const dy2 = app.moveHips(f, { x: 0, y: 0.15, z: 0 }, { L: true, R: true });
  await new Promise((r) => setTimeout(r, 50));
  const again = snap();

  // 3) Lower back down: the foot should flatten again (relevé reverses).
  app.moveHips(f, { x: 0, y: -0.25, z: 0 }, { L: true, R: true });
  await new Promise((r) => setTimeout(r, 100));
  const lowered = snap();

  // 4) One foot planted (L), other free (R): raising must keep L down while R
  //    rides up with the body.
  app.applyPreset(0);
  await new Promise((r) => setTimeout(r, 250));
  const s4 = snap();
  app.moveHips(f, { x: 0, y: 0.25, z: 0 }, { L: true, R: false });
  await new Promise((r) => setTimeout(r, 80));
  const one = snap();

  // 5) Drag path: freeze a base (as the gizmo does at grab time), rise in small
  //    steps, then lower — the foot should relevé up and flatten back down about
  //    that fixed base without ratcheting.
  app.applyPreset(0);
  await new Promise((r) => setTimeout(r, 250));
  app.hipsState = { figure: f, last: null, lastYaw: 0, plantBase: app.captureHipsPlantBase(f, { L: true, R: true }) };
  const dragStart = snap();
  // Rise a modest ~0.06 m (stays under the 0.58H cap so the rise isn't clamped),
  // then lower the same amount back to the grab height.
  for (let i = 0; i < 3; i++) app.moveHips(f, { x: 0, y: 0.02, z: 0 }, { L: true, R: true }); // rise onto the toe
  const dragTop = snap();
  for (let i = 0; i < 3; i++) app.moveHips(f, { x: 0, y: -0.02, z: 0 }, { L: true, R: true }); // lower back to start
  const dragEnd = snap();
  app.hipsState = null;

  return {
    start, risen, again, dy2, lowered, s4, one, dragStart, dragTop, dragEnd,
  };
});

const mm = (m) => (m * 1000).toFixed(1);
const cm = (m) => (m * 100).toFixed(1);
console.log(`--- Start: pelvisY ${(res.start.pelvisY).toFixed(3)}H, foot low L/R ${mm(res.start.lowL)}/${mm(res.start.lowR)}mm, knee ${res.start.kneeL.toFixed(0)}°, ankle ${res.start.ankleL.toFixed(0)}°`);
console.log(`--- Rise +0.25H: pelvisY ${(res.risen.pelvisY).toFixed(3)}H (up ${((res.risen.pelvisY - res.start.pelvisY) * 100).toFixed(1)}%H), foot low L/R ${mm(res.risen.lowL)}/${mm(res.risen.lowR)}mm, knee ${res.risen.kneeL.toFixed(0)}°, ankle ${res.risen.ankleL.toFixed(0)}°`);
console.log(`--- Push again: dy ${mm(res.dy2)}mm, foot low L/R ${mm(res.again.lowL)}/${mm(res.again.lowR)}mm`);
console.log(`--- Lowered -0.25H: pelvisY ${(res.lowered.pelvisY).toFixed(3)}H, foot low L/R ${mm(res.lowered.lowL)}/${mm(res.lowered.lowR)}mm, knee ${res.lowered.kneeL.toFixed(0)}°, ankle ${res.lowered.ankleL.toFixed(0)}°`);
console.log(`--- One planted (L): rise foot low L ${mm(res.one.lowL)}mm, R ${mm(res.one.lowR)}mm (R free rides up)`);
console.log(`--- Drag path: top pelvisY ${res.dragTop.pelvisY.toFixed(3)}H (foot low ${mm(res.dragTop.lowL)}mm, ankle ${res.dragTop.ankleL.toFixed(0)}°) -> end pelvisY ${res.dragEnd.pelvisY.toFixed(3)}H (foot low ${mm(res.dragEnd.lowL)}mm, ankle ${res.dragEnd.ankleL.toFixed(0)}°)`);

// The headline: planted feet stay on the floor through the rise.
if (res.risen.lowL > 0.006) problems.push(`rise lifted the planted LEFT foot ${mm(res.risen.lowL)}mm off the floor`);
if (res.risen.lowR > 0.006) problems.push(`rise lifted the planted RIGHT foot ${mm(res.risen.lowR)}mm off the floor`);
// It did rise SOMETHING (the clamp isn't just refusing all motion).
if (res.risen.pelvisY <= res.start.pelvisY + 0.001) problems.push('rise did not raise the hips at all');
// Leg straightened (knee toward 0) AND/OR ankle plantarflexed (relevé) — the
// "knee/hip then ankle" progression should leave the leg straighter and the
// ankle more pointed than standing.
if (res.risen.kneeL >= res.start.kneeL && res.risen.ankleL <= res.start.ankleL) {
  problems.push('rise neither straightened the knee nor plantarflexed the ankle');
}
// Second push from the top can't climb further.
if (res.dy2 > 0.004) problems.push(`hips kept rising past the limit (+${mm(res.dy2)}mm)`);
// Lowering flattens the foot back down.
if (res.lowered.lowL > 0.006) problems.push(`after lowering the foot did not return to the floor (${mm(res.lowered.lowL)}mm up)`);
if (res.lowered.pelvisY >= res.risen.pelvisY - 0.001) problems.push('lowering did not lower the hips');
// One-foot-planted: the planted foot stays down.
if (res.one.lowL > 0.006) problems.push(`one-foot rise lifted the planted LEFT foot ${mm(res.one.lowL)}mm`);
// Drag path: foot held the floor through the rise, then flattened back on the
// way down (relevé reversed about the frozen base, no ratchet).
if (res.dragTop.lowL > 0.006) problems.push(`drag rise lifted the planted foot ${mm(res.dragTop.lowL)}mm`);
if (res.dragTop.pelvisY <= res.dragStart.pelvisY + 0.001) problems.push('drag rise did not raise the hips');
if (res.dragTop.ankleL <= res.dragStart.ankleL + 5) problems.push('drag rise did not roll the foot up onto its toe (no relevé)');
// Back at the start height the foot has flattened again (relevé reversed about
// the frozen base — no ratchet).
if (res.dragEnd.lowL > 0.006) problems.push(`drag lower left the foot off the floor ${mm(res.dragEnd.lowL)}mm`);
if (Math.abs(res.dragEnd.pelvisY - res.dragStart.pelvisY) > 0.01) problems.push(`drag rise+lower did not return to the start height (${res.dragEnd.pelvisY.toFixed(3)}H vs ${res.dragStart.pelvisY.toFixed(3)}H — ratcheted)`);
if (Math.abs(res.dragEnd.ankleL) > 8) problems.push(`drag lower left the foot pointed (ankle ${res.dragEnd.ankleL.toFixed(0)}°) — relevé did not reverse`);

await sleep(150);
await page.screenshot({ path: `${outDir}/hips-rise.png` });

if (logs.length) {
  console.log('\nConsole errors:');
  for (const l of logs) console.log('  ' + l);
} else {
  console.log('No console errors.');
}
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exitCode = 1;
} else {
  console.log('\nAll hips-rise checks passed.');
}
await browser.close();
