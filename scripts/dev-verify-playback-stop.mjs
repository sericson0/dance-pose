// Dev check for STOPPING a keyframe playback — the Play ⇄ Stop toggle on both
// players (the movement Sequence and the A→B compare).
//
// What it pins, and why each one is here rather than assumed:
//  - the TOGGLE is a real click on the real button, and the button's own TEXT
//    is what is read: a stop that works while the button goes on reading
//    "▶ Play" is the bug the funnel in main.js (clearPlaying) exists to make
//    impossible, and a state-only check passes straight through it
//  - stop is a PAUSE: the dancers hold the pose they stopped in (proved by
//    comparing the serialized pose over the next ~600 ms, not by reading a
//    flag — a player that kept running would move them), seqT sits strictly
//    inside (0, 1), and the scrubber shows that same t
//  - Play RESUMES from there — sampled throughout, so a rewind-then-replay
//    that happens to end in the same place cannot pass — and a Play pressed at
//    the end starts again from the top
//  - onDone fires EXACTLY ONCE for a natural finish and NEVER for a stopped
//    run: it means "the movement finished", and a caller chaining work onto
//    the end of a playback must not have it run because the user pressed Stop
//  - the implicit stops: a REAL pointer grab of the scrubber mid-play, Escape,
//    a keyframe's Show, a preset, and an edit of a dancer
//  - an orbit of the camera must NOT stop it (the viewer is watching)
//  - Space toggles in Present mode and in the editor, and is inert while
//    typing into a field
//  - the two players are exclusive: starting A→B while the sequence plays
//    leaves BOTH buttons telling the truth
//  - deleting down to one keyframe mid-play resets the button (the chain it
//    was playing no longer exists)
//
// Usage: node scripts/dev-verify-playback-stop.mjs <outDir>   (dev server running)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2] || 'shots-playback-stop';
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173/';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tangle-verify-')),
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) problems.push(msg); };

// The Sequence section has to be ON SCREEN: every gesture below is a real
// click or drag, and you cannot press a button in a collapsed section on a tab
// that is not showing.
const build = await page.evaluate(() => {
  const app = window.__app;
  document.querySelector('#sidebar-tabs [data-tab="teach"]').click();
  const sec = document.getElementById('sequence-section');
  if (sec.classList.contains('collapsed')) sec.querySelector('.collapse-toggle').click();
  app.setSeqStates([]); // a restored session sequence would skew every count
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  return {
    n: app.seqStates.length,
    secs: app.seqSeconds(),
    label: document.getElementById('seq-play').textContent,
    disabled: document.getElementById('seq-play').disabled,
  };
});
console.log('--- build:', JSON.stringify(build));
check(build.n === 3, `expected 3 keyframes, got ${build.n}`);
check(build.label === '▶ Play', `idle button reads ${JSON.stringify(build.label)}, want "▶ Play"`);
check(!build.disabled, 'Play is disabled with 3 keyframes');

// ---- 1. Play → the button flips to Stop -----------------------------------
await page.click('#seq-play');
await sleep(900);
const playing = await page.evaluate(() => ({
  playing: window.__app.seqPlaying,
  t: window.__app.seqT,
  label: document.getElementById('seq-play').textContent,
}));
console.log('--- playing:', JSON.stringify(playing));
check(playing.playing, 'the click did not start playback');
check(playing.label === '■ Stop', `playing button reads ${JSON.stringify(playing.label)}, want "■ Stop"`);
check(playing.t > 0 && playing.t < 1, `mid-play t is ${playing.t}, want strictly inside (0,1)`);
await page.screenshot({ path: `${outDir}/playing.png` });

// ---- 2. Stop → a PAUSE, not a rewind --------------------------------------
await page.click('#seq-play');
const stopped = await page.evaluate(() => {
  const app = window.__app;
  const el = document.getElementById('seq-play');
  return {
    playing: app.seqPlaying,
    t: app.seqT,
    label: el.textContent,
    pose: JSON.stringify(app.leader.getPose()),
    slider: Number(document.getElementById('seq-slider').value),
    val: document.getElementById('seq-val').textContent,
  };
});
// The dancers really stopped: the same serialized pose ~600 ms later. A flag
// says the player was switched off; this says nothing is still moving them.
await sleep(600);
const held = await page.evaluate(() => ({
  pose: JSON.stringify(window.__app.leader.getPose()),
  t: window.__app.seqT,
}));
console.log('--- stopped:', JSON.stringify({ ...stopped, pose: `${stopped.pose.length} chars` }));
check(!stopped.playing, 'the second click did not stop playback');
check(stopped.label === '▶ Play', `stopped button reads ${JSON.stringify(stopped.label)}, want "▶ Play"`);
check(stopped.t > 0.01 && stopped.t < 0.99, `stopped at t=${stopped.t}, want strictly inside (0,1)`);
check(held.pose === stopped.pose, 'the pose kept changing after the stop — it did not really stop');
check(held.t === stopped.t, `t moved after the stop (${stopped.t} → ${held.t})`);
check(Math.abs(stopped.slider - Math.round(stopped.t * 1000)) <= 1,
  `the scrubber shows ${stopped.slider}/1000, but t is ${stopped.t}`);
await page.screenshot({ path: `${outDir}/stopped.png` });

// An ORBIT of the camera must not stop anything — the viewer is watching. Run
// it here, where nothing is playing, only to prove the drag itself is inert;
// the live case is checked further down.
// ---- 3. Play again RESUMES from the scrubber ------------------------------
const resumed = await page.evaluate(async (stopT) => {
  const app = window.__app;
  document.getElementById('seq-play').click();
  let min = Infinity;
  const t0 = performance.now();
  while (app.seqPlaying && performance.now() - t0 < 20000) {
    min = Math.min(min, app.seqT);
    await new Promise((r) => setTimeout(r, 30));
  }
  return {
    min, end: app.seqT, playing: app.seqPlaying,
    label: document.getElementById('seq-play').textContent,
    dipped: min < stopT - 0.02,
  };
}, stopped.t);
console.log('--- resume:', JSON.stringify(resumed));
check(!resumed.dipped, `Play rewound: t dipped to ${resumed.min} from a stop at ${stopped.t}`);
check(resumed.end >= 1, `resumed run ended at t=${resumed.end}, want 1`);
check(!resumed.playing, 'the resumed run never finished');
check(resumed.label === '▶ Play', `after a natural finish the button reads ${JSON.stringify(resumed.label)}`);

// ---- 4. Play at the END restarts from the top -----------------------------
const restart = await page.evaluate(async () => {
  const app = window.__app;
  document.getElementById('seq-play').click(); // t is 1 here
  await new Promise((r) => setTimeout(r, 400));
  const early = app.seqT;
  app.stopSeq();
  return { early, playing: app.seqPlaying };
});
console.log('--- restart at the end:', JSON.stringify(restart));
check(restart.early < 0.5, `Play at t=1 resumed at ${restart.early} instead of restarting from 0`);

// ---- 5. onDone: once for a finish, never for a stop -----------------------
const done = await page.evaluate(async () => {
  const app = window.__app;
  let stopCount = 0;
  app.playSeq(null, () => { stopCount++; }, { from: 0 });
  await new Promise((r) => setTimeout(r, 500));
  app.stopSeq();
  await new Promise((r) => setTimeout(r, 600)); // …and it must not fire late
  let finishCount = 0;
  await new Promise((res) => app.playSeq(null, () => { finishCount++; res(); }, { from: 0.9 }));
  await new Promise((r) => setTimeout(r, 400));
  return { stopCount, finishCount, t: app.seqT };
});
console.log('--- onDone:', JSON.stringify(done));
check(done.stopCount === 0, `onDone fired ${done.stopCount}× for a STOPPED run, want 0`);
check(done.finishCount === 1, `onDone fired ${done.finishCount}× for a natural finish, want exactly 1`);

// ---- 6. Grabbing the scrubber mid-play stops it (a REAL pointer press) -----
const grab = await page.evaluate(() => {
  window.__app.playSeq(null, null, { from: 0 });
  const r = document.getElementById('seq-slider').getBoundingClientRect();
  return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.5 };
});
await sleep(500);
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(grab.x + 30, grab.y, { steps: 4 });
await page.mouse.up();
await sleep(300);
const afterGrab = await page.evaluate(() => ({
  playing: window.__app.seqPlaying,
  t: window.__app.seqT,
  label: document.getElementById('seq-play').textContent,
}));
console.log('--- scrubber grab:', JSON.stringify(afterGrab));
check(!afterGrab.playing, 'a real scrubber drag did not stop the player — the two are fighting for t');
check(afterGrab.label === '▶ Play', `after the grab the button reads ${JSON.stringify(afterGrab.label)}`);

// ---- 7. Escape stops it, and says so --------------------------------------
await page.evaluate(() => window.__app.playSeq(null, null, { from: 0 }));
await sleep(400);
await page.keyboard.press('Escape');
await sleep(150);
const esc = await page.evaluate(() => ({
  playing: window.__app.seqPlaying,
  t: window.__app.seqT,
  status: document.getElementById('status-line').textContent,
  label: document.getElementById('seq-play').textContent,
}));
console.log('--- escape:', JSON.stringify(esc));
check(!esc.playing, 'Escape did not stop the playback');
check(esc.t > 0 && esc.t < 1, `Escape left t at ${esc.t} — it should pause where it was`);
check(/stopped/i.test(esc.status), `Escape said ${JSON.stringify(esc.status)} — it must report like its siblings`);
check(esc.label === '▶ Play', `after Escape the button reads ${JSON.stringify(esc.label)}`);

// ---- 8. the things that used to FIGHT the player --------------------------
// Each poses the couple outright; a player left running would overwrite it on
// the very next frame, so the gesture has to stop it.
const fights = await page.evaluate(async () => {
  const app = window.__app;
  const out = {};
  const run = async (name, fn) => {
    app.playSeq(null, null, { from: 0 });
    await new Promise((r) => setTimeout(r, 300));
    fn();
    await new Promise((r) => setTimeout(r, 120));
    out[name] = app.seqPlaying;
    app.stopSeq();
  };
  await run('show', () => app.seqApply(0));            // a keyframe's Show
  await run('preset', () => app.applyPreset(3));        // a preset
  await run('edit', () => app.editJoint(app.leader, 'knee_L', () => {
    app.leader.nodes.knee_L.rotation.x = 0.5;
  }));                                                  // posing a dancer
  await run('undo', () => app.undo());                  // an undo
  // …and the two that must NOT stop it. (1) Moving the camera to watch
  // better: looking is not editing.
  app.playSeq(null, null, { from: 0 });
  await new Promise((r) => setTimeout(r, 250));
  app.setView('side');
  app.requestRender();
  await new Promise((r) => setTimeout(r, 200));
  out.orbit = app.seqPlaying;
  app.stopSeq();
  // (2) The COUPLE CONSTRAINTS, which re-solve the embrace and resolve
  // collision on EVERY frame of the playback. The stop is hung on markEdit,
  // the choke point every pose-mutating path calls — so a constraint that
  // reached it would make the player stop itself a frame or two in, and the
  // symptom would be "Play only works with the embrace off".
  app.setEmbrace({ hands: true, close: true });
  app.playSeq(null, null, { from: 0 });
  await new Promise((r) => setTimeout(r, 900));
  out.constraints = app.seqPlaying;
  out.constraintT = app.seqT;
  app.stopSeq();
  app.setEmbrace({ hands: false, close: false });
  return out;
});
console.log('--- implicit stops:', JSON.stringify(fights));
for (const k of ['show', 'preset', 'edit', 'undo']) {
  check(fights[k] === false, `${k} did not stop the player — it fights it frame by frame`);
}
check(fights.orbit === true, 'moving the camera stopped the playback — looking is not editing');
check(fights.constraints === true,
  `the couple constraints stopped the player at t=${fights.constraintT} — a per-frame constraint is reaching markEdit`);

// ---- 9. deleting down to one keyframe mid-play ----------------------------
const shrunk = await page.evaluate(async () => {
  const app = window.__app;
  app.playSeq(null, null, { from: 0 });
  await new Promise((r) => setTimeout(r, 250));
  app.seqDelete(2);
  app.seqDelete(1);
  await new Promise((r) => setTimeout(r, 120));
  const el = document.getElementById('seq-play');
  return { playing: app.seqPlaying, label: el.textContent, disabled: el.disabled, n: app.seqStates.length };
});
console.log('--- shrunk to one keyframe:', JSON.stringify(shrunk));
check(!shrunk.playing, 'the player kept running on a chain with one keyframe');
check(shrunk.label === '▶ Play' && shrunk.disabled,
  `one keyframe left the button ${JSON.stringify(shrunk.label)} / disabled=${shrunk.disabled}`);

// ---- 10. the A→B player: the same stop, resume and exclusivity ------------
const ab = await page.evaluate(async () => {
  const app = window.__app;
  document.querySelector('#sidebar-tabs [data-tab="measure"]')?.click();
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();        // a sequence to be exclusive with
  app.applyPreset(0);
  document.getElementById('snap-a').click();
  app.applyPreset(2);
  document.getElementById('snap-b').click();
  const play = document.getElementById('interp-play');
  play.click();
  await new Promise((r) => setTimeout(r, 900));
  const mid = { playing: app.interpPlaying, t: app.interpT, label: play.textContent };
  play.click(); // …the Stop
  const stop = {
    playing: app.interpPlaying, t: app.interpT, label: play.textContent,
    pose: JSON.stringify(app.leader.getPose()),
    slider: Number(document.getElementById('interp-slider').value),
  };
  await new Promise((r) => setTimeout(r, 500));
  const still = JSON.stringify(app.leader.getPose()) === stop.pose;
  // Resume, sampling all the way: never behind where it stopped.
  play.click();
  let min = Infinity;
  const t0 = performance.now();
  while (app.interpPlaying && performance.now() - t0 < 15000) {
    min = Math.min(min, app.interpT);
    await new Promise((r) => setTimeout(r, 30));
  }
  const after = { min, end: app.interpT, label: play.textContent };
  // Exclusivity: starting A→B while the sequence plays must leave BOTH
  // buttons telling the truth, not just the one that was pressed.
  app.playSeq(null, null, { from: 0 });
  await new Promise((r) => setTimeout(r, 250));
  play.click();
  await new Promise((r) => setTimeout(r, 200));
  const both = {
    seq: app.seqPlaying, interp: app.interpPlaying,
    seqLabel: document.getElementById('seq-play').textContent,
    interpLabel: play.textContent,
  };
  app.stopPlayback();
  return { mid, stop, still, after, both, anyLeft: app.seqPlaying || app.interpPlaying };
});
console.log('--- A→B:', JSON.stringify({ ...ab, stop: { ...ab.stop, pose: `${ab.stop.pose.length} chars` } }));
check(ab.mid.playing && ab.mid.label === '■ Stop', `A→B playing button reads ${JSON.stringify(ab.mid.label)}`);
check(!ab.stop.playing && ab.stop.label === '▶ Play A→B', `A→B stopped button reads ${JSON.stringify(ab.stop.label)}`);
check(ab.stop.t > 0.01 && ab.stop.t < 0.99, `A→B stopped at t=${ab.stop.t}, want strictly inside (0,1)`);
check(ab.still, 'the A→B stop did not hold the pose');
check(Math.abs(ab.stop.slider - Math.round(ab.stop.t * 1000)) <= 1,
  `the A→B scrubber shows ${ab.stop.slider}/1000, but t is ${ab.stop.t}`);
check(ab.after.min >= ab.stop.t - 0.02, `A→B Play rewound to ${ab.after.min} from a stop at ${ab.stop.t}`);
check(ab.after.end >= 1 && ab.after.label === '▶ Play A→B', `A→B did not finish cleanly: ${JSON.stringify(ab.after)}`);
check(ab.both.interp && !ab.both.seq, `one player at a time failed: ${JSON.stringify(ab.both)}`);
check(ab.both.seqLabel === '▶ Play' && ab.both.interpLabel === '■ Stop',
  `the two buttons disagree with the players: ${JSON.stringify(ab.both)}`);
check(!ab.anyLeft, 'stopPlayback left something playing');

// ---- 11. a video capture LOCKS Play (it owns the player for its length) ---
// Stopping a RECORDING is another feature's job; what this pins is that Play
// cannot be pressed into the middle of one, since the capture is driving the
// very same chain and the two would write the pose on alternate frames.
const locked = await page.evaluate(async () => {
  const app = window.__app;
  const origURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => origURL(b);
  HTMLAnchorElement.prototype.click = () => {}; // no real download in headless
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.seqSetDuration(0, 0.5);
  app.playSeq(null, null, { from: 0 }); // …and a capture stops a running player
  await new Promise((r) => setTimeout(r, 200));
  const started = app.recordPlayback(app.seqStates, 'verify-stop');
  const during = {
    started,
    seqPlaying: app.seqPlaying,
    seqDisabled: document.getElementById('seq-play').disabled,
    interpDisabled: document.getElementById('interp-play').disabled,
  };
  const t0 = performance.now();
  while (app.recording && performance.now() - t0 < 25000) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ...during, after: document.getElementById('seq-play').disabled, finished: !app.recording };
});
console.log('--- capture locks Play:', JSON.stringify(locked));
check(locked.started, 'recordPlayback refused to start');
check(!locked.seqPlaying, 'the capture did not stop the running player it was about to drive');
check(locked.seqDisabled && locked.interpDisabled, 'the ▶ buttons stayed live during a capture');
check(locked.finished && !locked.after, 'the ▶ button stayed locked after the capture');

// ---- 12. Space: a toggle in Present mode, and in the editor ---------------
await page.evaluate(() => {
  const app = window.__app;
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.enterPresent();
  document.activeElement?.blur?.();
});
await sleep(400);
await page.keyboard.press('Space');
await sleep(400);
const spaceOn = await page.evaluate(() => ({ playing: window.__app.seqPlaying, t: window.__app.seqT }));
await page.keyboard.press('Space');
await sleep(200);
const spaceOff = await page.evaluate(() => {
  const app = window.__app;
  const st = { playing: app.seqPlaying, t: app.seqT, pose: JSON.stringify(app.leader.getPose()) };
  app.exitPresent();
  return st;
});
console.log('--- present Space:', JSON.stringify({ on: spaceOn, off: { ...spaceOff, pose: undefined } }));
check(spaceOn.playing, 'Space did not start playback in Present mode');
check(!spaceOff.playing, 'Space did not stop playback in Present mode — it is play-only');
check(spaceOff.t > 0 && spaceOff.t < 1, `Present Space stopped at t=${spaceOff.t}, want inside (0,1)`);

await sleep(300);
await page.evaluate(() => document.activeElement?.blur?.());
await page.keyboard.press('Space');
await sleep(400);
const editorSpace = await page.evaluate(() => ({ playing: window.__app.seqPlaying }));
await page.keyboard.press('Space');
await sleep(200);
const editorSpaceOff = await page.evaluate(() => ({
  playing: window.__app.seqPlaying,
  status: document.getElementById('status-line').textContent,
}));
console.log('--- editor Space:', JSON.stringify({ on: editorSpace, off: editorSpaceOff }));
check(editorSpace.playing, 'Space did not start playback outside Present mode');
check(!editorSpaceOff.playing, 'Space did not stop playback outside Present mode');

// …and it is INERT while typing: a keyframe label is full of spaces. The row
// has to be SHOWING for this to mean anything — a field in a section on
// another tab is display:none and cannot take focus at all, which would make
// the check pass for the wrong reason (it would be testing the body again).
const typed = await page.evaluate(() => {
  const app = window.__app;
  document.querySelector('#sidebar-tabs [data-tab="teach"]').click();
  const sec = document.getElementById('sequence-section');
  if (sec.classList.contains('collapsed')) sec.querySelector('.collapse-toggle').click();
  app.playSeq(null, null, { from: 0 });
  const field = document.querySelector('#seq-list [data-field="name"]');
  field.value = '';
  field.focus();
  return document.activeElement === field;
});
await page.keyboard.type('ocho cortado');
await sleep(150);
const typing = await page.evaluate(() => ({
  playing: window.__app.seqPlaying,
  text: document.querySelector('#seq-list [data-field="name"]').value,
}));
await page.evaluate(() => window.__app.stopPlayback());
console.log('--- typing a label:', JSON.stringify({ ...typing, focused: typed }));
check(typed, 'the keyframe label field could not take focus — this check would be vacuous');
check(typing.playing, 'typing a space into a keyframe label stopped the playback');
check(typing.text === 'ocho cortado', `the label took ${JSON.stringify(typing.text)} — Space was swallowed`);

await page.screenshot({ path: `${outDir}/final.png` });

console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'No console errors.');
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(` - ${p}`);
} else {
  console.log('\nAll playback-stop checks passed.');
}
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
