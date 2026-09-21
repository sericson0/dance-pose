// Dev check for the three AUTHORING gestures on the Sequence panel — the ones
// that build a movement rather than play it back.
//
// What it pins, and why each one is here rather than assumed:
//
//  - ⟳ (re-record) offers an UNDO on the status line, and that Undo restores
//    the whole keyframe object BYTE-IDENTICALLY (a JSON compare, not a pose
//    compare): the undo stack holds couple poses only, so Ctrl+Z after a ⟳
//    would put the dancers back and leave the keyframe holding the new pose.
//    The restore is BY IDENTITY, which is checked by reordering the chain
//    inside the six seconds the offer lives — an index-based restore would
//    then overwrite whichever keyframe had moved into that slot — and it
//    must no-op gracefully once the keyframe it belongs to is gone.
//
//  - ⧉ (duplicate) makes an EQUAL BUT NOT SHARED copy directly after its
//    source. "Not shared" is the half that can only be measured by mutating
//    the copy: `{ ...state }` looks right in a JSON compare and still hands
//    the copy the original's `kf` block, so editing the copy's caption or its
//    drawing tag would silently rewrite the original's.
//
//  - "+ Add keyframe" inserts AFTER THE CURRENT keyframe and appends only when
//    there is none, with the current row wearing a marker — and the marker
//    follows a Show, a scrub and a PLAYING sequence WITHOUT the list being
//    re-rendered. That last clause is the load-bearing one and is checked by
//    DOM NODE IDENTITY: renderSequence rebuilds every row, so a marker driven
//    from there would tear the caret out of a caption being typed sixty times
//    a second. A class-only check cannot see that; a node-identity one can.
//
//  - Show (seqApply) puts the SCRUBBER where the keyframe sits — the instant
//    the chain arrives at it — for the first, a middle and the last keyframe,
//    with holds set and unset, and Play then resumes from there rather than
//    from the stale position the slider was left at. Also the boundary: a
//    keyframe's own arrival t, fed straight back through the scrubber, must
//    still resolve to THAT keyframe's extras (t is a fraction of the total, so
//    arrival/total × total lands an ulp short about a third of the time — see
//    U_ARRIVED in main.js).
//
// Usage: node scripts/dev-verify-seq-authoring.mjs <outDir>   (dev server running)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2] || 'shots-seq-authoring';
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
// click, and you cannot press a button in a collapsed section on a tab that is
// not showing.
await page.evaluate(() => {
  document.querySelector('#sidebar-tabs [data-tab="teach"]').click();
  const sec = document.getElementById('sequence-section');
  if (sec.classList.contains('collapsed')) sec.querySelector('.collapse-toggle').click();
});

// A chain of `n` keyframes, built with EXPLICIT indices so the build itself is
// independent of the insert-after-current rule this script is here to test.
const build = (n) => page.evaluate((count) => {
  const app = window.__app;
  app.setSeqStates([]);
  app.clearKeyframeExtras(); // no keyframe is current until something says so
  for (let i = 0; i < count; i++) {
    app.applyPreset(i % app.presets.length);
    app.seqAdd(app.seqStates.length);
  }
  app.clearKeyframeExtras();
  return app.seqStates.length;
}, n);

// A REAL mouse click on one of a row's buttons, found by its glyph rather than
// its place in the row (the row's control list keeps growing).
async function clickRowBtn(i, glyph) {
  const handle = await page.evaluateHandle((idx, want) => {
    const block = document.querySelectorAll('#seq-list .seq-block')[idx];
    return [...block.querySelector('.seq-item').querySelectorAll('button')]
      .find((b) => b.textContent === want) ?? null;
  }, i, glyph);
  const el = handle.asElement();
  if (!el) { problems.push(`no ${glyph} button on row ${i + 1}`); return false; }
  await el.click();
  await handle.dispose();
  await sleep(120);
  return true;
}

const statusNow = () => page.evaluate(() => {
  const el = document.getElementById('status-line');
  return {
    text: el.hidden ? '' : el.textContent,
    action: el.querySelector('button')?.textContent ?? null,
  };
});

// =====================================================================
// 1. ⟳ re-records, and its Undo puts the WHOLE keyframe back
// =====================================================================
await build(3);
const kfBefore = await page.evaluate(() => {
  const app = window.__app;
  // Everything a keyframe can carry beside its pose, so the restore has more
  // than a couple of joint angles to prove: a name, a caption, both timing
  // numbers, a muscle tag — and a field NO feature in this build knows about,
  // which the `{ ...old, ...fresh }` spread is what carries through.
  app.seqSetName(1, 'cross');
  app.seqSetCaption(1, 'the follower crosses');
  app.seqSetTravel(1, 3.1);
  app.seqSetHold(1, 1.5);
  app.seqSetMuscles(1, { lit: ['Sartorius'], colors: [['Sartorius', '#22ff55']] });
  app.seqStates[1].futureFeature = { deep: [1, 2, 3] };
  app.clearKeyframeExtras();
  const snapshot = JSON.stringify(app.seqStates[1]);
  app.applyPreset(5); // a visibly different pose for ⟳ to write in
  return snapshot;
});
await clickRowBtn(1, '⟳');
const afterRerecord = await page.evaluate(() => JSON.stringify(window.__app.seqStates[1]));
const rerecStatus = await statusNow();
console.log('--- ⟳ status:', JSON.stringify(rerecStatus));
check(afterRerecord !== kfBefore, '⟳ did not change the keyframe at all — the Undo check would be vacuous');
check(rerecStatus.text.startsWith('Keyframe 2 re-recorded.'),
  `⟳ said ${JSON.stringify(rerecStatus.text)}, want "Keyframe 2 re-recorded."`);
check(rerecStatus.action === 'Undo', `⟳ offered ${JSON.stringify(rerecStatus.action)}, want an Undo button`);
// The keyframe must keep everything that is NOT pose through the re-record.
const kept = await page.evaluate(() => {
  const s = window.__app.seqStates[1];
  return { name: s.name, move: s.move, hold: s.hold, caption: s.kf?.caption, future: JSON.stringify(s.futureFeature) };
});
console.log('--- ⟳ kept:', JSON.stringify(kept));
check(kept.name === 'cross' && kept.move === 3.1 && kept.hold === 1.5
  && kept.caption === 'the follower crosses' && kept.future === '{"deep":[1,2,3]}',
  `⟳ lost something that is not pose: ${JSON.stringify(kept)}`);

await page.click('#status-line button');
await sleep(150);
const restored = await page.evaluate(() => ({
  json: JSON.stringify(window.__app.seqStates[1]),
  n: window.__app.seqStates.length,
}));
check(restored.json === kfBefore, '⟳ Undo did not restore the keyframe byte-identically');
check(restored.n === 3, `⟳ Undo left ${restored.n} keyframes, want 3`);
console.log(`--- ⟳ Undo restores byte-identically: ${restored.json === kfBefore}`);

// =====================================================================
// 2. …and it finds the keyframe by IDENTITY, not by the index it was at
// =====================================================================
await build(3);
const reorderCase = await page.evaluate(() => {
  const app = window.__app;
  app.seqSetName(0, 'salida');
  app.clearKeyframeExtras();
  return { snapshot: JSON.stringify(app.seqStates[0]), others: app.seqStates.slice(1).map((s) => JSON.stringify(s)) };
});
await page.evaluate(() => window.__app.applyPreset(5));
await clickRowBtn(0, '⟳');
// The six seconds the offer lives is long enough to drag a row. Row 1 goes to
// the end; an index-based Undo would now write the old keyframe over whatever
// took its place at the top.
await page.evaluate(() => window.__app.seqMoveTo(0, 2));
await sleep(120);
await page.click('#status-line button');
await sleep(150);
const afterReorder = await page.evaluate(() => ({
  at2: JSON.stringify(window.__app.seqStates[2]),
  at0: JSON.stringify(window.__app.seqStates[0]),
  at1: JSON.stringify(window.__app.seqStates[1]),
  names: window.__app.seqStates.map((s) => s.name ?? ''),
}));
console.log('--- Undo after a reorder: names', JSON.stringify(afterReorder.names));
check(afterReorder.at2 === reorderCase.snapshot,
  'Undo after a reorder did not restore the re-recorded keyframe at its NEW place');
check(afterReorder.at0 === reorderCase.others[0] && afterReorder.at1 === reorderCase.others[1],
  'Undo after a reorder overwrote a keyframe that had moved into the old slot');

// =====================================================================
// 3. …and it no-ops once that keyframe is gone
// =====================================================================
await build(3);
await page.evaluate(() => window.__app.applyPreset(5));
await clickRowBtn(1, '⟳');
const beforeGone = await page.evaluate(() => {
  const app = window.__app;
  // Deleted through the bulk path on purpose: ✕ / seqDelete post their OWN
  // Undo, which would replace the message this check is about to click.
  app.setSeqStates(app.seqStates.filter((_, j) => j !== 1));
  return JSON.stringify(app.seqStates);
});
await sleep(120);
const stillOffered = await statusNow();
await page.click('#status-line button');
await sleep(150);
const afterGone = await page.evaluate(() => JSON.stringify(window.__app.seqStates));
console.log(`--- Undo after the keyframe was deleted: ${stillOffered.action} → ${afterGone === beforeGone ? 'no-op' : 'CHANGED'}`);
check(stillOffered.action === 'Undo', 'the ⟳ Undo was gone before the deletion could be tested');
check(afterGone === beforeGone, 'Undo resurrected a keyframe that had been deleted');

// =====================================================================
// 4. ⧉ duplicates — equal, adjacent, and NOT sharing anything
// =====================================================================
await build(3);
await page.evaluate(() => {
  const app = window.__app;
  app.seqSetName(1, 'cross');
  app.seqSetCaption(1, 'hold the cross');
  app.seqSetTravel(1, 2.7);
  app.seqSetHold(1, 0.9);
  app.seqSetMuscles(1, { lit: ['Sartorius'], colors: [['Sartorius', '#22ff55']] });
  app.seqSetDrawIds(1, ['a', 'b']);
  app.clearKeyframeExtras();
});
await clickRowBtn(1, '⧉');
const dup = await page.evaluate(() => {
  const app = window.__app;
  const src = app.seqStates[1];
  const copy = app.seqStates[2];
  return {
    n: app.seqStates.length,
    equal: JSON.stringify(src) === JSON.stringify(copy),
    name: copy.name,
    move: copy.move,
    hold: copy.hold,
    // Nothing may be the same OBJECT, or an edit of one rewrites the other.
    sharedState: src === copy,
    sharedKf: src.kf === copy.kf,
    sharedDraw: src.kf.draw === copy.kf.draw,
    sharedFigures: src.figures === copy.figures || src.figures[0] === copy.figures[0],
    sharedMeta: src.meta === copy.meta,
    status: document.getElementById('status-line').textContent,
  };
});
console.log('--- ⧉ duplicate:', JSON.stringify(dup));
check(dup.n === 4, `⧉ left ${dup.n} keyframes, want 4`);
check(dup.equal, '⧉ did not produce an equal copy');
check(dup.name === 'cross', `the copy is named ${JSON.stringify(dup.name)} — a copy of "cross" is still the cross`);
check(dup.move === 2.7 && dup.hold === 0.9, `the copy's timing is ${dup.move}/${dup.hold}, want 2.7/0.9`);
check(!dup.sharedState && !dup.sharedKf && !dup.sharedDraw && !dup.sharedFigures && !dup.sharedMeta,
  `⧉ shared a reference with its source: ${JSON.stringify(dup)}`);

// The measurement that a JSON compare cannot make: edit the COPY and look at
// the original.
const isolation = await page.evaluate(() => {
  const app = window.__app;
  app.seqSetCaption(2, 'a different caption');
  app.seqSetDrawIds(2, ['c']);
  app.seqStates[2].figures[0].position[0] += 1.234;
  return {
    srcCaption: app.seqCaption(1),
    srcDraw: JSON.stringify(app.seqDrawIds(1)),
    srcX: app.seqStates[1].figures[0].position[0],
    copyX: app.seqStates[2].figures[0].position[0],
  };
});
console.log('--- ⧉ isolation:', JSON.stringify(isolation));
check(isolation.srcCaption === 'hold the cross', `editing the copy's caption changed the source's to ${JSON.stringify(isolation.srcCaption)}`);
check(isolation.srcDraw === '["a","b"]', `editing the copy's drawing tag changed the source's to ${isolation.srcDraw}`);
check(Math.abs(isolation.copyX - isolation.srcX - 1.234) < 1e-9, 'the two keyframes share a pose array');

// The scripted form returns the new index.
const dupIndex = await page.evaluate(() => window.__app.seqDuplicate(0));
check(dupIndex === 1, `seqDuplicate(0) returned ${dupIndex}, want 1`);

// =====================================================================
// 5. "+ Add keyframe" inserts after the CURRENT one, and appends when none
// =====================================================================
await build(3);
const addMid = await page.evaluate(() => {
  const app = window.__app;
  app.seqApply(1); // Show: keyframe 2 is now the one being stood on
  return { shown: app.seqShownIndex(), title: document.getElementById('seq-add').title };
});
await page.click('#seq-add');
await sleep(200);
const afterAddMid = await page.evaluate(() => {
  const app = window.__app;
  return { n: app.seqStates.length, shown: app.seqShownIndex(), title: document.getElementById('seq-add').title };
});
console.log('--- Add with a current keyframe:', JSON.stringify({ before: addMid, after: afterAddMid }));
check(addMid.shown === 1, `Show left keyframe ${addMid.shown + 1} current, want 2`);
check(/after keyframe 2/.test(addMid.title), `the Add tooltip reads ${JSON.stringify(addMid.title)} — it must say where it inserts`);
check(afterAddMid.n === 4, `Add left ${afterAddMid.n} keyframes, want 4`);
check(afterAddMid.shown === 2, `the inserted keyframe is at ${afterAddMid.shown}, want index 2 (straight after the current one)`);
check(/after keyframe 3/.test(afterAddMid.title), `the Add tooltip did not follow the insert: ${JSON.stringify(afterAddMid.title)}`);

const addEnd = await page.evaluate(() => {
  const app = window.__app;
  app.clearKeyframeExtras(); // nothing is current — the user has taken the view back
  return { shown: app.seqShownIndex(), title: document.getElementById('seq-add').title };
});
await page.click('#seq-add');
await sleep(200);
const afterAddEnd = await page.evaluate(() => {
  const app = window.__app;
  return { n: app.seqStates.length, shown: app.seqShownIndex() };
});
console.log('--- Add with no current keyframe:', JSON.stringify({ before: addEnd, after: afterAddEnd }));
check(addEnd.shown === -1, 'clearKeyframeExtras left a keyframe current');
check(!/after keyframe/.test(addEnd.title), `the Add tooltip still claims an insert point: ${JSON.stringify(addEnd.title)}`);
check(afterAddEnd.n === 5 && afterAddEnd.shown === 4,
  `Add with nothing current landed at ${afterAddEnd.shown} of ${afterAddEnd.n}, want the end`);

// =====================================================================
// 6. the .seq-current marker follows Show, a scrub and a PLAYING sequence —
//    without the list being re-rendered
// =====================================================================
await build(4);
const marked = () => page.evaluate(() => {
  const blocks = [...document.querySelectorAll('#seq-list .seq-block')];
  return {
    marks: blocks.map((b) => b.classList.contains('seq-current')),
    shown: window.__app.seqShownIndex(),
  };
});
// TWO Shows, not one: the marker has to MOVE. Checking a single Show passes
// wherever the last renderSequence happened to leave the class.
await page.evaluate(() => window.__app.seqApply(0));
await sleep(150);
const markFirst = await marked();
await page.evaluate(() => window.__app.seqApply(2));
await sleep(150);
const markShow = await marked();
console.log('--- marker after Show(1) then Show(3):', JSON.stringify(markFirst), JSON.stringify(markShow));
check(JSON.stringify(markFirst.marks) === '[true,false,false,false]',
  `the marker sits at ${JSON.stringify(markFirst.marks)} after Show(1)`);
check(JSON.stringify(markShow.marks) === '[false,false,true,false]',
  `the marker sits at ${JSON.stringify(markShow.marks)} after Show(3)`);

// Pin the row NODES before scrubbing: if the list were re-rendered the marker
// would still look right and the caret of a field being typed would be gone.
// The scrub starts from the LAST keyframe so it has to travel backwards — a
// marker left where a render put it would otherwise agree by luck.
await page.evaluate(() => {
  window.__app.seqApply(3);
  window.__rows = [...document.querySelectorAll('#seq-list .seq-block')];
  // …and put a caret in a caption field, which is what the user loses.
  const cap = document.querySelector('#seq-list [data-field="caption"]');
  cap.focus();
  window.__capField = cap;
});
const scrubMark = await page.evaluate(() => {
  const app = window.__app;
  const seen = [];
  const markAt = [];
  const at = () => [...document.querySelectorAll('#seq-list .seq-block')]
    .findIndex((b) => b.classList.contains('seq-current'));
  for (const t of [0.05, 0.3, 0.55, 0.8, 0.99]) {
    app.applySeqT(t);
    seen.push(app.seqShownIndex());
    markAt.push(at()); // read per STEP: an end-only check agrees by luck
  }
  const blocks = [...document.querySelectorAll('#seq-list .seq-block')];
  return {
    seen,
    markAt,
    marks: blocks.map((b) => b.classList.contains('seq-current')),
    sameNodes: blocks.length === window.__rows.length && blocks.every((b, i) => b === window.__rows[i]),
    stillFocused: document.activeElement === window.__capField,
  };
});
console.log('--- marker across a scrub:', JSON.stringify(scrubMark));
// Which keyframes a given set of t's crosses depends on the chain's timing, so
// the gate is that the scrub MOVED the current keyframe at all (a marker that
// never moves would pass every other check here) and that it ends where
// seqShownIndex says.
check(new Set(scrubMark.seen).size > 1, `the scrub never left keyframe ${scrubMark.seen[0]}`);
check(scrubMark.markAt.every((m, k) => m === scrubMark.seen[k]),
  `the marker followed ${JSON.stringify(scrubMark.markAt)} while the timeline went ${JSON.stringify(scrubMark.seen)}`);
check(scrubMark.marks.filter(Boolean).length === 1,
  `${scrubMark.marks.filter(Boolean).length} rows are marked current, want exactly 1`);
check(scrubMark.sameNodes, 'the keyframe list was RE-RENDERED by a scrub — the marker must be a class toggle');
check(scrubMark.stillFocused, 'a scrub took the caret out of a caption field — the list was rebuilt');

// …and through a real playback.
await page.evaluate(() => {
  window.__rows = [...document.querySelectorAll('#seq-list .seq-block')];
  window.__app.playSeq(null, null, { from: 0 });
});
const playMark = await page.evaluate(async () => {
  const app = window.__app;
  const seen = new Set();
  const agree = [];
  const t0 = performance.now();
  while (app.seqPlaying && performance.now() - t0 < 20000) {
    const blocks = [...document.querySelectorAll('#seq-list .seq-block')];
    const at = blocks.findIndex((b) => b.classList.contains('seq-current'));
    seen.add(at);
    agree.push(at === app.seqShownIndex());
    await new Promise((r) => setTimeout(r, 120));
  }
  const blocks = [...document.querySelectorAll('#seq-list .seq-block')];
  return {
    visited: [...seen].sort((a, b) => a - b),
    allAgree: agree.every(Boolean),
    samples: agree.length,
    sameNodes: blocks.length === window.__rows.length && blocks.every((b, i) => b === window.__rows[i]),
  };
});
console.log('--- marker through a playback:', JSON.stringify(playMark));
check(playMark.visited.length >= 3, `the marker visited only ${JSON.stringify(playMark.visited)} of 4 keyframes while playing`);
check(playMark.allAgree, 'the marker disagreed with app.seqShownIndex() during playback');
check(playMark.sameNodes, 'the keyframe list was RE-RENDERED by a playback');

await page.screenshot({ path: `${outDir}/seq-marker.png` });

// =====================================================================
// 7. Show syncs the scrubber
// =====================================================================
// Uneven timing, so an arrival t is a real number rather than a round third:
// moves 2.0 / 3.0 / 1.5, holds 0 / 1.5 / 0 / 0 → total 8.0.
const timeline = await page.evaluate(() => {
  const app = window.__app;
  app.setSeqStates([]);
  app.clearKeyframeExtras();
  for (let i = 0; i < 4; i++) { app.applyPreset(i); app.seqAdd(app.seqStates.length); }
  app.seqSetTravel(1, 2.0);
  app.seqSetTravel(2, 3.0);
  app.seqSetTravel(3, 1.5);
  app.seqSetHold(1, 1.5);
  app.clearKeyframeExtras();
  return { secs: app.seqSeconds(), ts: [0, 1, 2, 3].map((i) => app.seqKeyframeT(i)) };
});
console.log('--- timeline:', JSON.stringify(timeline));
check(Math.abs(timeline.secs - 8.0) < 1e-9, `the test chain runs ${timeline.secs}s, want 8`);
const wantTs = [0, 2.0 / 8, (2.0 + 1.5 + 3.0) / 8, 1];
timeline.ts.forEach((t, i) => {
  check(Math.abs(t - wantTs[i]) < 1e-9, `seqKeyframeT(${i}) = ${t}, want ${wantTs[i]}`);
});

// A numeric deep compare: the pose Show leaves on the dancers against the pose
// the keyframe holds. (A string compare would fail on -0 / 1e-17 noise.) It
// reports WHICH field differs, so a failure names its own cause.
//
// `facing` is skipped deliberately, and it is the trap CLAUDE.md records under
// "A figure's facing is figureYaw(figure), never group.rotation.y": getPose
// writes it from `rotation.y`, setPose restores from the QUATERNION, and
// three's XYZ decomposition of a pure 180° yaw comes back as [π, ~0, π] — so
// the field reads 3.14159 before the round trip and 1.2e-16 after it while
// the dancer is facing exactly the same way. The quaternion, the joints and
// the position (which are what a pose IS) all round-trip exactly.
const showCases = await page.evaluate(() => {
  const app = window.__app;
  const diff = (a, b, at, out) => {
    if (out.length > 4 || at.endsWith('.facing')) return out;
    if (Array.isArray(a)) a.forEach((v, k) => diff(v, b?.[k], `${at}[${k}]`, out));
    else if (a && typeof a === 'object') Object.keys(a).forEach((k) => diff(a[k], b?.[k], `${at}.${k}`, out));
    else if (typeof a === 'number' ? !(Math.abs(a - b) < 1e-6) : a !== b) out.push(`${at}: ${a} vs ${b}`);
    return out;
  };
  const out = [];
  for (const i of [0, 1, 3]) {
    app.seqApply(i);
    const live = app.figures.map((f) => f.getPose());
    out.push({
      i,
      t: app.seqT,
      want: app.seqKeyframeT(i),
      slider: Number(document.getElementById('seq-slider').value),
      readout: document.getElementById('seq-val').textContent,
      shown: app.seqShownIndex(),
      poseDiff: diff(app.seqStates[i].figures, live, 'fig', []),
      // The boundary: feed that very t back through the scrubber and the
      // extras must still be this keyframe's.
      reScrub: (() => { app.applySeqT(app.seqT); return app.seqShownIndex(); })(),
    });
  }
  return out;
});
for (const c of showCases) {
  c.poseOK = c.poseDiff.length === 0;
  console.log(`--- Show(${c.i}): t=${c.t.toFixed(6)} (want ${c.want.toFixed(6)}) slider=${c.slider} readout=${c.readout} shown=${c.shown} pose=${c.poseOK} reScrub=${c.reScrub}`);
  check(Math.abs(c.t - c.want) < 1e-12, `Show(${c.i}) put seqT at ${c.t}, want ${c.want}`);
  check(c.slider === Math.round(c.want * 1000), `Show(${c.i}) left the slider at ${c.slider}, want ${Math.round(c.want * 1000)}`);
  check(c.readout === `${Math.round(c.want * 100)}%`, `Show(${c.i}) left the readout at ${c.readout}`);
  check(c.shown === c.i, `Show(${c.i}) left keyframe ${c.shown} showing its extras`);
  check(c.poseOK, `Show(${c.i}) did not put the couple in that keyframe's pose: ${JSON.stringify(c.poseDiff)}`);
  check(c.reScrub === c.i, `scrubbing back to Show(${c.i})'s own t flicked the extras to keyframe ${c.reScrub}`);
}

// The last keyframe WITH a hold no longer sits at t = 1: the tail of the
// timeline is time spent standing on it.
const lastHold = await page.evaluate(() => {
  const app = window.__app;
  app.seqSetHold(3, 2.0); // total 10.0, arrival at keyframe 4 still 6.5
  app.seqApply(3);
  return { t: app.seqT, want: app.seqKeyframeT(3), secs: app.seqSeconds(), shown: app.seqShownIndex() };
});
console.log('--- Show(last) with a hold:', JSON.stringify(lastHold));
// Arrival at keyframe 4 is unchanged at 0 + 2.0 + 1.5 + 3.0 + 0 + 1.5 = 8.0 s;
// what the hold changes is the TOTAL, 8.0 → 10.0, so the same instant is now
// 0.80 of the scrubber instead of its very end.
check(Math.abs(lastHold.secs - 10) < 1e-9, `chain runs ${lastHold.secs}s, want 10`);
check(Math.abs(lastHold.t - 0.8) < 1e-9, `Show(last) with a 2s hold put seqT at ${lastHold.t}, want 0.8`);
check(lastHold.shown === 3, `Show(last) left keyframe ${lastHold.shown} showing`);

// Play after Show RESUMES from there rather than rewinding.
const resume = await page.evaluate(async () => {
  const app = window.__app;
  app.seqSetHold(3, 0); // back to a plain chain, so t = 1 is the end
  app.seqApply(1);
  const start = app.seqT;
  const samples = [];
  document.getElementById('seq-play').click(); // the real button
  const t0 = performance.now();
  while (app.seqPlaying && performance.now() - t0 < 15000) {
    samples.push(app.seqT);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { start, min: Math.min(...samples), end: app.seqT, n: samples.length };
});
console.log('--- Play after Show:', JSON.stringify(resume));
check(Math.abs(resume.start - 0.25) < 1e-9, `Show(1) left seqT at ${resume.start}, want 0.25`);
check(resume.min >= resume.start - 1e-6,
  `Play after Show rewound to ${resume.min} — it must carry on from ${resume.start}`);
check(resume.end >= 1 - 1e-6, `the playback ended at ${resume.end}, want 1`);

// Show on keyframe 1 is t = 0, so Play from there is a full replay — the one
// case where "resume" and "from the top" are the same thing, and the last
// keyframe with no hold is t = 1, which resumeT reads as "from the top".
const ends = await page.evaluate(() => {
  const app = window.__app;
  app.seqApply(0);
  const first = app.seqT;
  app.seqApply(3);
  const last = app.seqT;
  app.playSeq(null, null);
  const resumed = app.seqT;
  app.stopSeq();
  return { first, last, resumed };
});
console.log('--- the chain\'s ends:', JSON.stringify(ends));
check(ends.first === 0, `Show(first) put seqT at ${ends.first}, want 0`);
check(Math.abs(ends.last - 1) < 1e-12, `Show(last, no hold) put seqT at ${ends.last}, want 1`);
check(ends.resumed === 0, `Play from the end resumed at ${ends.resumed}, want 0 (there is nothing left to play)`);

// The boundary, over a spread of timings rather than the one above: every
// keyframe's own arrival t, fed through the scrubber, must land on THAT
// keyframe's extras. Without the U_ARRIVED slack this fails on roughly a third
// of them (u comes back as 0.999999999999999 of the segment just finished).
const boundary = await page.evaluate(() => {
  const app = window.__app;
  const bad = [];
  let tried = 0;
  const cases = [
    { moves: [3.8, 5.4, 8.1], holds: [0, 0, 0, 0] },
    { moves: [3.2, 5.4, 2.4], holds: [0.8, 0, 4.2, 0] },
    { moves: [6.3, 1.1, 0.7], holds: [4.9, 2.6, 0, 3.3] },
    { moves: [2.3, 3.1, 5.3], holds: [0, 2.9, 0, 1.7] },
  ];
  for (const c of cases) {
    c.moves.forEach((m, j) => app.seqSetTravel(j + 1, m));
    c.holds.forEach((h, j) => app.seqSetHold(j, h));
    for (let i = 0; i < app.seqStates.length; i++) {
      tried++;
      const t = app.seqKeyframeT(i);
      app.applySeqT(t);
      if (app.seqShownIndex() !== i) bad.push(`${JSON.stringify(c)} kf${i} t=${t} → ${app.seqShownIndex()}`);
    }
  }
  return { tried, bad };
});
console.log(`--- arrival-t boundary: ${boundary.tried - boundary.bad.length}/${boundary.tried} land on their own keyframe`);
for (const b of boundary.bad) console.log(`    ${b}`);
check(boundary.bad.length === 0, `${boundary.bad.length} of ${boundary.tried} arrival times resolved to the wrong keyframe`);

// ---- a look at the finished panel, at the real sidebar width --------------
await page.evaluate(() => {
  const app = window.__app;
  app.setSeqStates([]);
  app.clearKeyframeExtras();
  for (let i = 0; i < 3; i++) { app.applyPreset(i); app.seqAdd(app.seqStates.length); }
  app.seqSetName(0, 'salida');
  app.seqSetName(1, 'cross');
  app.seqSetCaption(1, 'weight stays on the standing leg');
  app.seqSetHold(1, 1.5);
  app.seqApply(1);
});
await sleep(400);
const panel = await page.$('#sequence-section');
await panel.screenshot({ path: `${outDir}/seq-panel.png` });

console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'No console errors.');
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(` - ${p}`);
} else {
  console.log('\nAll sequence-authoring checks passed.');
}
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
