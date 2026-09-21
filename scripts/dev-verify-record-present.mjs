// Dev check for RECORDING A SEQUENCE IN PRESENT MODE — app.recordPlayback
// (both ⏺ buttons) enters Present for the duration of the capture, so the
// joint pick spheres and the rest of the editing chrome are not in the file.
//
// THE MEASUREMENT IS THE POINT. A flag check ("picksVisible is false") passes
// straight through the whole class of bug this guards, exactly as CLAUDE.md's
// "Fade others" tale records for muscle opacity — so the spheres are counted
// in the PIXELS of the canvas MediaRecorder is actually capturing
// (studio.recorder.canvas, which studio.renderFrame composites GL + overlay
// into every frame). It is a DIFFERENCE, taken on that one canvas:
//
//   offRef = the frame with the spheres explicitly hidden
//   onRef  = the same frame, same pose, same camera, spheres forced visible
//   live   = the frame as the recording actually composited it
//
// All three are rendered synchronously inside one page.evaluate, so nothing
// but the spheres can differ between them. `onRef vs offRef` is the POSITIVE
// CONTROL — it proves this camera and this view can see the spheres at all,
// so a zero elsewhere means "gone", not "never measurable". `live vs offRef`
// is the gate: ~0 means the recorded frame IS the sphere-free one.
// Verified to FAIL with the enterPresent() call removed from recordPlayback:
// `live` then equals `onRef` and the gate reads tens of thousands of pixels.
//
// Then the state machine around it: presenting during the capture and back to
// exactly what it found afterwards (frame, mode, sphere opacity); a recording
// started while ALREADY presenting leaves Present on; app.stopRecording()
// mid-take yields a NON-EMPTY file (a stop that discards is never the answer)
// while a stop during the encoder's ARMING wait writes nothing and says so;
// Esc during a recording stops the RECORDING rather than only leaving Present
// — measured as the take ENDING EARLY, because reading app.presenting straight
// after the key is a coin toss and not a measurement; the presenter keys are
// inert while a capture runs (a remote's click must not swap the slide
// mid-video); the captured frame is 1920×1080; and the MP4 → WebM retry HOLDS
// Present across its seam, counted in enterPresent calls (1, not 3) because a
// flicker between two takes is exactly what a poll is too coarse to catch.
//
// Usage: node scripts/dev-verify-record-present.mjs <outDir>  (dev server up)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2] || 'shots-record-present';
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173/';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tangle-recpresent-')),
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every download in this run is intercepted rather than written to disk: the
// blob's SIZE is what we are after (an unwarmed MP4 session writes zero bytes
// with no error — see warmUpMp4 in studio.js), and a headless browser has
// nowhere useful to put the file anyway.
await page.evaluate(() => {
  window.__files = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => {
    if (b instanceof Blob && /video\//.test(b.type)) window.__files.push({ type: b.type, size: b.size });
    return orig(b);
  };
  HTMLAnchorElement.prototype.click = function noDownload() {};
});

// The spheres are only drawn in skeleton / muscle view, so ask for the view
// where they are visible at rest — that is the whole premise of the check.
const setLayer = (m) => page.evaluate((mode) => {
  const el = document.getElementById('layer-mode');
  el.value = mode;
  el.dispatchEvent(new Event('change'));
}, m);

const state = () => page.evaluate(() => ({
  presenting: window.__app.presenting,
  cls: document.getElementById('app').classList.contains('presenting'),
  frame: document.getElementById('frame-mode').value,
  mode: window.__app.mode,
  recording: !!window.__app.recording,
  recPresent: window.__app.recPresent ? { ...window.__app.recPresent } : null,
  picks: Math.max(...window.__app.leader.pickSpheres.map((s) => s.material.opacity)),
  sidebar: document.getElementById('sidebar').offsetParent !== null,
  files: window.__files.length,
}));

// ---- setup: a short keyframe chain in skeleton view, nothing else on screen
await setLayer('skeleton');
await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.clearDrawings();
  app.setSeqStates([]);
  localStorage.removeItem('tangoPoseStudio.sequence.v1');
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(3); app.seqAdd();
  app.applyPreset(0); app.seqAdd();
  for (let i = 0; i < app.seqStates.length; i++) app.seqSetDuration(i, 3);
  // Slides for the presenter-key check further down.
  for (const [i, name] of ['One', 'Two', 'Three'].entries()) {
    app.applyPreset(i);
    document.getElementById('pose-name').value = name;
    document.getElementById('pose-save').click();
  }
  app.applySeqT(0);
});
await sleep(800);

const before = await state();
console.log('--- before recording:', JSON.stringify(before));
if (before.presenting) problems.push('the app started already presenting');
if (Math.abs(before.picks - 0.22) > 1e-6) {
  problems.push(`the pick spheres are not drawn before recording (opacity ${before.picks}) — nothing to remove`);
}

// The three-way pixel difference, taken mid-capture on the recorder's own
// canvas. Returned as counts of pixels differing by more than 8 on any
// channel; 8 rather than 0 because the GL canvas is re-rendered between reads
// and antialiasing is not bit-exact.
const PIXELS = `
  const grab = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const differing = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8
        || Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
    }
    return n;
  };
  const spherePixels = () => {
    const app = window.__app;
    const canvas = app.studio.recorder.canvas;
    const was = app.figures.map((f) => f.picksVisible);
    // As the recording actually composited it. Re-render first so 'live' is
    // produced by the same code path as the two references below.
    app.studio.renderFrame();
    const live = grab(canvas);
    app.figures.forEach((f) => f.setPickVisible(false));
    app.studio.renderFrame();
    const off = grab(canvas);
    app.figures.forEach((f) => f.setPickVisible(true));
    app.studio.renderFrame();
    const on = grab(canvas);
    app.figures.forEach((f, i) => f.setPickVisible(was[i]));
    app.studio.renderFrame(); // leave the take as the recording had it
    return {
      control: differing(on, off),   // positive control: can this view see them?
      leak: differing(live, off),    // the gate: is the recorded frame sphere-free?
      w: canvas.width,
      h: canvas.height,
    };
  };
`;

// Poll rather than sleep: headless Chrome throttles rAF to near zero while an
// on-demand-render app idles, and the H.264 encoder can take ~5.5 s to wake on
// a page's first recording.
const START_AND_SAMPLE = `
  (async () => { ${PIXELS}
    const app = window.__app;
    const started = app.recordPlayback(app.seqStates, 'verify-record-present');
    const t0 = performance.now();
    while (!app.studio.recorder && performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!app.studio.recorder) return { started, armed: false };
    await new Promise((r) => setTimeout(r, 600)); // a few frames into the take
    return { started, armed: true, ...spherePixels(), presenting: app.presenting };
  })()
`;

// ---- 1. the capture itself: Present is on, and the frame carries no spheres
const run1 = await page.evaluate(START_AND_SAMPLE);
console.log('--- capture 1 (entered Present for it):', JSON.stringify(run1));
if (!run1.started) problems.push('recordPlayback refused to start');
if (!run1.armed) problems.push('the recorder never armed (H.264 warm-up?) — nothing below was measured');
else {
  if (!run1.presenting) problems.push('the capture is not running in Present mode');
  if (run1.control < 2000) {
    problems.push(`the positive control found only ${run1.control} sphere pixels — this view cannot see them, so the gate below proves nothing`);
  }
  if (run1.leak > run1.control * 0.05) {
    problems.push(`the recorded frame still carries the pick spheres: ${run1.leak} px differ from the sphere-free reference (control ${run1.control})`);
  }
  if (run1.w !== 1920 || run1.h !== 1080) {
    problems.push(`the captured frame is ${run1.w}×${run1.h}, expected 1920×1080 — the recorder started before the 16:9 resize landed`);
  }
}
const during = await state();
console.log('--- state during capture 1:', JSON.stringify(during));
if (!during.presenting || !during.cls) problems.push('#app.presenting is not set during the capture');
if (during.sidebar) problems.push('the sidebar is still on screen during the capture');
if (during.frame !== 'slide') problems.push(`the frame is "${during.frame}" during the capture, expected slide`);
if (during.picks !== 0) problems.push(`the pick spheres are still lit during the capture (opacity ${during.picks})`);
if (during.recPresent?.wasPresenting !== false) {
  problems.push(`recPresent should remember wasPresenting:false, got ${JSON.stringify(during.recPresent)}`);
}
await page.screenshot({ path: `${outDir}/recording-in-present.png` }).catch(() => {});

// ---- 2. …and it gives back exactly what it found
await page.waitForFunction(() => !window.__app.recording, { timeout: 40000 });
await sleep(700);
await setLayer('skeleton'); // the spheres' resting opacity is a skeleton-view question
await sleep(400);
const after = await state();
console.log('--- after capture 1:', JSON.stringify(after));
if (after.presenting || after.cls) problems.push('the capture left the app in Present mode');
if (after.recPresent !== null) problems.push('recPresent was not cleared when the capture ended');
if (!after.sidebar) problems.push('the chrome did not come back after the capture');
if (after.frame !== before.frame) problems.push(`frame is "${after.frame}" after the capture, expected "${before.frame}"`);
if (after.mode !== before.mode) problems.push(`mode is "${after.mode}" after the capture, expected "${before.mode}"`);
if (Math.abs(after.picks - 0.22) > 1e-6) {
  problems.push(`the pick spheres came back at opacity ${after.picks}, expected 0.22`);
}
if (after.files < 1) problems.push('the capture downloaded no file');
const file1 = await page.evaluate(() => window.__files[window.__files.length - 1]);
console.log('--- file from capture 1:', JSON.stringify(file1));
if (!file1 || !file1.size) problems.push('the capture wrote an empty file');

// ---- 3. started while ALREADY presenting: Present stays on afterwards
await page.evaluate(() => window.__app.enterPresent());
await sleep(600);
const run2 = await page.evaluate(START_AND_SAMPLE);
console.log('--- capture 2 (already presenting):', JSON.stringify(run2));
if (!run2.armed) problems.push('capture 2 never armed');
else if (run2.leak > run2.control * 0.05) {
  problems.push(`capture 2 carries the spheres (${run2.leak} px vs control ${run2.control})`);
}
const held = await page.evaluate(() => (window.__app.recPresent
  ? { ...window.__app.recPresent } : null));
if (held?.wasPresenting !== true) {
  problems.push(`a capture started while presenting should remember wasPresenting:true, got ${JSON.stringify(held)}`);
}

// …and while it runs, the presenter keys must not change the shot.
await page.evaluate(() => { window.__app.slideAt = 1; });
for (const k of ['ArrowRight', 'PageDown', 'ArrowLeft', 'Home']) await page.keyboard.press(k);
await sleep(400);
const deckDuring = await page.evaluate(() => ({
  at: window.__app.slideAt, recording: !!window.__app.recording,
}));
console.log('--- deck during a capture:', JSON.stringify(deckDuring));
if (deckDuring.at !== 1) {
  problems.push(`a presenter key changed the slide mid-capture (slideAt ${deckDuring.at}, expected 1)`);
}
if (!deckDuring.recording) problems.push('a presenter key stopped the capture');

await page.waitForFunction(() => !window.__app.recording, { timeout: 40000 });
await sleep(600);
const after2 = await state();
console.log('--- after capture 2:', JSON.stringify(after2));
if (!after2.presenting) problems.push('a capture started while presenting dropped out of Present when it ended');
if (after2.recPresent !== null) problems.push('recPresent survived capture 2');
await page.evaluate(() => window.__app.exitPresent());
await sleep(500);

// ---- 4. stopRecording() mid-take SAVES what it has
const filesBefore = await page.evaluate(() => window.__files.length);
const stopped = await page.evaluate(`
  (async () => {
    const app = window.__app;
    app.recordPlayback(app.seqStates, 'verify-record-stop');
    const t0 = performance.now();
    while (!app.studio.recorder && performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!app.studio.recorder) return { armed: false };
    await new Promise((r) => setTimeout(r, 900)); // a real take, then cut it short
    const t = app.recording.t;
    const ret = app.stopRecording();
    while (app.recording && performance.now() - t0 < 40000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    return { armed: true, ret, tAtStop: t, presenting: app.presenting };
  })()
`);
await sleep(600);
console.log('--- stopRecording mid-take:', JSON.stringify(stopped));
if (!stopped.armed) problems.push('the stop test never armed');
else {
  if (stopped.ret !== true) problems.push('stopRecording() returned false with a capture running');
  if (stopped.tAtStop >= 0.95) problems.push(`the capture had already reached t=${stopped.tAtStop} — it was not stopped EARLY`);
  if (stopped.presenting) problems.push('stopRecording left the app in Present mode');
}
const stopFiles = await page.evaluate(() => window.__files.slice(-1)[0]);
const stopCount = await page.evaluate(() => window.__files.length);
console.log('--- file from the stopped take:', JSON.stringify(stopFiles), `(files ${filesBefore} → ${stopCount})`);
if (stopCount <= filesBefore) problems.push('stopRecording discarded the take — no file was written');
else if (!stopFiles?.size) problems.push('stopRecording wrote an EMPTY file');
const afterStop = await state();
if (afterStop.presenting || afterStop.recording) problems.push('the stopped capture did not restore the app state');
if (afterStop.recPresent !== null) problems.push('recPresent survived the stop');

// stopRecording with nothing running is a no-op, not an error.
const idleStop = await page.evaluate(() => window.__app.stopRecording());
if (idleStop !== false) problems.push('stopRecording() with no capture returned something other than false');

// ---- 5. Esc during a recording stops the RECORDING, not just Present
const escFiles = await page.evaluate(() => window.__files.length);
const armed = await page.evaluate(`
  (async () => {
    const app = window.__app;
    app.recordPlayback(app.seqStates, 'verify-record-esc');
    const t0 = performance.now();
    while (!app.studio.recorder && performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 900));
    return { armed: !!app.studio.recorder, presenting: app.presenting, t: app.recording?.t ?? null };
  })()
`);
console.log('--- before Esc:', JSON.stringify(armed));
if (!armed.armed) problems.push('the Esc test never armed');
if (!armed.presenting) problems.push('the Esc test is not in Present mode');
// WHAT MAKES THIS "Esc STOPPED THE RECORDING" AND NOT "Esc LEFT PRESENT": the
// take ENDS EARLY. Escape was pressed ~0.9 s into a 9 s chain, so a handler
// that only called exitPresent would leave the recorder running for the other
// ~8 s (against a canvas whose render target had just been resized) and the
// file would land then. Timing the clear is deterministic where reading
// app.presenting straight after the key is not — MediaRecorder's flush and the
// Present hand-back both complete inside the CDP round trip about half the
// time, so that read is a coin toss, not a measurement.
const escAt = Date.now();
await page.keyboard.press('Escape');
await page.waitForFunction(() => !window.__app.recording, { timeout: 40000 });
const escMs = Date.now() - escAt;
console.log(`--- the capture ended ${escMs} ms after Esc (the chain had ~8 s left to run)`);
if (escMs > 3000) {
  problems.push(`the capture ran on for ${escMs} ms after Esc — the key left Present without stopping the recording`);
}
await sleep(700);
const afterEsc = await state();
const escCount = await page.evaluate(() => window.__files.length);
const escFile = await page.evaluate(() => window.__files.slice(-1)[0]);
console.log('--- after Esc:', JSON.stringify(afterEsc), 'file:', JSON.stringify(escFile));
if (escCount <= escFiles) problems.push('Esc during a recording discarded the take');
else if (!escFile?.size) problems.push('Esc during a recording wrote an EMPTY file');
// …and it is a SHORT take, not the whole chain: a stop that merely let the
// recording run to the end would land a file the size of capture 1's.
else if (file1?.size && escFile.size > file1.size * 0.5) {
  problems.push(`the Esc take is ${escFile.size} bytes against a full run's ${file1.size} — it was not cut short`);
}
if (afterEsc.presenting) problems.push('Esc during a recording left the app presenting');
if (afterEsc.recording) problems.push('Esc did not stop the recording');
await setLayer('skeleton');
await sleep(400);
const picksEnd = await page.evaluate(() => Math.max(...window.__app.leader.pickSpheres.map((s) => s.material.opacity)));
if (Math.abs(picksEnd - 0.22) > 1e-6) problems.push(`the pick spheres did not come back after Esc (opacity ${picksEnd})`);

// …and Esc with no recording still leaves Present, exactly as it always did.
await page.evaluate(() => window.__app.enterPresent());
await sleep(400);
await page.keyboard.press('Escape');
await sleep(500);
const escPlain = await page.evaluate(() => window.__app.presenting);
if (escPlain) problems.push('Esc no longer leaves Present mode when nothing is recording');

// ---- 6. A stop while the encoder is still ARMING cancels, with NO file.
// The H.264 encoder can take ~5.5 s to wake on a page's first recording, and
// until it does not one frame exists — so the honest answer to Esc there is to
// say so and write nothing, never to hand the user the zero-byte MP4 that
// warmUpMp4 exists to prevent. The arming window is instant on a warmed page,
// so it is held open here by stalling whenEncoderReady. Releasing it AFTER the
// cancel also proves the late wake-up cannot start a stray recorder against a
// job nobody is waiting for any more (recordPlayback's `this.recording !== job`).
const armingStop = await page.evaluate(async () => {
  const app = window.__app;
  const studio = app.studio;
  const real = studio.whenEncoderReady;
  let release;
  studio.whenEncoderReady = () => new Promise((r) => { release = r; });
  const filesAt = window.__files.length;
  app.recordPlayback(app.seqStates, 'verify-record-arming');
  const enteredNow = app.presenting;
  // Sampled, not read once: the point is that Present is HELD for the whole
  // arming wait, however long the encoder takes to wake.
  const held = [];
  for (let i = 0; i < 8; i++) {
    held.push(app.presenting);
    await new Promise((r) => setTimeout(r, 60));
  }
  const during = {
    arming: !!app.recording?.arming, rec: !!app.recording?.rec,
    enteredNow, droppedWhileArming: held.some((p) => !p),
  };
  const ret = app.stopRecording();
  const status = document.getElementById('status-line').textContent;
  release(true); // the encoder wakes up after the cancel — too late to matter
  await new Promise((r) => setTimeout(r, 800));
  studio.whenEncoderReady = real;
  return {
    ...during, ret, status,
    recording: !!app.recording, presenting: app.presenting,
    recPresent: app.recPresent, strayRecorder: !!studio.recorder,
    files: window.__files.length - filesAt,
  };
});
await sleep(400);
console.log('--- stop while ARMING:', JSON.stringify(armingStop));
if (!armingStop.arming || armingStop.rec) problems.push('the arming window was not held open — check 6 measured nothing');
else {
  if (!armingStop.enteredNow) problems.push('recordPlayback did not enter Present before the encoder wait');
  if (armingStop.droppedWhileArming) problems.push('Present mode was dropped while the encoder was still arming');
  if (armingStop.ret !== true) problems.push('stopRecording() returned false while arming');
  if (armingStop.files !== 0) problems.push(`cancelling an arming capture wrote ${armingStop.files} file(s) — an unwarmed take is zero bytes`);
  if (armingStop.recording) problems.push('cancelling while arming left the job in place');
  if (armingStop.strayRecorder) problems.push('the encoder woke after the cancel and started a recorder anyway');
  if (armingStop.presenting) problems.push('cancelling while arming left the app in Present mode');
  if (armingStop.recPresent !== null) problems.push('recPresent survived the cancel');
  if (!/cancel/i.test(armingStop.status)) {
    problems.push(`nothing told the user the take was cancelled (status "${armingStop.status}")`);
  }
}

// ---- 7. THE MP4 → WebM RETRY must not bounce out of Present and back in.
// A browser that advertises an H.264 encoder it cannot run writes zero bytes,
// and startRecorder answers with { retry: true } — which re-enters
// recordPlayback. Present mode has to be HELD across that seam: dropping it
// and re-entering would resize the render target between the two takes (and,
// worse, re-read `wasPresenting` from a state the first entry had already
// changed, stranding the user in Present when the capture finished).
// Counted in enterPresent calls, because "did it flicker" is otherwise a race.
// It cannot be provoked by asking nicely, so the retry is injected: the first
// startRecorder of this run answers { retry: true } and the second is real.
const retry = await page.evaluate(`
  (async () => {
    const app = window.__app;
    const studio = app.studio;
    let enters = 0, exits = 0;
    const e0 = app.enterPresent.bind(app), x0 = app.exitPresent.bind(app);
    app.enterPresent = (...a) => { enters++; return e0(...a); };
    app.exitPresent = (...a) => { exits++; return x0(...a); };
    const real = studio.startRecorder;
    let fired = false;
    const held = [];
    studio.startRecorder = (name, onDone) => {
      if (!fired) {
        fired = true;
        // The zero-byte MP4 answer, a tick later, as startRecorder's onstop gives it.
        setTimeout(() => onDone({ retry: true }), 200);
        return { stop() {}, ext: 'mp4' };
      }
      studio.startRecorder = real;
      return real(name, onDone);
    };
    const filesAt = window.__files.length;
    app.recordPlayback(app.seqStates, 'verify-record-retry');
    const t0 = performance.now();
    // Sample Present across the seam as well as counting the transitions.
    while ((app.recording || !fired) && performance.now() - t0 < 40000) {
      held.push(app.presenting);
      await new Promise((r) => setTimeout(r, 60));
    }
    app.enterPresent = e0;
    app.exitPresent = x0;
    studio.startRecorder = real;
    return {
      enters, exits, fired,
      droppedMidRetry: held.some((p) => !p),
      files: window.__files.length - filesAt,
      presenting: app.presenting,
      recPresent: app.recPresent,
    };
  })()
`);
await sleep(600);
console.log('--- MP4 → WebM retry:', JSON.stringify(retry));
if (!retry.fired) problems.push('the retry was never injected — check 6 measured nothing');
else {
  if (retry.enters !== 1) {
    problems.push(`the retry re-entered Present (enterPresent called ${retry.enters}×, expected 1) — the capture was resized mid-flight`);
  }
  if (retry.droppedMidRetry) problems.push('Present mode was dropped between the MP4 take and the WebM retry');
  if (retry.files < 1) problems.push('the retry produced no file');
  if (retry.presenting) problems.push('the app is still presenting after the retried capture finished');
  if (retry.recPresent !== null) problems.push('recPresent survived the retried capture');
}

await page.screenshot({ path: `${outDir}/after-recording.png` }).catch(() => {});
await page.evaluate(() => {
  window.__app.setSeqStates([]);
  window.__app.clearKeyframeExtras();
});

if (problems.length) console.log('\nPROBLEMS:\n- ' + problems.join('\n- '));
else console.log('\nAll record-in-Present checks passed.');
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length || problems.length ? 1 : 0);
