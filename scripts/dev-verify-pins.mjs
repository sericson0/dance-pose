// Dev check for contact pins (pins.js): a spot on each dancer held together
// through movement.
//  - arm pin: the follower's pinned hand tracks a spot on the leader's chest
//    while he slides away, arm-only (her body stays put) until out of reach
//  - leg pin (parada): the follower's foot follows the leader's foot through
//    a move, and never digs below the floor
//  - torso pin: the follower's whole body slides to hold the contact, and
//    the collision resolver still keeps the bodies apart
//  - authoring flow: two pinClicks make a pin, the sidebar lists it, âœ• and
//    Clear all release it
//
// Usage: node scripts/dev-verify-pins.mjs <outDir>   (dev server running)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-pins';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const problems = [];

// Shared page-side helpers.
await page.evaluate(() => {
  window.__frames = (n = 3) => new Promise((res) => {
    const step = (k) => (k <= 0 ? res() : requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
  window.__pinGap = (i) => {
    const a = window.__app;
    const pin = a.pins.pins[i];
    return a.pins.endWorld('leader', pin).distanceTo(a.pins.endWorld('follower', pin));
  };
});

// ---- arm pin: her hand rides a spot on his chest ----
const arm = await page.evaluate(async () => {
  const app = window.__app;
  const frames = window.__frames;
  const pinGap = window.__pinGap;
  app.applyPreset(0); // standing, couple facing each other
  app.clearPins();
  // Stand her within reach, then pin her right palm to his chest front.
  const H = app.leader.height;
  app.follower.group.position.copy(app.leader.group.position);
  app.follower.group.position.z += 0.40;
  app.follower.group.rotation.y = Math.PI;
  app.follower.group.updateMatrixWorld(true);
  app.addPin(
    { node: 'chest', local: [0, 0.02 * H, 0.075 * H] },
    { node: 'wrist_R', local: [0, -0.05 * app.follower.height, 0] },
  );
  await frames(4);
  const gapHeld = pinGap(0);
  const bodyBefore = app.follower.group.position.clone();
  // He shifts sideways: her arm should re-solve, her body should stay.
  app.leader.group.position.x += 0.12;
  app.leader.group.updateMatrixWorld(true);
  await frames(4);
  const gapAfterMove = pinGap(0);
  const bodyMoved = app.follower.group.position.distanceTo(bodyBefore);
  return { gapHeld, gapAfterMove, bodyMoved };
});
console.log('--- arm pin:', JSON.stringify(arm));
if (arm.gapHeld > 0.02) problems.push(`arm pin resting gap ${(arm.gapHeld * 100).toFixed(1)} cm`);
if (arm.gapAfterMove > 0.03) problems.push(`arm pin lost contact after a move (${(arm.gapAfterMove * 100).toFixed(1)} cm)`);
if (arm.bodyMoved > 0.02) problems.push(`arm pin moved the follower's body ${(arm.bodyMoved * 100).toFixed(1)} cm (want arm-only)`);
await page.screenshot({ path: `${outDir}/pin-arm.png` });

// ---- leg pin (parada): foot against foot ----
const leg = await page.evaluate(async () => {
  const app = window.__app;
  const frames = window.__frames;
  const pinGap = window.__pinGap;
  app.clearPins();
  app.applyPreset(0);
  app.follower.group.position.copy(app.leader.group.position);
  app.follower.group.position.z += 0.45; // his foot within her leg's floor reach
  app.follower.group.rotation.y = Math.PI;
  app.follower.group.updateMatrixWorld(true);
  const V = Object.getPrototypeOf(app.leader.group.position).constructor;
  app.addPin(
    { node: 'toes_R', local: [0, 0, 0.02 * app.leader.height] },
    { node: 'toes_L', local: [0, 0, 0.02 * app.follower.height] },
  );
  await frames(4);
  // The spots sit inside each other's shoe volume, so the pin settles where
  // the feet REST AGAINST each other (collision keeps surfaces apart) — hold
  // is judged by foot-to-foot contact, not spot coincidence.
  const gapHeld = pinGap(0);
  const footBefore = app.follower.worldPos('toes_L', new V()).clone();
  // He slides back: her pinned foot should chase his.
  app.leader.group.position.z -= 0.06;
  app.leader.group.updateMatrixWorld(true);
  await frames(4);
  const gapAfterMove = pinGap(0);
  const chased = footBefore.z - app.follower.worldPos('toes_L', new V()).z;
  const footLow = app.follower.footLowY('L');
  return { gapHeld, gapAfterMove, chased, footLow, clearance: app.bodyClearance() };
});
console.log('--- leg pin:', JSON.stringify(leg));
if (leg.gapHeld > 0.09) problems.push(`leg pin resting gap ${(leg.gapHeld * 100).toFixed(1)} cm`);
if (leg.gapAfterMove > leg.gapHeld + 0.04) problems.push(`leg pin lost the foot after a move (${(leg.gapAfterMove * 100).toFixed(1)} cm vs ${(leg.gapHeld * 100).toFixed(1)} resting)`);
if (leg.chased < 0.02) problems.push(`her pinned foot barely chased his (${(leg.chased * 100).toFixed(1)} cm of 6)`);
if (leg.footLow < -2e-3) problems.push(`leg pin dug the follower's sole ${(-leg.footLow * 1000).toFixed(1)} mm underground`);
if (leg.clearance < -0.005) problems.push(`leg pin interpenetrated the feet ${(-leg.clearance * 100).toFixed(1)} cm`);
await page.screenshot({ path: `${outDir}/pin-parada.png` });

// ---- torso pin: whole-body slide, collision still wins ----
const torso = await page.evaluate(async () => {
  const app = window.__app;
  const frames = window.__frames;
  const pinGap = window.__pinGap;
  app.clearPins();
  app.applyPreset(0);
  app.follower.group.position.copy(app.leader.group.position);
  app.follower.group.position.z += 0.6;
  app.follower.group.rotation.y = Math.PI;
  app.follower.group.updateMatrixWorld(true);
  const H = app.leader.height;
  app.addPin(
    { node: 'chest', local: [0, 0, 0.06 * H] },
    { node: 'chest', local: [0, 0, 0.06 * app.follower.height] },
  );
  await frames(6);
  const pin = app.pins.pins[0];
  const a = app.pins.endWorld('leader', pin);
  const b = app.pins.endWorld('follower', pin);
  const horizGap = Math.hypot(a.x - b.x, a.z - b.z);
  return { horizGap, clearance: app.bodyClearance() };
});
console.log('--- torso pin:', JSON.stringify(torso));
// The two chest-front spots sit inside the partner's ribcage volume, so the
// pin pulls until the torsos rest surface-on-surface (collision wins) — a
// small residual spot gap at ~zero clearance IS the held contact.
if (torso.horizGap > 0.10) problems.push(`torso pin left ${(torso.horizGap * 100).toFixed(1)} cm horizontal gap`);
if (torso.clearance > 0.01) problems.push(`torso pin never brought the bodies to contact (clearance ${(torso.clearance * 100).toFixed(1)} cm)`);
if (torso.clearance < -0.005) problems.push(`torso pin pushed bodies ${(-torso.clearance * 100).toFixed(1)} cm into each other`);

// ---- authoring flow + UI list ----
const ui = await page.evaluate(async () => {
  const app = window.__app;
  const frames = window.__frames;
  const pinGap = window.__pinGap;
  app.clearPins();
  app.setMode('pin');
  const V = Object.getPrototypeOf(app.leader.group.position).constructor;
  // First click on the leader's chest surfaceâ€¦
  const p1 = app.leader.worldPos('chest', new V());
  p1.z += 0.08;
  app.pinClick(app.leader, p1);
  const pendingShown = document.getElementById('pin-list').textContent.includes('First spot');
  // â€¦second on the follower's back.
  const p2 = app.follower.worldPos('chest', new V());
  p2.z -= 0.08;
  app.pinClick(app.follower, p2);
  const rows = document.querySelectorAll('#pin-list .pose-item').length;
  const label = document.querySelector('#pin-list .pose-item .name')?.textContent || '';
  const clearOn = !document.getElementById('pin-clear').disabled;
  document.querySelector('#pin-list .pose-item button').click(); // âœ•
  const afterDelete = app.pins.count();
  app.setMode('rotate');
  return { pendingShown, rows, label, clearOn, afterDelete };
});
console.log('--- authoring:', JSON.stringify(ui));
if (!ui.pendingShown) problems.push('pending first spot not shown in the sidebar');
if (ui.rows !== 1) problems.push(`pin list shows ${ui.rows} rows, want 1`);
if (!/Thoracic/.test(ui.label)) problems.push(`pin label "${ui.label}" missing joint names`);
if (!ui.clearOn) problems.push('Clear all button not armed');
if (ui.afterDelete !== 0) problems.push('âœ• did not release the pin');

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length || problems.length ? 1 : 0);

