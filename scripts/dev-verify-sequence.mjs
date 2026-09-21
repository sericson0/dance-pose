// Dev check for the movement sequence (multi-keyframe timeline), the WebM
// animation export, and the dissociation floor visual.
//  - sequence: add keyframes through the UI, scrub the slider (pose actually
//    interpolates), reorder/update/delete rows, play to the end, COG trail
//    covers every segment, export payload round-trips, localStorage persists
//  - rows: the per-keyframe LABEL (set through app.seqSetName and through the
//    row's own input, shown in the row, surviving ⟳ and a page reload), and
//    the DRAG reorder — a REAL pointer drag of row 3 onto row 1 must produce
//    [3, 1, 2], the lift-and-drop, not the [2, 3, 1] a chain of swaps gives —
//    plus its keyboard fallback, Alt+↑/↓ on the focused row
//  - record: MediaRecorder captures the sequence playback into a non-trivial
//    .webm blob and the ⏺ buttons lock while it runs
//  - dissociation: the checkbox shows per-dancer hip/shoulder axes + wedge,
//    and the wedge sweep matches the tangoStats dissociation angle
//
// Usage: node scripts/dev-verify-sequence.mjs <outDir>   (dev server running)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-sequence';
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173/';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
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

// ---- reorder / update / delete through the row controls ----
// The rows carry no ↑/↓ buttons any more (the order is a drag, with Alt+↑/↓
// as the keyboard route), so each row's buttons are [Show, ⟳, ⧉, ✎, ✕] — ⧉
// duplicates the keyframe in place (dev-verify-seq-authoring.mjs owns what it
// does) and ✎ takes the per-keyframe edit focus (dev-verify-seq-focus.mjs owns
// that); here they only have to be in the row, in that place. The drawings tag
// has moved down to the extras line beside the muscle one (`.seq-draw-btn`).
const edit = await page.evaluate(() => {
  const app = window.__app;
  const rowBtns = (i) => document.querySelectorAll('#seq-list .pose-item')[i].querySelectorAll('button');
  const posOf = (s) => s.figures[0].position;
  const btnLabels = [...rowBtns(0)].map((b) => b.textContent);
  const p0 = posOf(app.seqStates[0]);
  app.seqMoveTo(0, 1); // the lift-and-drop the drag and the keys both call
  const movedDown = posOf(app.seqStates[1]);
  rowBtns(2)[4].click(); // ✕: delete the last keyframe
  const afterDelete = app.seqStates.length;
  app.applyPreset(3); // apilado
  rowBtns(0)[1].click(); // ⟳: overwrite keyframe 1 with the current pose
  const updated = posOf(app.seqStates[0]);
  const apilado = app.leader.getPose().position;
  return {
    btnLabels,
    swapOK: movedDown[0] === p0[0] && movedDown[2] === p0[2],
    afterDelete,
    updateOK: Math.hypot(updated[0] - apilado[0], updated[2] - apilado[2]) < 1e-9,
  };
});
console.log('--- sequence edit:', JSON.stringify(edit));
if (edit.btnLabels.join('') !== 'Show⟳⧉✎✕') problems.push(`row buttons are ${JSON.stringify(edit.btnLabels)}, want [Show, ⟳, ⧉, ✎, ✕]`);
if (!edit.swapOK) problems.push('seqMoveTo did not move a keyframe one place later');
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

// ---- per-keyframe TIMING: two numbers per keyframe — `move`, the seconds of
// transition from the previous keyframe INTO this one (the first keyframe has
// none), and `hold`, the seconds the couple then STAYS in this pose (every
// keyframe has one, the last included).
//
// The regression guard is the REDUCTION: with every hold 0 and every move
// equal, this has to reproduce the old equal-time-per-segment split exactly,
// so t = 0.5 of a three-keyframe chain still lands on the middle keyframe.
//
// Measured with EASING OFF, and set explicitly rather than assumed: a timeline
// begun from an empty list eases by default now (app.setSeqEase), and these
// are checks of the linear time → pose ARITHMETIC, which is what the reduction
// guard is about. dev-verify-seq-ease.mjs owns the eased case — including that
// ease off is still this arithmetic to the last bit.
const knee = (t) => page.evaluate((tt) => {
  const app = window.__app;
  app.applySeqT(tt);
  return app.leader.nodes.knee_L.rotation.x * 180 / Math.PI;
}, t);
const durSetup = await page.evaluate(() => {
  const app = window.__app;
  app.setSeqStates([]);
  app.setSeqEase(false);
  app.applyPreset(1);
  app.seqAdd();
  app.leader.setJointDegrees({ knee_L: { x: 70 } });
  app.seqAdd();
  app.leader.setJointDegrees({ knee_L: { x: 10 } });
  app.seqAdd();
  return {
    moves: app.seqStates.map((_, i) => app.seqTravel(i)),
    holds: app.seqStates.map((_, i) => app.seqHold(i)),
    total: app.seqSeconds(),
  };
});
console.log('--- timing defaults:', JSON.stringify(durSetup));
if (Math.abs(durSetup.total - 4.8) > 1e-9) problems.push(`default total ${durSetup.total}s, want 4.8 (two 2.4 s moves, no holds)`);
if (durSetup.holds.some((h) => h !== 0)) problems.push(`a new keyframe is born with a hold: ${JSON.stringify(durSetup.holds)} — the reduction to the old split is gone`);
const midEqual = await knee(0.5);
if (Math.abs(midEqual - 70) > 1.5) problems.push(`equal moves, no holds: t=0.5 gave knee ${midEqual.toFixed(1)}°, want the middle keyframe's 70°`);
const weighted = await page.evaluate(() => {
  const app = window.__app;
  app.seqSetTravel(1, 6); // 6 s into keyframe 2; keyframe 3 still takes 2.4
  return { total: app.seqSeconds(), travel: app.seqStates.map((_, i) => app.seqTravel(i)) };
});
if (Math.abs(weighted.total - 8.4) > 1e-9) problems.push(`weighted total ${weighted.total}s, want 8.4`);
// t = 0.5 of 8.4 s is 4.2 s, still 70% of the way through the FIRST segment.
const midWeighted = await knee(0.5);
const wantWeighted = 70 * (4.2 / 6);
if (Math.abs(midWeighted - wantWeighted) > 1.5) {
  problems.push(`weighted t=0.5 knee ${midWeighted.toFixed(1)}°, want ~${wantWeighted.toFixed(1)}° — the move is not weighting the timeline`);
}
// A HOLD on the middle keyframe: the pose must be byte-stable right across the
// hold's slice of t, and it must SHIFT where the later keyframe lands (which
// is the difference between a hold and a longer move).
const holdBand = await page.evaluate(async () => {
  const app = window.__app;
  app.seqSetTravel(1, 2.4); // back to equal moves: 2.4 + 2.4
  app.seqSetHold(1, 4.8);   // …and stand on keyframe 2 for 4.8 s. Total 9.6.
  const total = app.seqSeconds();
  const at = (t) => { app.applySeqT(t); return app.leader.nodes.knee_L.rotation.x; };
  // The hold runs from 2.4 s to 7.2 s of 9.6 → t ∈ [0.25, 0.75].
  const samples = [0.25, 0.3, 0.5, 0.7, 0.749].map(at);
  // …and exactly at the far edge the travel resumes, so t = 0.8 must have left.
  const after = at(0.8);
  return {
    total,
    spread: Math.max(...samples) - Math.min(...samples),
    held: samples[0] * 180 / Math.PI,
    after: after * 180 / Math.PI,
  };
});
console.log('--- hold band:', JSON.stringify(holdBand));
if (Math.abs(holdBand.total - 9.6) > 1e-9) problems.push(`hold total ${holdBand.total}s, want 9.6 (2.4 + 4.8 + 2.4)`);
if (holdBand.spread > 1e-12) problems.push(`the pose moved ${holdBand.spread} rad across the hold — a hold must stand still`);
if (Math.abs(holdBand.held - 70) > 1.5) problems.push(`the hold sits at knee ${holdBand.held.toFixed(1)}°, want keyframe 2's 70°`);
if (Math.abs(holdBand.after - holdBand.held) < 2) problems.push(`t past the hold (knee ${holdBand.after.toFixed(1)}°) has not moved on`);
// A hold on the FIRST and on the LAST keyframe both take effect: the first
// delays the start, the last makes the end pose linger. The keyframes' own
// knee angles are MEASURED rather than assumed — keyframe 1 is whatever the
// preset poses, and only keyframes 2 and 3 were authored here.
const endHolds = await page.evaluate(() => {
  const app = window.__app;
  const deg = (t) => { app.applySeqT(t); return app.leader.nodes.knee_L.rotation.x * 180 / Math.PI; };
  app.seqSetHold(1, 0);
  const k0 = deg(0); // the first keyframe's own knee, whatever the preset gave
  app.seqSetHold(0, 2.4);  // 2.4 stand + 2.4 move + 2.4 move = 7.2
  app.seqSetHold(2, 2.4);  // …+ 2.4 lingering on the end pose = 9.6
  return {
    total: app.seqSeconds(),
    k0,
    // First hold runs 0 → 2.4 s of 9.6 (t ≤ 0.25): still the START pose.
    start: deg(0.2),
    // Last hold runs 7.2 → 9.6 s (t ≥ 0.75): already the END pose.
    end: deg(0.9),
    endAt1: deg(1),
  };
});
console.log('--- end holds:', JSON.stringify(endHolds));
if (Math.abs(endHolds.total - 9.6) > 1e-9) problems.push(`first+last hold total ${endHolds.total}s, want 9.6`);
if (Math.abs(endHolds.start - endHolds.k0) > 1e-9) {
  problems.push(`the first keyframe's hold did not delay the start (knee ${endHolds.start.toFixed(2)}° at t=0.2 vs ${endHolds.k0.toFixed(2)}° at t=0)`);
}
if (Math.abs(endHolds.end - endHolds.endAt1) > 1e-9) {
  problems.push(`the last keyframe's hold does not linger: t=0.9 (${endHolds.end.toFixed(3)}°) differs from t=1 (${endHolds.endAt1.toFixed(3)}°)`);
}
if (Math.abs(endHolds.endAt1 - 10) > 1.5) problems.push(`t=1 gave knee ${endHolds.endAt1.toFixed(1)}°, want the last keyframe's 10°`);

// A LEGACY chain — one keyframe per `dur`, meaning "seconds to reach the next"
// — must load and play exactly as it always did. The migration turns keyframe
// i's `dur` into keyframe i+1's `move`, so the timeline is unchanged; the proof
// is the pose at several t computed the OLD way (segment boundaries at the
// running sums of the durs, lerping between the keyframes' measured angles).
const legacy = await page.evaluate((k0) => {
  const app = window.__app;
  const fresh = JSON.parse(JSON.stringify(app.seqStates));
  for (const s of fresh) { delete s.move; delete s.hold; }
  fresh[0].dur = 6;   // 6 s from keyframe 1 to 2
  fresh[1].dur = 2;   // 2 s from keyframe 2 to 3
  fresh[2].dur = 3;   // the last keyframe's dur was carried and never played
  app.setSeqStates(fresh);
  const deg = (t) => { app.applySeqT(t); return app.leader.nodes.knee_L.rotation.x * 180 / Math.PI; };
  // Old arithmetic: total 8, segment 1 spans [0, 6], segment 2 spans [6, 8].
  const want = (t) => {
    const time = t * 8;
    return time <= 6 ? k0 + (70 - k0) * (time / 6) : 70 + (10 - 70) * ((time - 6) / 2);
  };
  const ts = [0, 0.25, 0.5, 0.75, 0.9, 1];
  return {
    total: app.seqSeconds(),
    migrated: app.seqStates.map((s) => ({ move: s.move, hold: s.hold, dur: s.dur })),
    got: ts.map(deg),
    want: ts.map(want),
  };
}, endHolds.k0);
const legacyErr = Math.max(...legacy.got.map((g, i) => Math.abs(g - legacy.want[i])));
console.log('--- legacy dur chain:', JSON.stringify({ ...legacy, worst: +legacyErr.toFixed(3) }));
if (Math.abs(legacy.total - 8) > 1e-9) problems.push(`a legacy dur chain totals ${legacy.total}s, want 8 (6 + 2, the trailing dur unplayed)`);
if (legacyErr > 1.5) problems.push(`a legacy dur chain plays differently: worst ${legacyErr.toFixed(2)}° off the old arithmetic`);
if (legacy.migrated.some((m) => m.dur !== undefined)) problems.push(`the legacy dur survived the migration: ${JSON.stringify(legacy.migrated)} — a reorder would hand that gap two owners`);
if (legacy.migrated[1]?.move !== 6 || legacy.migrated[2]?.move !== 2) {
  problems.push(`dur → move migration wrong: ${JSON.stringify(legacy.migrated)}`);
}

// The ROW's two boxes: both take, the FIRST row's move is disabled (nothing
// precedes it to travel from), no hold box ever is (the last keyframe can be
// stood in — that is what lingers on the end pose), and ⟳ — which re-records
// the POSE — keeps both numbers.
const durUi = await page.evaluate(() => {
  const app = window.__app;
  const set = (sel, i, v) => {
    const box = document.querySelectorAll(`#seq-list ${sel}`)[i];
    box.value = String(v);
    box.dispatchEvent(new Event('change'));
  };
  set('.seq-move', 1, 0.5); // 0.5 s into keyframe 2
  set('.seq-hold', 1, 3);   // …and stand there for 3
  set('.seq-hold', 2, 1.5); // 1.5 s lingering on the last pose
  app.seqUpdate(1);         // re-record keyframe 2's POSE — timing must survive
  const moves = [...document.querySelectorAll('#seq-list .seq-move')];
  const holds = [...document.querySelectorAll('#seq-list .seq-hold')];
  return {
    moves: app.seqStates.map((_, i) => app.seqTravel(i)),
    holds: app.seqStates.map((_, i) => app.seqHold(i)),
    firstMoveDisabled: moves[0].disabled,
    otherMovesEnabled: moves.slice(1).every((b) => !b.disabled),
    anyHoldDisabled: holds.some((b) => b.disabled),
    boxes: { moves: moves.length, holds: holds.length },
    moveTitle: moves[1].title,
    firstTitle: moves[0].title,
    holdTitle: holds[0].title,
    seconds: app.seqSeconds(),
    total: document.querySelector('#seq-list .seq-total')?.textContent ?? null,
  };
});
console.log('--- row boxes:', JSON.stringify(durUi));
if (durUi.moves[1] !== 0.5) problems.push(`the row's "into" box did not take, or ⟳ reset it: ${JSON.stringify(durUi.moves)}`);
if (durUi.holds[1] !== 3) problems.push(`the row's "hold" box did not take, or ⟳ reset it: ${JSON.stringify(durUi.holds)}`);
if (durUi.holds[2] !== 1.5) problems.push(`the last row's hold box did not take: ${JSON.stringify(durUi.holds)}`);
if (durUi.moves[2] !== 2) problems.push(`a neighbour's move changed: ${JSON.stringify(durUi.moves)}`);
if (durUi.boxes.moves !== 3 || durUi.boxes.holds !== 3) problems.push(`want one move and one hold box per keyframe, got ${JSON.stringify(durUi.boxes)}`);
if (!durUi.firstMoveDisabled) problems.push('the first keyframe has an editable move — nothing precedes it to travel from');
if (!durUi.otherMovesEnabled) problems.push('a keyframe other than the first has a disabled move box');
if (durUi.anyHoldDisabled) problems.push('a hold box is disabled — every keyframe can be stood in, the last included');
if (!/econds to travel/.test(durUi.moveTitle)) problems.push(`the move box does not explain itself: "${durUi.moveTitle}"`);
if (!/nothing before it/.test(durUi.firstTitle)) problems.push(`the first row's disabled move box does not say why: "${durUi.firstTitle}"`);
if (!/stay in this pose/.test(durUi.holdTitle)) problems.push(`the hold box does not explain itself: "${durUi.holdTitle}"`);
// 0.5 + 2 of travel, 3 + 1.5 of standing still.
if (Math.abs(durUi.seconds - 7) > 1e-9) problems.push(`seqSeconds reads ${durUi.seconds}s, want 7 (0.5 + 2 travel, 3 + 1.5 hold)`);
if (!/7\.0 s/.test(durUi.total ?? '')) problems.push(`the running total reads "${durUi.total}", want 7.0 s — the holds are not in it`);

// …and the player really takes that long, HOLDS INCLUDED.
const played = await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqStates([]);
  app.applyPreset(1);
  app.seqAdd();
  app.leader.setJointDegrees({ knee_L: { x: 70 } });
  app.seqAdd();
  app.seqSetTravel(1, 1.0);
  app.seqSetHold(1, 1.0); // a second of standing on the end pose
  const t0 = performance.now();
  await new Promise((res) => app.playSeq(null, res));
  return { secs: (performance.now() - t0) / 1000, asked: app.seqSeconds() };
});
if (Math.abs(played.asked - 2) > 1e-9) problems.push(`a 1 s move + 1 s hold totals ${played.asked}s, want 2`);
if (Math.abs(played.secs - played.asked) > 0.35) {
  problems.push(`a ${played.asked}s sequence played in ${played.secs.toFixed(2)}s`);
}
console.log(`--- timing playback: asked ${played.asked}s, took ${played.secs.toFixed(2)}s`);

// The COG trail is a PATH, so it is sampled by pose progress rather than by
// time: a hold must cost it nothing. Same sample count, same geometry, with a
// long hold added — which time-uniform sampling could not manage (it would
// spend a third of its ink standing on one point).
const trail = await page.evaluate(() => {
  const app = window.__app;
  const pts = () => {
    const grp = app.scene.children.find((c) => c.children.some?.((l) => l.isLine && l.material.vertexColors));
    const line = grp?.children.find((l) => l.isLine && l.material.vertexColors);
    return line ? [...line.geometry.attributes.position.array] : null;
  };
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  const before = pts();
  app.seqSetHold(1, 12); // twelve seconds standing on the middle keyframe
  const after = pts();
  return {
    n: before?.length / 3,
    same: before && after && before.length === after.length
      && before.every((v, i) => Math.abs(v - after[i]) < 1e-9),
  };
});
console.log('--- trail vs hold:', JSON.stringify(trail));
if (trail.n !== 65) problems.push(`trail has ${trail.n} samples, want 65 (32·segs+1)`);
if (!trail.same) problems.push('a hold changed the COG trail — it is still being sampled by TIME, not by pose progress');

// ---- the row: its label, and the drag reorder ----------------------------
// Both need the section actually ON SCREEN: the reorder is a real mouse
// gesture, and you cannot press a row sitting in a collapsed section on a tab
// that is not showing.
await page.evaluate(() => {
  const app = window.__app;
  document.querySelector('#sidebar-tabs [data-tab="teach"]').click();
  const sec = document.getElementById('sequence-section');
  if (sec.classList.contains('collapsed')) sec.querySelector('.collapse-toggle').click();
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.seqSetName(0, '  cross  '); // trimmed on the way in
  app.seqSetName(1, 'pivot out');
  app.seqSetName(2, 'collection');
  sec.scrollIntoView({ block: 'center' });
});
const rowShape = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#seq-list .pose-item')];
  // A keyframe with no name at all — every file saved before labels existed —
  // must still draw a row that names itself.
  const kept = window.__app.seqStates[2].name;
  delete window.__app.seqStates[2].name;
  window.__app.onSeqChanged();
  const anon = document.querySelectorAll('#seq-list .seq-name')[2];
  const fallback = { value: anon.value, placeholder: anon.placeholder };
  window.__app.seqSetName(2, kept);
  return {
    labels: rows.map((r) => r.querySelector('.seq-name')?.value),
    indices: rows.map((r) => r.querySelector('.seq-index')?.textContent),
    // The timing lives on its own LINE now, not in the controls row: two
    // number boxes in a 320 px row would have squeezed both below the width
    // "2.4" needs. So the row must hold no number box at all, and the
    // keyframe's block must hold exactly one of each.
    rowNumbers: rows[0].querySelectorAll('input[type="number"]').length,
    timeLines: document.querySelectorAll('#seq-list .seq-time').length,
    // Down there each number gets its own word and a visible unit, which is
    // what makes two of them on one line tellable apart at a glance.
    words: [...document.querySelectorAll('#seq-list .seq-block')[0].querySelectorAll('.seq-time-lab')].map((s) => s.textContent),
    units: document.querySelectorAll('#seq-list .seq-block .seq-time-unit').length,
    rowTitle: rows[0].title,
    fallback,
  };
});
console.log('--- row shape:', JSON.stringify(rowShape));
if (rowShape.labels.join('|') !== 'cross|pivot out|collection') problems.push(`row labels are ${JSON.stringify(rowShape.labels)}`);
if (rowShape.indices.join('') !== '123') problems.push(`the leading index is gone: ${JSON.stringify(rowShape.indices)}`);
if (rowShape.rowNumbers) problems.push(`the controls row still carries ${rowShape.rowNumbers} number box(es) — the timing belongs on its own line`);
if (rowShape.timeLines !== 3) problems.push(`found ${rowShape.timeLines} timing lines, want one per keyframe`);
if (rowShape.words.join('|') !== 'into|hold') problems.push(`the timing line's words are ${JSON.stringify(rowShape.words)}, want [into, hold]`);
if (rowShape.units !== 6) problems.push(`want a visible "s" beside each of the six boxes, got ${rowShape.units}`);
if (!/Alt/.test(rowShape.rowTitle)) problems.push(`the row does not advertise the keyboard reorder: "${rowShape.rowTitle}"`);
if (rowShape.fallback.value !== '' || !/Keyframe 3/.test(rowShape.fallback.placeholder)) {
  problems.push(`an unnamed keyframe draws anonymously: ${JSON.stringify(rowShape.fallback)}`);
}

// Typing in the row's own field commits, and Enter (which re-renders the list
// mid-keystroke) must not throw the caret out of the row.
// Picked by index rather than by `:nth-child`: a keyframe is a BLOCK now (the
// controls row plus its caption/muscle extras line), so the row's position
// among #seq-list's children is not the keyframe's position.
const nameBox = (await page.$$('#seq-list .seq-name'))[1];
await nameBox.click();
await page.keyboard.down('Control');
await page.keyboard.press('KeyA');
await page.keyboard.up('Control');
await page.keyboard.type('ocho cortado');
await page.keyboard.press('Enter');
const typed = await page.evaluate(() => ({
  stored: window.__app.seqStates[1].name,
  focused: document.activeElement?.dataset?.field,
  focusRow: document.activeElement?.closest('.pose-item')?.dataset?.index,
}));
console.log('--- typed label:', JSON.stringify(typed));
if (typed.stored !== 'ocho cortado') problems.push(`typing in the row stored "${typed.stored}"`);
if (typed.focused !== 'name' || typed.focusRow !== '1') problems.push('committing a label dropped the caret out of its row');

// A REAL pointer drag of row 3 onto row 1. The answer must be the LIFT AND
// DROP [3, 1, 2] — a chain of neighbour swaps would give [2, 3, 1], carrying
// the rows it passed backwards with it.
await page.evaluate(() => window.__app.seqSetName(1, 'pivot out'));
const boxes = await page.evaluate(() => [...document.querySelectorAll('#seq-list .pose-item')]
  .map((r) => { const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, h: b.height }; }));
const gripX = boxes[0].x + 6; // the index column: never a control
await page.mouse.move(gripX, boxes[2].y + boxes[2].h / 2);
await page.mouse.down();
await page.mouse.move(gripX, boxes[1].y + boxes[1].h / 2, { steps: 6 });
const midDrag = await page.evaluate(() => ({
  carried: document.querySelectorAll('#seq-list .seq-dragging').length,
  marks: [...document.querySelectorAll('#seq-list .pose-item')]
    .map((r) => (r.classList.contains('drop-before') ? 'before'
      : r.classList.contains('drop-after') ? 'after' : '-')).join(','),
}));
await page.screenshot({ path: `${outDir}/sequence-drag.png` });
await page.mouse.move(gripX, boxes[0].y + boxes[0].h * 0.25, { steps: 6 });
await page.mouse.up();
const dragged = await page.evaluate(() => ({
  names: window.__app.seqStates.map((s) => s.name),
  rows: [...document.querySelectorAll('#seq-list .seq-name')].map((i) => i.value),
  leftovers: document.querySelectorAll('#seq-list .drop-before, #seq-list .drop-after, #seq-list .seq-dragging').length,
}));
console.log('--- drag reorder:', JSON.stringify({ midDrag, ...dragged }));
if (!midDrag.carried) problems.push('the dragged row is not marked while it is carried');
if (!/before|after/.test(midDrag.marks)) problems.push(`no drop indicator mid-drag (${midDrag.marks}) — the user is aiming at nothing`);
if (dragged.names.join('|') !== 'collection|cross|pivot out') {
  problems.push(`drag of row 3 onto row 1 gave ${JSON.stringify(dragged.names)}, want [collection, cross, pivot out]`);
}
if (dragged.rows.join('|') !== dragged.names.join('|')) problems.push('the rows do not show the reordered keyframes');
if (dragged.leftovers) problems.push('drag chrome survived the drop');

// The keyboard half — a drag-only reorder is unreachable. Alt+↓ on the focused
// row moves it, focus follows it, and the arrow must NOT also reach the 3D
// view's joint nudge.
const chestBefore = await page.evaluate(() => window.__app.leader.worldPos('chest').toArray());
await page.evaluate(() => document.querySelectorAll('#seq-list .pose-item')[0].focus());
await page.keyboard.down('Alt');
await page.keyboard.press('ArrowDown');
await page.keyboard.up('Alt');
const keyed = await page.evaluate((before) => {
  const app = window.__app;
  const now = app.leader.worldPos('chest').toArray();
  return {
    names: app.seqStates.map((s) => s.name),
    focusRow: document.activeElement?.closest('.pose-item')?.dataset?.index,
    poseMoved: Math.max(...now.map((v, i) => Math.abs(v - before[i]))),
  };
}, chestBefore);
console.log('--- keyboard reorder:', JSON.stringify(keyed));
if (keyed.names.join('|') !== 'cross|collection|pivot out') problems.push(`Alt+↓ gave ${JSON.stringify(keyed.names)}`);
if (keyed.focusRow !== '1') problems.push(`focus did not follow the moved row (row ${keyed.focusRow})`);
if (keyed.poseMoved > 1e-6) problems.push(`Alt+↓ also nudged the dancer (${keyed.poseMoved.toFixed(4)} m)`);

// ⟳ re-records the POSE. The label is not pose — nor is anything else a
// keyframe carries, including a block this script did not write.
const kept = await page.evaluate(() => {
  const app = window.__app;
  app.seqStates[1].kf = { caption: 'from another feature' };
  app.seqSetTravel(1, 1.7);
  app.seqSetHold(1, 0.9);
  app.applyPreset(3);
  app.seqUpdate(1);
  return {
    name: app.seqStates[1].name,
    move: app.seqStates[1].move,
    hold: app.seqStates[1].hold,
    kf: app.seqStates[1].kf?.caption,
  };
});
console.log('--- ⟳ keeps:', JSON.stringify(kept));
if (kept.name !== 'collection') problems.push('⟳ lost the keyframe label');
if (kept.move !== 1.7) problems.push(`⟳ lost the travel time (${kept.move})`);
if (kept.hold !== 0.9) problems.push(`⟳ lost the hold (${kept.hold})`);
if (kept.kf !== 'from another feature') problems.push('⟳ dropped an unknown field off the keyframe');
await page.screenshot({ path: `${outDir}/sequence-rows.png` });

// …and the labels survive a reload, which is the only proof they are stored
// rather than merely displayed.
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));
const reloaded = await page.evaluate(() => ({
  names: window.__app.seqStates.map((s) => s.name),
  rows: [...document.querySelectorAll('#seq-list .seq-name')].map((i) => i.value),
  kf: window.__app.seqStates[1]?.kf?.caption ?? null,
  // Both timing numbers are authored work too: they are what a lesson video's
  // pacing IS, and a refresh mid-lesson must not throw them away.
  move: window.__app.seqTravel(1),
  hold: window.__app.seqHold(1),
  boxes: [
    document.querySelectorAll('#seq-list .seq-move')[1]?.value,
    document.querySelectorAll('#seq-list .seq-hold')[1]?.value,
  ],
}));
console.log('--- after reload:', JSON.stringify(reloaded));
if (reloaded.names.join('|') !== 'cross|collection|pivot out') {
  problems.push(`labels did not survive a reload: ${JSON.stringify(reloaded.names)}`);
}
if (reloaded.rows.join('|') !== reloaded.names.join('|')) problems.push('the restored rows do not show their labels');
if (reloaded.move !== 1.7 || reloaded.hold !== 0.9) {
  problems.push(`the timing did not survive a reload: move ${reloaded.move}, hold ${reloaded.hold} (want 1.7 / 0.9)`);
}
if (reloaded.boxes.join('|') !== '1.7|0.9') problems.push(`the restored boxes read ${JSON.stringify(reloaded.boxes)}, want [1.7, 0.9]`);

await page.evaluate(() => window.__app.setSeqStates([]));

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length || problems.length ? 1 : 0);
