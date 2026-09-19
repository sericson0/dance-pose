// Dev check: a movement clip KEEPS the pose the dancer was in.
//
// Clips used to reset the dancer to the anatomical position (the textbook
// neutral stance at the origin) on entry, which made it impossible to show
// what a movement looks like inside a real tango position — the dancer snapped
// to a T-pose the moment the clip opened. The reset is now the ⟲ Anatomical
// position button; the default keeps the pose and the placement.
//
// Note dev-verify-studio.mjs deliberately passes { anatomical: true } for its
// direction checks: the MOVEMENTS table's ranges and directions are DEFINED
// from the anatomical position, so that is the frame they must be measured in.
//
// Honours DEV_URL (default http://localhost:5173).
import puppeteer from 'puppeteer-core';

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pose fingerprint built from joints the hip-flexion row does NOT drive, so
// anything that survives is the user's pose rather than the movement's doing.
const snap = () => page.evaluate(() => {
  const f = window.__app.leader;
  const deg = (n, a) => +(f.nodes[n].rotation[a] * 180 / Math.PI).toFixed(2);
  return {
    chestY: deg('chest', 'y'),
    spineY: deg('spine', 'y'),
    shoulderLX: deg('shoulder_L', 'x'),
    elbowLX: deg('elbow_L', 'x'),
    hipLX: deg('hip_L', 'x'),
    pos: f.group.position.toArray().map((n) => +n.toFixed(4)),
  };
});

// ---- 1. Pose a couple with a distinctive, clearly non-neutral shape.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(4); // a tango figure, not the default stance
  app.leader.setJointDegrees({ chest: { y: 22 }, spine: { y: 7 }, shoulder_L: { x: -35 } });
  app.slideFigure ? null : null;
  app.leader.group.position.set(0.6, 0, -0.3);
  app.requestSim?.();
});
await sleep(600);
const posed = await snap();
if (Math.abs(posed.chestY - 22) > 2) problems.push(`setup failed: chest twist is ${posed.chestY}°, expected ~22°`);

// ---- 2. Entering a clip keeps that pose AND the placement.
await page.evaluate(() => {
  const app = window.__app;
  app.enterClip('hp_flex', { figure: app.leader, side: 'L' });
  app.scrubClip(0);
});
await sleep(700);
const inClip = await snap();
for (const k of ['chestY', 'spineY', 'shoulderLX', 'elbowLX']) {
  if (Math.abs(inClip[k] - posed[k]) > 1.5) {
    problems.push(`entering the clip changed ${k}: ${posed[k]}° → ${inClip[k]}° (the pose should be kept)`);
  }
}
const moved = Math.hypot(...inClip.pos.map((n, i) => n - posed.pos[i]));
if (moved > 0.02) problems.push(`entering the clip moved the dancer ${(moved * 100).toFixed(1)} cm (placement should be kept)`);
console.log(`--- kept pose: chest ${inClip.chestY}° · shoulder ${inClip.shoulderLX}° · at [${inClip.pos}]`);

// ---- 3. The clip still works from that pose: the angle sweeps its range.
const swing = await page.evaluate(async () => {
  const app = window.__app;
  const clip = app.studio.clip;
  const R2D = 180 / Math.PI;
  // motion.angle is written by the render tick, so let a frame land after each
  // scrub before reading it.
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  app.scrubClip(0);
  await frame();
  const a = Math.abs(app.studio.clip.motion.angle) * R2D;
  app.scrubClip((clip.segs[0].t1 + 0.05) / clip.duration);
  await frame();
  const b = Math.abs(app.studio.clip.motion.angle) * R2D;
  return { a, b, anatomical: !!clip.anatomical };
});
if (swing.anatomical) problems.push('the clip reset to the anatomical position by default');
if (!(Math.abs(swing.b - swing.a) > 20)) {
  problems.push(`the movement barely swings from the kept pose (${swing.a?.toFixed?.(1)}° → ${swing.b?.toFixed?.(1)}°)`);
}
console.log(`--- swing from the kept pose: ${Number(swing.a).toFixed(1)}° → ${Number(swing.b).toFixed(1)}°`);

// ---- 4. The ⟲ button DOES move to the anatomical position.
// The clips section lives in the sidebar's Teach tab, so bring it forward and
// unfold it before clicking — a hidden button has no clickable point.
await page.evaluate(() => {
  window.__app.activateTab('teach');
  window.__app.setSectionCollapsed(document.getElementById('clips-section'), false);
});
await sleep(300);
const btnBefore = await page.evaluate(() => document.getElementById('clip-anatomical').disabled);
if (btnBefore) problems.push('the ⟲ Anatomical position button is disabled while the clip holds a kept pose');
await page.click('#clip-anatomical');
await sleep(700);
const neutral = await snap();
if (Math.abs(neutral.chestY) > 2 || Math.abs(neutral.spineY) > 2) {
  problems.push(`⟲ left a twist in the trunk: chest ${neutral.chestY}°, spine ${neutral.spineY}°`);
}
const atOrigin = Math.hypot(neutral.pos[0], neutral.pos[2]);
if (atOrigin > 0.02) problems.push(`⟲ left the dancer ${(atOrigin * 100).toFixed(1)} cm off the origin`);
const btnAfter = await page.evaluate(() => document.getElementById('clip-anatomical').disabled);
if (!btnAfter) problems.push('the ⟲ button is still enabled after the dancer is already anatomical');
console.log(`--- after ⟲: chest ${neutral.chestY}° · spine ${neutral.spineY}° · at [${neutral.pos}]`);

// ---- 5. Exit still restores the couple exactly, from the anatomical state.
await page.evaluate(() => window.__app.exitClip());
await sleep(800);
const restored = await snap();
for (const k of ['chestY', 'spineY', 'shoulderLX', 'elbowLX', 'hipLX']) {
  if (Math.abs(restored[k] - posed[k]) > 1.5) {
    problems.push(`exit did not restore ${k}: ${posed[k]}° → ${restored[k]}°`);
  }
}
const back = Math.hypot(...restored.pos.map((n, i) => n - posed.pos[i]));
if (back > 0.02) problems.push(`exit left the dancer ${(back * 100).toFixed(1)} cm from where they were`);
const bothShown = await page.evaluate(() => window.__app.shown);
if (bothShown !== 'both') problems.push(`exit left visibility as "${bothShown}", expected "both"`);
console.log(`--- restored: chest ${restored.chestY}° · at [${restored.pos}] · shown ${bothShown}`);

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All clip-pose checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
