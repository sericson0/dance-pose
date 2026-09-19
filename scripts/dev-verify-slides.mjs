// Dev check for SLIDES: a saved slide carries the pose AND the way it is shown
// (layer, backdrop, frame, who is on screen, the camera, labels, highlights,
// muscles), Show puts all of it back, the deck has an explicit running order
// that survives a reload, and — the property the whole design rests on — the
// view block is OPT-IN, so undo, the COG trail and sequence keyframes stay
// pose-only and never move the camera.
// Honours DEV_URL (default http://localhost:5173).
import puppeteer from 'puppeteer-core';

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
await new Promise((r) => setTimeout(r, 2500));
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const view = () => page.evaluate(() => ({
  layer: document.getElementById('layer-mode').value,
  backdrop: document.getElementById('backdrop').value,
  shown: window.__app.shown,
  cam: window.__app.camera.position.toArray().map((n) => +n.toFixed(3)),
  target: window.__app.orbit.target.toArray().map((n) => +n.toFixed(3)),
  labels: window.__app.labels.toJSON().length,
  lit: document.querySelectorAll('#highlight-chips .chip.active').length,
}));

// ---- 1. Author a distinctive slide: skeleton layer, white backdrop, leader
// only, a moved camera, a label and a lit body part.
await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(1);
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('change'));
  };
  set('layer-mode', 'skeleton');
  set('backdrop', 'light');
  app.setVisibleFigures('leader');
  app.camera.position.set(3.1, 1.9, 2.4);
  app.orbit.target.set(0.2, 1.0, 0.1);
  app.orbit.update();
  document.querySelectorAll('#highlight-chips .chip')[0].click();
  app.addLabel(app.leader, 'joint', 'knee_L');
  document.getElementById('pose-name').value = 'Slide One';
  document.getElementById('pose-save').click();
});
await sleep(400);
const authored = await view();
if (authored.labels < 1) problems.push('authoring did not add a label');
if (authored.lit < 1) problems.push('authoring did not light a body part');

const savedHasView = await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('tangoPoseStudio.poses.v1'));
  const s = lib['Slide One'];
  return s && s.view
    ? { layer: s.view.layer, backdrop: s.view.backdrop, shown: s.view.shown, labels: s.view.labels.length, parts: s.view.highlight.parts.length, hasCam: !!s.view.camera }
    : null;
});
if (!savedHasView) problems.push('the saved slide has no view block at all');
else {
  if (savedHasView.layer !== 'skeleton') problems.push(`slide stored layer ${savedHasView.layer}, expected skeleton`);
  if (savedHasView.backdrop !== 'light') problems.push(`slide stored backdrop ${savedHasView.backdrop}, expected light`);
  if (savedHasView.shown !== 'leader') problems.push(`slide stored shown ${savedHasView.shown}, expected leader`);
  if (!savedHasView.labels) problems.push('slide stored no labels');
  if (!savedHasView.parts) problems.push('slide stored no highlighted parts');
  if (!savedHasView.hasCam) problems.push('slide stored no camera');
}

// ---- 2. Tear the view down, then Show must put every part of it back.
await page.evaluate(() => {
  const app = window.__app;
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('change'));
  };
  set('layer-mode', 'body');
  set('backdrop', 'studio');
  app.setVisibleFigures('both');
  app.camera.position.set(-2, 3, -4);
  app.orbit.target.set(0, 1.05, 0);
  app.orbit.update();
  app.clearLabels();
  document.getElementById('highlight-clear').click();
});
await sleep(300);
await page.evaluate(() => window.__app.showSlide('Slide One'));
await sleep(500);
const restored = await view();
for (const k of ['layer', 'backdrop', 'shown', 'labels', 'lit']) {
  if (String(restored[k]) !== String(authored[k])) {
    problems.push(`Show did not restore ${k}: ${restored[k]} vs ${authored[k]}`);
  }
}
const camGap = Math.hypot(...restored.cam.map((n, i) => n - authored.cam[i]));
if (camGap > 0.01) problems.push(`Show left the camera ${camGap.toFixed(3)} m from the slide's`);

// ---- 3. THE OPT-IN GUARANTEE: undo restores the pose, never the camera.
await page.evaluate(() => {
  const app = window.__app;
  app.camera.position.set(1.5, 2.2, 5.5);
  app.orbit.update();
  app.pushHistory();
  app.editJoint(app.leader, 'elbow_L', () => { app.leader.nodes.elbow_L.rotation.x = -0.6; });
});
await sleep(250);
const beforeUndo = await view();
await page.evaluate(() => window.__app.undo());
await sleep(350);
const afterUndo = await view();
const undoCamGap = Math.hypot(...afterUndo.cam.map((n, i) => n - beforeUndo.cam[i]));
if (undoCamGap > 0.001) problems.push(`undo MOVED the camera by ${undoCamGap.toFixed(3)} m — the view block leaked into history`);
const undoState = await page.evaluate(() => {
  const s = JSON.parse(window.__app.history.at(-1) ?? 'null');
  return { hasView: !!(s && s.view) };
});
if (undoState.hasView) problems.push('an undo snapshot carries a view block');
const keyframeHasView = await page.evaluate(() => {
  const app = window.__app;
  app.seqAdd();
  const k = app.seqStates.at(-1);
  app.seqDelete(app.seqStates.length - 1);
  return !!k.view;
});
if (keyframeHasView) problems.push('a sequence keyframe carries a view block');

// ---- 4. A pose-only state leaves the view alone.
await page.evaluate(() => window.__app.showSlide('Slide One'));
await sleep(400);
const beforePoseOnly = await view();
await page.evaluate(() => {
  const app = window.__app;
  const bare = app.getCoupleState('bare'); // no { view: true }
  app.applyCoupleState(bare);
});
await sleep(300);
const afterPoseOnly = await view();
for (const k of ['layer', 'backdrop', 'shown', 'labels', 'lit']) {
  if (String(afterPoseOnly[k]) !== String(beforePoseOnly[k])) {
    problems.push(`a pose-only state changed ${k}: ${beforePoseOnly[k]} → ${afterPoseOnly[k]}`);
  }
}

// ---- 5. Deck order: a second slide, reorder, and survive a reload.
await page.evaluate(() => {
  document.getElementById('pose-name').value = 'Slide Two';
  document.getElementById('pose-save').click();
});
await sleep(300);
let order = await page.evaluate(() => window.__app.slideNames());
if (order.join() !== 'Slide One,Slide Two') problems.push(`deck order is [${order}], expected [Slide One,Slide Two]`);
// Push the second slide up with its own ↑ button.
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#pose-list .pose-item')];
  const second = rows.find((r) => r.querySelector('.name').textContent === 'Slide Two');
  second.querySelector('button[aria-label^="Move"]').click();
});
await sleep(250);
order = await page.evaluate(() => window.__app.slideNames());
if (order.join() !== 'Slide Two,Slide One') problems.push(`after ↑ the order is [${order}], expected [Slide Two,Slide One]`);
await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
await sleep(2500);
order = await page.evaluate(() => window.__app.slideNames());
if (order.join() !== 'Slide Two,Slide One') problems.push(`after a reload the order is [${order}], expected [Slide Two,Slide One]`);

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All slide checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
