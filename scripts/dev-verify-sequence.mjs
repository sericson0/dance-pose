// Dev check for the movement sequence (multi-keyframe timeline), the WebM
// animation export, and the dissociation floor visual.
//  - sequence: add keyframes through the UI, scrub the slider (pose actually
//    interpolates), reorder/update/delete rows, play to the end, COG trail
//    covers every segment, export payload round-trips, localStorage persists
//  - record: MediaRecorder captures the sequence playback into a non-trivial
//    .webm blob and the ⏺ buttons lock while it runs
//  - dissociation: the checkbox shows per-dancer hip/shoulder axes + wedge,
//    and the wedge sweep matches the tangoStats dissociation angle
//
// Usage: node scripts/dev-verify-sequence.mjs <outDir>   (dev server running)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-sequence';
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

// ---- build a 3-keyframe sequence through the UI ----
const seq = await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqStates([]); // a restored session sequence would skew the counts
  const add = document.getElementById('seq-add');

  app.applyPreset(0); // standing
  add.click();
  app.applyPreset(1); // close embrace
  add.click();
  app.applyPreset(2); // walk
  add.click();

  const rows = document.querySelectorAll('#seq-list .pose-item').length;
  const rowHidden = document.getElementById('seq-row').hidden;
  const playDisabled = document.getElementById('seq-play').disabled;

  // Scrub to the middle of segment 2: the pose must move off keyframe 2.
  const chestBefore = app.leader.worldPos('chest').clone();
  app.applySeqT(0.75);
  const chestMid = app.leader.worldPos('chest').clone();
  app.applySeqT(0);
  const chestStart = app.leader.worldPos('chest').clone();
  return {
    n: app.seqStates.length,
    rows,
    rowHidden,
    playDisabled,
    scrubMoved: chestBefore.distanceTo(chestMid),
    backToStart: chestStart.distanceTo(chestMid) > 0.01,
    trailPts: (() => {
      // The COG trail should span all segments: 32·segs + 1 samples per line.
      const grp = app.scene.children.find((c) => c.children.some?.((l) => l.isLine && l.material.vertexColors));
      const line = grp?.children.find((l) => l.isLine && l.material.vertexColors);
      return line ? line.geometry.attributes.position.count : 0;
    })(),
    stored: (JSON.parse(localStorage.getItem('tangoPoseStudio.sequence.v1') || '[]')).length,
  };
});
console.log('--- sequence build:', JSON.stringify(seq));
if (seq.n !== 3 || seq.rows !== 3) problems.push(`expected 3 keyframes/rows, got ${seq.n}/${seq.rows}`);
if (seq.rowHidden || seq.playDisabled) problems.push('scrubber/play not armed with 3 keyframes');
if (seq.scrubMoved < 0.02) problems.push(`scrubbing barely moved the pose (${seq.scrubMoved.toFixed(3)} m)`);
if (!seq.backToStart) problems.push('t=0 did not return to the first keyframe');
if (seq.trailPts !== 65) problems.push(`trail has ${seq.trailPts} samples, want 65 (32·segs+1)`);
if (seq.stored !== 3) problems.push(`localStorage holds ${seq.stored} keyframes, want 3`);
await page.screenshot({ path: `${outDir}/sequence-panel.png` });

// ---- reorder / update / delete through the row buttons ----
const edit = await page.evaluate(() => {
  const app = window.__app;
  const rowBtns = (i) => document.querySelectorAll('#seq-list .pose-item')[i].querySelectorAll('button');
  const posOf = (s) => s.figures[0].position;
  const p0 = posOf(app.seqStates[0]);
  rowBtns(0)[3].click(); // ↓: move keyframe 1 later
  const movedDown = posOf(app.seqStates[1]);
  rowBtns(2)[4].click(); // ✕: delete the last keyframe
  const afterDelete = app.seqStates.length;
  app.applyPreset(3); // apilado
  rowBtns(0)[1].click(); // ⟳: overwrite keyframe 1 with the current pose
  const updated = posOf(app.seqStates[0]);
  const apilado = app.leader.getPose().position;
  return {
    swapOK: movedDown[0] === p0[0] && movedDown[2] === p0[2],
    afterDelete,
    updateOK: Math.hypot(updated[0] - apilado[0], updated[2] - apilado[2]) < 1e-9,
  };
});
console.log('--- sequence edit:', JSON.stringify(edit));
if (!edit.swapOK) problems.push('↓ did not swap keyframes');
if (edit.afterDelete !== 2) problems.push(`✕ left ${edit.afterDelete} keyframes, want 2`);
if (!edit.updateOK) problems.push('⟳ did not overwrite the keyframe with the current pose');

// ---- play to the end ----
const play = await page.evaluate(async () => {
  const app = window.__app;
  document.getElementById('seq-play').click();
  const t0 = performance.now();
  while (app.seqPlaying && performance.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { t: app.seqT, playing: app.seqPlaying, label: document.getElementById('seq-val').textContent };
});
console.log('--- sequence play:', JSON.stringify(play));
if (play.playing || play.t < 1) problems.push(`play did not finish (t=${play.t})`);
if (play.label !== '100%') problems.push(`label ended at ${play.label}, want 100%`);

// ---- export payload shape ----
const exp = await page.evaluate(() => {
  const app = window.__app;
  return { states: app.seqStates.length, figures: app.seqStates[0].figures.length };
});
if (exp.figures !== 2) problems.push('export states are not couple states');

// ---- record the sequence to a webm ----
const rec = await page.evaluate(async () => {
  window.__blobs = [];
  const origURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__blobs.push(b.size); return origURL(b); };
  HTMLAnchorElement.prototype.click = () => {}; // no real download in headless
  const app = window.__app;
  const started = app.recordPlayback(app.seqStates, 'verify-seq');
  const btnWhileBusy = document.getElementById('seq-record').disabled
    && document.getElementById('interp-record').disabled;
  const t0 = performance.now();
  while (app.recording && performance.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    started,
    btnWhileBusy,
    finished: !app.recording,
    blobKB: Math.round((window.__blobs[0] || 0) / 1024),
    btnAfter: document.getElementById('seq-record').disabled,
  };
});
console.log('--- record:', JSON.stringify(rec));
if (!rec.started) problems.push('recordPlayback refused to start');
if (!rec.btnWhileBusy) problems.push('⏺ buttons not locked during capture');
if (!rec.finished) problems.push('recording never stopped');
if (rec.blobKB < 5) problems.push(`webm blob only ${rec.blobKB} kB — capture likely empty`);
if (rec.btnAfter) problems.push('⏺ button still locked after capture');

// ---- dissociation visual ----
const dis = await page.evaluate(async () => {
  const app = window.__app;
  const frames = (n = 2) => new Promise((res) => {
    const step = (k) => (k <= 0 ? res() : requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
  app.setSeqStates([]);
  app.applyPreset(0); // standing
  app.leader.setJointDegrees({ chest: { y: 20 }, spine: { y: 8 } }); // author a twist
  document.getElementById('show-dissoc').click();
  await frames(); // the viz updates in the render loop
  // Find the two dissociation groups: each holds 2 lines + 1 wedge mesh.
  const groups = app.scene.children.filter((g) => g.isGroup
    && g.children.length === 3 && g.children.filter((c) => c.isLine).length === 2);
  const vis = groups.map((g) => g.visible);
  // Wedge sweep vs the stats twist, for the leader.
  const wedge = groups[0]?.children.find((c) => c.isMesh);
  let sweep = null;
  if (wedge) {
    const p = wedge.geometry.attributes.position;
    const c = { x: p.getX(0), z: p.getZ(0) };
    const a0 = Math.atan2(p.getZ(1) - c.z, p.getX(1) - c.x);
    const aN = Math.atan2(p.getZ(p.count - 1) - c.z, p.getX(p.count - 1) - c.x);
    sweep = Math.abs(((aN - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  }
  // The same world-space hip/shoulder yaw difference tangoStats reports.
  const yawOf = (l, r) => {
    const a = app.leader.worldPos(l).clone();
    const b = app.leader.worldPos(r);
    return Math.atan2(a.x - b.x, a.z - b.z) * 180 / Math.PI;
  };
  const raw = yawOf('shoulder_L', 'shoulder_R') - yawOf('hip_L', 'hip_R');
  const statDeg = Math.abs(((raw % 360) + 540) % 360 - 180);
  document.getElementById('show-dissoc').click(); // toggle back off
  await frames();
  const offAfter = groups.every((g) => !g.visible);
  return { found: groups.length, vis, sweep, statDeg, offAfter };
});
console.log('--- dissociation:', JSON.stringify(dis));
if (dis.found !== 2) problems.push(`found ${dis.found} dissociation groups, want 2`);
if (!dis.vis.every(Boolean)) problems.push('dissociation viz not visible with the checkbox on');
if (dis.statDeg < 10) problems.push(`authored twist only ${dis.statDeg.toFixed(1)}° — check the setup`);
if (dis.sweep === null || Math.abs(dis.sweep - dis.statDeg) > 6) {
  problems.push(`wedge sweep ${dis.sweep?.toFixed(1)}° vs stats twist ${dis.statDeg.toFixed(1)}°`);
}
if (!dis.offAfter) problems.push('dissociation viz still visible after unchecking');
await page.evaluate(() => {
  const app = window.__app;
  document.getElementById('show-dissoc').click();
  app.setView('top');
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${outDir}/dissociation-top.png` });

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length || problems.length ? 1 : 0);
