// Dev check for PRESENT mode: the chrome goes away and the 16:9 frame takes
// the width the sidebar was using, the presenter keys (arrows / Page Up /
// Page Down, as a remote sends them) step the deck WITHOUT posing a dancer —
// those keys are otherwise bound to nudging a joint — the ends of the deck are
// walls rather than a wrap, and leaving restores the frame, the chrome and the
// mode. Honours DEV_URL (default http://localhost:5173).
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

const chrome = () => page.evaluate(() => {
  const vis = (id) => {
    const el = document.getElementById(id);
    return !!(el && el.offsetParent !== null);
  };
  const glCanvas = document.querySelector('#viewport canvas:not(#hud)');
  return {
    presenting: window.__app.presenting,
    cls: document.getElementById('app').classList.contains('presenting'),
    sidebar: vis('sidebar'),
    topbar: vis('topbar'),
    hint: vis('hint'),
    frame: document.getElementById('frame-mode').value,
    canvasW: glCanvas ? glCanvas.clientWidth : 0,
    mode: window.__app.mode,
    btn: document.getElementById('present-btn').textContent,
  };
});

// ---- 0. Three slides to step through, each with a distinguishable pose.
await page.evaluate(() => {
  const app = window.__app;
  for (const [i, name] of ['One', 'Two', 'Three'].entries()) {
    app.applyPreset(i);
    document.getElementById('pose-name').value = name;
    document.getElementById('pose-save').click();
  }
});
await sleep(500);
const deck = await page.evaluate(() => window.__app.slideNames());
if (deck.join() !== 'One,Two,Three') problems.push(`deck is [${deck}], expected [One,Two,Three]`);

// Measure the 16:9 frame BEFORE presenting with the frame already on, since in
// "fill window" the canvas is full-width anyway and the sidebar merely overlays
// it — comparing against that would prove nothing about sidebarWidth().
await page.evaluate(() => {
  const el = document.getElementById('frame-mode');
  el.value = 'slide';
  el.dispatchEvent(new Event('change'));
});
await sleep(500);
const framedWindowed = await chrome();

// Back to the real starting state, which the exit has to restore.
await page.evaluate(() => {
  const el = document.getElementById('frame-mode');
  el.value = 'window';
  el.dispatchEvent(new Event('change'));
});
await sleep(400);
const before = await chrome();
if (before.presenting) problems.push('app started already presenting');

// ---- 1. Enter: chrome hidden, 16:9 forced, frame widened by the sidebar's 320.
await page.click('#present-btn');
await sleep(600);
const on = await chrome();
if (!on.presenting || !on.cls) problems.push('entering did not set the presenting state/class');
if (on.sidebar) problems.push('the sidebar is still visible while presenting');
if (on.topbar) problems.push('the topbar is still visible while presenting');
if (on.hint) problems.push('the hint line is still visible while presenting');
if (on.frame !== 'slide') problems.push(`frame is ${on.frame} while presenting, expected slide`);
// The 16:9 frame should now claim the ~320px the sidebar was holding.
if (on.canvasW <= framedWindowed.canvasW) {
  problems.push(`the 16:9 frame did not widen (${framedWindowed.canvasW} → ${on.canvasW}px): sidebarWidth() is probably still a constant`);
}
console.log(`--- 16:9 frame: ${framedWindowed.canvasW}px windowed → ${on.canvasW}px presenting`);

// ---- 2. THE KEY TEST: presenter keys step the deck and pose nobody.
// ArrowRight/PageDown are bound to nudging a joint outside present mode, so a
// leaked keystroke would silently deform the dancer mid-lesson.
await page.evaluate(() => {
  const app = window.__app;
  app.slideAt = -1;
  app.selectJoint(app.leader, 'elbow_L'); // arm the nudge handler's target
});
await sleep(200);
const poseBefore = await page.evaluate(() => JSON.stringify(window.__app.leader.getPose()));

await page.keyboard.press('ArrowRight');
await sleep(400);
let at = await page.evaluate(() => ({ i: window.__app.slideAt, n: window.__app.slideNames()[window.__app.slideAt] }));
if (at.i !== 0) problems.push(`ArrowRight from the start went to index ${at.i}, expected 0`);

await page.keyboard.press('PageDown');
await sleep(400);
at = await page.evaluate(() => ({ i: window.__app.slideAt, n: window.__app.slideNames()[window.__app.slideAt] }));
if (at.i !== 1) problems.push(`PageDown went to index ${at.i}, expected 1`);

await page.keyboard.press('ArrowLeft');
await sleep(400);
at = await page.evaluate(() => ({ i: window.__app.slideAt }));
if (at.i !== 0) problems.push(`ArrowLeft went to index ${at.i}, expected 0`);

// The pose must now be slide One's, and must NOT be slide One's plus a nudge.
const poseAfter = await page.evaluate(() => JSON.stringify(window.__app.leader.getPose()));
await page.evaluate(() => window.__app.showSlide('One'));
await sleep(300);
const poseSlideOne = await page.evaluate(() => JSON.stringify(window.__app.leader.getPose()));
if (poseAfter !== poseSlideOne) {
  problems.push('after stepping the deck the pose is not exactly slide One — a presenter key leaked through to the nudge handler');
}
if (poseBefore === poseAfter) problems.push('stepping the deck did not change the pose at all');

// ---- 3. The ends are walls, not a wrap.
await page.evaluate(() => { window.__app.slideAt = 2; });
await page.keyboard.press('ArrowRight');
await sleep(300);
at = await page.evaluate(() => ({ i: window.__app.slideAt }));
if (at.i !== 2) problems.push(`ArrowRight past the last slide moved to ${at.i} — it should stay put, not wrap`);
await page.evaluate(() => { window.__app.slideAt = 0; });
await page.keyboard.press('ArrowLeft');
await sleep(300);
at = await page.evaluate(() => ({ i: window.__app.slideAt }));
if (at.i !== 0) problems.push(`ArrowLeft before the first slide moved to ${at.i} — it should stay put, not wrap`);

await page.screenshot({ path: `${process.argv[2] || '.'}/presenting.png` }).catch(() => {});

// ---- 4. Escape leaves and restores the frame, the chrome and the mode.
await page.keyboard.press('Escape');
await sleep(600);
const off = await chrome();
if (off.presenting || off.cls) problems.push('Escape did not leave present mode');
if (!off.sidebar || !off.topbar || !off.hint) problems.push('leaving did not bring the chrome back');
if (off.frame !== before.frame) problems.push(`frame is ${off.frame} after leaving, expected ${before.frame}`);
if (off.canvasW !== before.canvasW) problems.push(`frame width ${off.canvasW}px after leaving, expected ${before.canvasW}px`);
if (off.btn.includes('End')) problems.push('the Present button still reads "End" after leaving');

// ---- 5. Outside present mode the same keys nudge again, as they always did.
await page.evaluate(() => {
  const app = window.__app;
  app.selectJoint(app.leader, 'elbow_L');
});
await sleep(200);
const nudgeBefore = await page.evaluate(() => window.__app.leader.nodes.elbow_L.rotation.x);
await page.keyboard.press('ArrowUp');
await sleep(300);
const nudgeAfter = await page.evaluate(() => window.__app.leader.nodes.elbow_L.rotation.x);
if (Math.abs(nudgeAfter - nudgeBefore) < 1e-6) {
  problems.push('after leaving present mode the arrow keys no longer nudge — the capture handler is still swallowing them');
}

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All present-mode checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
