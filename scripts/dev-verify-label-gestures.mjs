// Dev check: the two gestures a callout answers in the 3D view.
//
// 1. DRAG a callout across the figure and it moves to that column. The margin
//    layout's columns are the whole point — the one arrangement that never
//    overlaps itself or the anatomy — so the drag chooses a SIDE, it does not
//    place the pill freely. It is the sidebar ⇄ button's gesture, on the thing
//    itself. Like the clip title's drag, the grab is armed by HOVER, because
//    OrbitControls listens on the same canvas and would otherwise have started
//    a camera rotate before our pointerdown ran — so this checks the camera
//    stayed put as well as that the callout moved.
//
// 2. DOUBLE-CLICK one and its colour picker opens. A muscle callout is
//    recoloured through its BELLY (so the belly, its pill and the sidebar tag
//    go on reading as one thing, and a clip callout naming several heads
//    recolours all of them); a bone or joint callout has no belly to carry a
//    colour, so it takes one itself. The picker is a native dialog, so both
//    hooks are stubbed to record what was asked for — the same way
//    dev-verify-clip-title.mjs tests the click-on-a-belly path.
//
// The pill's hit box is whatever was DRAWN on the live overlay, so this also
// pins that an export (which redraws everything at its own resolution through
// the same code) cannot leave the pointer hit-testing against 4K coordinates.
//
// Honours DEV_URL (default http://localhost:5173) and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.argv[2];
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  userDataDir: path.join(os.tmpdir(), `tangle-labels-${Date.now()}`),
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
const shot = async (name) => { if (OUT) await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

// ---- Set up: a few callouts of each kind, in the muscle layer.
await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.setVisibleFigures('leader');
  const f = app.leader;
  document.getElementById('layer-mode').value = 'muscle';
  document.getElementById('layer-mode').dispatchEvent(new Event('change'));
  app.addLabel(f, 'bone', 'Femur', 'R');
  app.addLabel(f, 'bone', 'Humerus', 'R');
  app.addLabel(f, 'muscle', 'Rectus femoris', 'R');
  app.addLabel(f, 'joint', 'knee_R');
  app.requestRender();
});
await sleep(600);
await shot('01-labels');

// Where each pill was DRAWN, in page coordinates.
const pills = () => page.evaluate(() => {
  const app = window.__app;
  const gl = document.querySelector('#viewport canvas:not(#hud)');
  const hud = document.getElementById('hud');
  const r = gl.getBoundingClientRect();
  const k = r.width / hud.width;
  return (app.studio.lastLayout ?? []).filter((p) => p.box).map((p) => ({
    id: p.label.id, text: p.label.text, kind: p.label.kind, side: p.side,
    cx: r.left + (p.box.left + p.box.width / 2) * k,
    cy: r.top + (p.box.top + p.box.height / 2) * k,
    midX: r.left + (app.labels.mid ?? hud.width / 2) * k,
  }));
});
const drawn = await pills();
if (drawn.length !== 4) problems.push(`expected 4 callouts drawn, got ${drawn.length}`);
console.log(`--- drawn: ${drawn.map((p) => `${p.text}(${p.side})`).join(', ')}`);

// The hit box has to be the one on screen, not an export's.
const hitOK = await page.evaluate((p) => {
  const app = window.__app;
  const gl = document.querySelector('#viewport canvas:not(#hud)');
  const r = gl.getBoundingClientRect();
  // An export redraws every callout at 4K through the same code first.
  app.photoDataURL?.(2);
  const hit = app.studio.labelHit(p.cx - r.left, p.cy - r.top);
  return hit?.label?.id ?? null;
}, drawn[0]);
if (hitOK !== drawn[0].id) {
  problems.push(`labelHit missed the pill it drew (got ${hitOK}, wanted ${drawn[0].id}) — an export may have clobbered the live layout`);
}

// ---- 1. A REAL drag across the figure moves the callout to the other column.
const target = drawn.find((p) => p.kind === 'bone') ?? drawn[0];
const camBefore = await page.evaluate(() => window.__app.camera.position.toArray());
const toX = target.side === 'left' ? target.midX + 260 : target.midX - 260;
await page.mouse.move(target.cx, target.cy); // hover arms the grab
await sleep(140);
await page.mouse.down();
await page.mouse.move(toX, target.cy + 40, { steps: 14 });
await page.mouse.up();
await sleep(400);
const after = await page.evaluate((id) => {
  const app = window.__app;
  const at = app.studio.lastLayout.find((p) => p.label.id === id);
  return {
    side: at?.side, force: app.labels.byId(id)?.force,
    cam: app.camera.position.toArray(),
    status: document.getElementById('status-line')?.textContent ?? '',
  };
}, target.id);
const camMoved = Math.hypot(...after.cam.map((n, i) => n - camBefore[i]));
if (after.side === target.side) problems.push(`dragging "${target.text}" left it in the ${after.side} column`);
if (after.force !== after.side) problems.push(`the callout's column was not pinned (force ${after.force}, drawn ${after.side})`);
if (camMoved > 1e-4) problems.push(`dragging a callout orbited the camera (${camMoved.toFixed(3)} m)`);
console.log(`--- drag: "${target.text}" ${target.side} → ${after.side} (force ${after.force}), camera moved ${(camMoved * 1000).toFixed(1)} mm`);
console.log(`--- status: ${after.status.trim()}`);
await shot('02-dragged');

// A drag back returns it, so the gesture is not one-way.
const back = drawn.find((p) => p.id === target.id) ? await pills() : null;
const nowAt = back?.find((p) => p.id === target.id);
if (nowAt) {
  await page.mouse.move(nowAt.cx, nowAt.cy);
  await sleep(140);
  await page.mouse.down();
  await page.mouse.move(target.side === 'left' ? nowAt.midX - 260 : nowAt.midX + 260, nowAt.cy, { steps: 14 });
  await page.mouse.up();
  await sleep(350);
  const side2 = await page.evaluate((id) => window.__app.labels.byId(id)?.force, target.id);
  if (side2 !== target.side) problems.push(`dragging back put "${target.text}" in ${side2}, expected ${target.side}`);
  console.log(`--- drag back: ${side2}`);
}

// ---- 2. A REAL double-click opens the colour picker for that callout.
await page.evaluate(() => {
  const app = window.__app;
  app.__asked = null;
  app.ui.__m = app.ui.pickMuscleColor;
  app.ui.__l = app.ui.pickLabelColor;
  app.ui.pickMuscleColor = (names) => { app.__asked = { kind: 'muscle', names: [names].flat() }; };
  app.ui.pickLabelColor = (id) => { app.__asked = { kind: 'label', id }; };
});
const nowPills = await pills();
for (const want of ['muscle', 'bone']) {
  const p = nowPills.find((x) => x.kind === want);
  if (!p) { problems.push(`no ${want} callout to double-click`); continue; }
  await page.evaluate(() => { window.__app.__asked = null; });
  await page.mouse.move(p.cx, p.cy); // hover hands the cursor to the pill
  await sleep(120);
  await page.mouse.click(p.cx, p.cy);
  await page.mouse.click(p.cx, p.cy); // the second tap opens the picker
  await sleep(250);
  const asked = await page.evaluate(() => window.__app.__asked);
  if (!asked) { problems.push(`double-clicking the ${want} callout opened no colour picker`); continue; }
  if (want === 'muscle') {
    if (asked.kind !== 'muscle' || !asked.names.includes(p.text)) {
      problems.push(`the ${want} callout asked for ${JSON.stringify(asked)}, expected its belly`);
    }
  } else if (asked.kind !== 'label' || asked.id !== p.id) {
    problems.push(`the ${want} callout asked for ${JSON.stringify(asked)}, expected label ${p.id}`);
  }
  console.log(`--- double-click ${want} "${p.text}" → ${JSON.stringify(asked)}`);
}
await page.evaluate(() => {
  const app = window.__app;
  app.ui.pickMuscleColor = app.ui.__m;
  app.ui.pickLabelColor = app.ui.__l;
});

// ---- 3. A colour picked for a bone/joint callout is the pill's accent, and
// it survives the round trip through the saved form.
const colour = await page.evaluate(() => {
  const app = window.__app;
  const bone = app.labels.list.find((l) => l.kind === 'bone');
  const other = app.labels.list.find((l) => l.kind === 'joint');
  const before = app.labelAccent(bone.id);
  app.setLabelColor(bone.id, '#ff8800');
  // Read both back BEFORE the round trip below throws these ids away.
  const after = app.labelAccent(bone.id);
  const neighbour = app.labelAccent(other.id);
  const json = app.labels.toJSON();
  const saved = json.find((r) => r.text === bone.text)?.color ?? null;
  app.clearLabels();
  app.labels.fromJSON(json);
  const back = app.labels.list.find((l) => l.text === bone.text);
  return { before, after, saved, neighbour, restored: back ? app.labelAccent(back.id) : null };
});
if (colour.after !== '#ff8800') problems.push(`the callout accent is ${colour.after}, expected the picked #ff8800`);
if (colour.saved !== '#ff8800') problems.push(`the colour was not saved with the label (${colour.saved})`);
if (colour.restored !== '#ff8800') problems.push(`the colour did not survive a reload of the slide (${colour.restored})`);
if (colour.neighbour === '#ff8800') problems.push('colouring one callout bled into another');
console.log(`--- colour: ${colour.before} → ${colour.after} · saved ${colour.saved} · restored ${colour.restored} · neighbour ${colour.neighbour}`);
await shot('03-coloured');

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All label-gesture checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
