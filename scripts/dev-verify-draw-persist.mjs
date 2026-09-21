// Dev check for floor drawings as SAVED WORK: the diagram survives a reload,
// it travels inside a sequence file, and a keyframe can show a subset of it.
//
// Four things, and each one is the answer to a way the feature can be wrong:
//  1. A round trip through localStorage rebuilds every shape — including the
//     JOINT-ANCHORED one, which is the only kind that cannot be checked by its
//     stored numbers alone (its end is a dancer, so the proof is that it still
//     tracks the joint after the arm is posed).
//  2. A drawing's `id` survives a restyle and an endpoint drag. Both go through
//     Drawings.#replace, which builds a NEW Object3D from the SAME record — a
//     keyframe naming that drawing would be orphaned by an id that did not.
//  3. `kf.draw` on a keyframe: extras come from the keyframe being travelled
//     FROM, an untagged keyframe shows everything, and a chain with no kf block
//     at all behaves exactly as it did before any of this existed. The sharp
//     one here is the COG TRAIL: it replays the whole chain ~289 times per edit
//     through the same interpolator, so an edit by hand must not leave the
//     floor set to whatever the last trail sample said.
//  4. Export → import round-trips the drawings, and a legacy file with no
//     `drawings` key still imports its keyframes and leaves the floor alone.
//
// Honours DEV_URL (default http://localhost:5173) and BROWSER_PATH.
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reload = async () => {
  await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(2200);
};

// ---- 1. Five drawings, one of every kind, across a reload -------------------
// Distinct colours and widths, so a shape that came back in the DEFAULT style
// (a rebuild that dropped the record's own look) reads as a failure rather
// than as a pass.
const authored = await page.evaluate(() => {
  const app = window.__app;
  localStorage.removeItem('tangoPoseStudio.drawings.v1');
  localStorage.removeItem('tangoPoseStudio.sequence.v1');
  app.setSeqStates([]);
  app.applyPreset(1);
  app.clearDrawings();
  app.setDrawStyle({ color: '#66d9ff', width: 0.03 });
  app.addDrawLine({ x: -0.9, z: 0.5 }, { x: -0.2, z: 0.5 });
  app.setDrawStyle({ color: '#ff5f8a', width: 0.05 });
  app.addDrawArrow({ x: -0.9, z: 0.9 }, { x: -0.1, z: 0.9 });
  app.setDrawStyle({ color: '#9cf06a', width: 0.02 });
  app.addDrawCircle({ x: 0.7, z: 0.6 }, 0.34);
  app.setDrawStyle({ color: '#ffd27f', width: 0.04 });
  app.addDrawText({ x: 0.1, z: -0.9 }, 'giro', 0.4);
  app.setDrawStyle({ color: '#c08cff', width: 0.025 });
  app.addDrawLine({ fig: 0, joint: 'wrist_L' }, { fig: 'follower', joint: 'shoulder_R' });
  return { list: app.drawingsJSON(), stored: JSON.parse(localStorage.getItem('tangoPoseStudio.drawings.v1') || 'null') };
});
if (authored.list.length !== 5) problems.push(`authored ${authored.list.length} drawings, want 5`);
if (!Array.isArray(authored.stored) || authored.stored.length !== 5) {
  problems.push(`localStorage holds ${authored.stored?.length ?? 'nothing'} drawings after authoring, want 5`);
}
const ids = authored.list.map((a) => a.id);
if (ids.some((id) => !id) || new Set(ids).size !== 5) problems.push(`ids not unique/present: ${JSON.stringify(ids)}`);
console.log(`--- Authored: ${authored.list.map((a) => a.type).join(',')} as ${ids.join(',')}`);

await page.screenshot({ path: `${outDir}/draw-persist-before.png` });
await reload();

const back = await page.evaluate(() => {
  const app = window.__app;
  const g = app.draw.group;
  const anchoredAnn = app.drawings.find((a) => a.aAt || a.bAt);
  const anchoredObj = g.children.find((o) => o.userData.annotation.aAt || o.userData.annotation.bAt);
  return {
    list: app.drawingsJSON(),
    anchoredCount: app.draw.anchoredCount,
    // The anchored end is only right if the rebuilt TUBE is on the joint.
    tubeGap: anchoredObj ? anchoredObj.children[0].position.distanceTo(app.leader.surfacePos('wrist_L')) : null,
    anchoredAnn,
    // The text's canvas texture has to have been re-rendered, not restored.
    textMap: !!g.children.find((o) => o.userData.annotation.type === 'text')?.material?.map?.image?.width,
    circleOuter: g.children.find((o) => o.userData.annotation.type === 'circle')?.geometry?.parameters?.outerRadius,
  };
});
if (back.list.length !== 5) problems.push(`after reload ${back.list.length} drawings came back, want 5`);
// Every field of every record, compared whole — colour, width, geometry, ids
// and the anchor blocks all at once.
const beforeJSON = JSON.stringify(authored.list);
const afterJSON = JSON.stringify(back.list);
if (beforeJSON !== afterJSON) {
  problems.push(`records changed across the reload:\n  before ${beforeJSON}\n  after  ${afterJSON}`);
}
if (back.anchoredCount !== 1) problems.push(`anchoredCount ${back.anchoredCount} after reload, want 1`);
if (!(back.tubeGap < 0.005)) problems.push(`the restored anchored end sits ${back.tubeGap} m from wrist_L`);
if (!back.textMap) problems.push('the restored text has no canvas texture');
if (Math.abs((back.circleOuter ?? 0) - (0.34 + 0.01)) > 0.02) problems.push(`restored circle outer r ${back.circleOuter}`);
console.log(`--- After reload: ${back.list.length} drawings, records identical: ${beforeJSON === afterJSON}, anchored end ${back.tubeGap.toFixed(4)} m off`);

// The anchor is a dancer, not a number: pose the arm and it has to follow.
const tracked = await page.evaluate(async () => {
  const app = window.__app;
  const before = app.leader.surfacePos('wrist_L').clone();
  app.leader.setJointDegrees({ shoulder_L: { x: -80, z: 40 }, elbow_L: { x: -90 } });
  app.requestSim();
  await new Promise((r) => setTimeout(r, 600));
  const obj = app.draw.group.children.find((o) => o.userData.annotation.aAt);
  const now = app.leader.surfacePos('wrist_L');
  return { moved: before.distanceTo(now), gap: obj.children[0].position.distanceTo(now) };
});
if (tracked.moved < 0.1) problems.push(`the test pose barely moved the wrist (${tracked.moved.toFixed(3)} m) — it proves nothing`);
if (tracked.gap > 0.005) problems.push(`the RESTORED anchor is ${tracked.gap.toFixed(3)} m off its joint after posing`);
console.log(`--- Restored anchor still tracks: ${tracked.gap.toFixed(4)} m off after the wrist moved ${tracked.moved.toFixed(2)} m`);
await page.screenshot({ path: `${outDir}/draw-persist-after.png` });

// ---- 2. An id survives #replace (restyle + endpoint drag) -------------------
const kept = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(1);
  const id0 = app.drawings[0].id;
  app.selectDrawing(app.draw.group.children[0]);
  app.setDrawStyle({ color: '#ff2266', width: 0.055 });
  const afterStyle = { id: app.drawings[0].id, color: app.drawings[0].color, width: app.drawings[0].width };
  app.moveDrawHandle(app.draw.group.children[0], 1, { x: 0.45, z: -0.35 });
  const afterDrag = { id: app.drawings[0].id, b: app.drawings[0].b };
  app.selectDrawing(null);
  // The anchored one gets the same treatment: its record is rebuilt too.
  const anchoredIdx = app.drawings.findIndex((a) => a.aAt);
  const idA = app.drawings[anchoredIdx].id;
  app.selectDrawing(app.draw.group.children[anchoredIdx]);
  app.setDrawStyle({ width: 0.045 });
  const afterAnchoredStyle = app.drawings[anchoredIdx].id;
  app.selectDrawing(null);
  return { id0, afterStyle, afterDrag, idA, afterAnchoredStyle, all: app.drawings.map((a) => a.id) };
});
if (kept.afterStyle.id !== kept.id0) problems.push(`restyle changed the id: ${kept.id0} → ${kept.afterStyle.id}`);
if (kept.afterStyle.color !== '#ff2266') problems.push(`restyle did not take: ${kept.afterStyle.color}`);
if (kept.afterDrag.id !== kept.id0) problems.push(`endpoint drag changed the id: ${kept.id0} → ${kept.afterDrag.id}`);
if (Math.abs(kept.afterDrag.b[0] - 0.45) > 1e-6) problems.push(`endpoint drag did not move the end: ${JSON.stringify(kept.afterDrag.b)}`);
if (kept.afterAnchoredStyle !== kept.idA) problems.push(`restyling the anchored line changed its id: ${kept.idA} → ${kept.afterAnchoredStyle}`);
if (new Set(kept.all).size !== kept.all.length) problems.push(`ids collided after editing: ${JSON.stringify(kept.all)}`);
console.log(`--- Ids through #replace: ${kept.id0} kept across a restyle and an endpoint drag; anchored ${kept.idA} kept`);

// A drawing authored AFTER a restore must not take an id a restored one holds.
const minted = await page.evaluate(() => {
  const app = window.__app;
  app.addDrawCircle({ x: -1.4, z: -0.4 }, 0.2);
  const all = app.drawings.map((a) => a.id);
  return { all, unique: new Set(all).size === all.length, newest: all.at(-1) };
});
if (!minted.unique) problems.push(`a new drawing collided with a restored id: ${JSON.stringify(minted.all)}`);
console.log(`--- New drawing after a restore: ${minted.newest} (all unique: ${minted.unique})`);

// ---- 3. kf.draw --------------------------------------------------------
// Three keyframes; the middle one shows two of the six drawings. The visible
// set is read off the SCENE (object.visible), not off the filter, so a filter
// that is stored but never applied reads as a failure.
const tagged = await page.evaluate(() => {
  const app = window.__app;
  const shown = () => app.draw.group.children.filter((o) => o.visible).length;
  app.setSeqStates([]);
  app.applyPreset(1);
  app.seqAdd();
  app.leader.setJointDegrees({ shoulder_L: { x: -40 } });
  app.seqAdd();
  app.leader.setJointDegrees({ shoulder_L: { x: 10 } });
  app.seqAdd();
  const all = app.drawings.map((a) => a.id);
  const subset = [all[0], all[2]];

  // A chain with no kf block at all: every scrub position shows everything.
  const untaggedRun = [0, 0.25, 0.5, 0.75, 1].map((t) => { app.applySeqT(t); return shown(); });

  app.seqSetDrawIds(1, subset);
  const stored = JSON.parse(JSON.stringify(app.seqStates[1].kf));
  // Per t: which keyframe is being travelled FROM decides the diagram.
  const run = [0, 0.25, 0.49, 0.5, 0.75, 1].map((t) => { app.applySeqT(t); return shown(); });
  app.applySeqT(0.75);
  const midIds = app.draw.group.children.filter((o) => o.visible).map((o) => o.userData.annotation.id);
  // Show (seqApply) is the other seam onto a keyframe.
  app.seqApply(1);
  const viaShow = shown();
  app.seqApply(0);
  const viaShow0 = shown();
  // Clearing the tag puts the keyframe back to "all".
  app.seqSetDrawIds(1, null);
  app.applySeqT(0.75);
  const cleared = { shown: shown(), kf: app.seqStates[1].kf ?? null };
  return { total: all.length, subset, untaggedRun, stored, run, midIds, viaShow, viaShow0, cleared };
});
if (tagged.untaggedRun.some((n) => n !== tagged.total)) {
  problems.push(`an UNTAGGED chain hid drawings: ${JSON.stringify(tagged.untaggedRun)} of ${tagged.total}`);
}
if (tagged.stored?.draw?.length !== 2) problems.push(`kf.draw stored as ${JSON.stringify(tagged.stored)}`);
// t = 0 / 0.25 / 0.49 travel FROM keyframe 0 (untagged → all); 0.5 reaches
// keyframe 1 and 0.75 is inside its segment (→ 2); t = 1 reaches keyframe 2.
const wantRun = [tagged.total, tagged.total, tagged.total, 2, 2, tagged.total];
if (JSON.stringify(tagged.run) !== JSON.stringify(wantRun)) {
  problems.push(`scrub showed ${JSON.stringify(tagged.run)}, want ${JSON.stringify(wantRun)}`);
}
if (JSON.stringify(tagged.midIds) !== JSON.stringify(tagged.subset)) {
  problems.push(`the wrong drawings are showing mid-segment: ${JSON.stringify(tagged.midIds)} want ${JSON.stringify(tagged.subset)}`);
}
if (tagged.viaShow !== 2) problems.push(`Show on the tagged keyframe left ${tagged.viaShow} drawings, want 2`);
if (tagged.viaShow0 !== tagged.total) problems.push(`Show on an untagged keyframe left ${tagged.viaShow0}, want ${tagged.total}`);
if (tagged.cleared.shown !== tagged.total) problems.push(`clearing the tag left ${tagged.cleared.shown} drawings`);
if (tagged.cleared.kf) problems.push(`clearing left a kf block behind: ${JSON.stringify(tagged.cleared.kf)}`);
console.log(`--- kf.draw: untagged ${JSON.stringify(tagged.untaggedRun)}, tagged ${JSON.stringify(tagged.run)} of ${tagged.total}, Show ${tagged.viaShow}/${tagged.viaShow0}`);

// The kf block is SHARED: another feature's fields must ride through both the
// tag and the clear untouched.
const merged = await page.evaluate(() => {
  const app = window.__app;
  app.seqStates[1].kf = { caption: 'from another feature' };
  app.seqSetDrawIds(1, app.drawings.map((a) => a.id).slice(0, 1));
  const afterTag = JSON.parse(JSON.stringify(app.seqStates[1].kf));
  app.seqSetDrawIds(1, null);
  const afterClear = JSON.parse(JSON.stringify(app.seqStates[1].kf));
  app.seqSetDrawIds(1, app.drawings.map((a) => a.id).slice(0, 2));
  return { afterTag, afterClear };
});
if (merged.afterTag.caption !== 'from another feature' || merged.afterTag.draw?.length !== 1) {
  problems.push(`tagging rebuilt the kf block: ${JSON.stringify(merged.afterTag)}`);
}
if (merged.afterClear.caption !== 'from another feature' || 'draw' in merged.afterClear) {
  problems.push(`clearing the tag damaged the kf block: ${JSON.stringify(merged.afterClear)}`);
}
console.log(`--- kf merge: ${JSON.stringify(merged.afterTag)} → cleared ${JSON.stringify(merged.afterClear)}`);

// Editing by hand must not hide anyone. The COG trail is the trap: it replays
// the whole chain through applyStatesT ~289 times on every keyframe edit, and
// an un-opted-out replay would leave the floor on the last sample's keyframe.
const byHand = await page.evaluate(() => {
  const app = window.__app;
  const shown = () => app.draw.group.children.filter((o) => o.visible).length;
  app.setDrawVisibleIds(null);           // the user is looking at the whole diagram
  const before = shown();
  app.leader.setJointDegrees({ elbow_L: { x: -30 } });
  app.seqAdd();                          // rebuilds the trail: 289 applyStatesT calls
  const afterEdit = shown();
  app.seqUpdate(0);
  return { before, afterEdit, afterUpdate: shown(), filter: app.drawVisibleIds };
});
if (byHand.afterEdit !== byHand.before || byHand.afterUpdate !== byHand.before) {
  problems.push(`editing outside the timeline changed the diagram: ${JSON.stringify(byHand)}`);
}
if (byHand.filter !== null) problems.push(`an edit left a filter behind: ${JSON.stringify(byHand.filter)}`);
console.log(`--- Hand edit leaves the diagram alone: ${byHand.before} → ${byHand.afterEdit} → ${byHand.afterUpdate}, filter ${byHand.filter}`);

// The toolbar's ◐ Hide is how that subset is built in the first place.
await page.click('#mode-buttons button[data-mode="draw"]');
await sleep(200);
const hideBtn = await page.evaluate(() => {
  const app = window.__app;
  app.setDrawVisibleIds(null);
  app.selectDrawing(app.draw.group.children[1]);
  const labelWithSel = document.getElementById('draw-hide').textContent;
  document.getElementById('draw-hide').click();
  const hidden = app.draw.group.children.filter((o) => !o.visible).length;
  const labelAfter = document.getElementById('draw-hide').textContent;
  const captured = app.drawShownIds.length;
  document.getElementById('draw-hide').click(); // nothing selected now → show all
  return { labelWithSel, hidden, labelAfter, captured, backToAll: app.drawVisibleIds, shown: app.drawShownIds.length };
});
if (hideBtn.labelWithSel !== '◐ Hide') problems.push(`the hide button reads "${hideBtn.labelWithSel}" with a selection`);
if (hideBtn.hidden !== 1) problems.push(`◐ Hide hid ${hideBtn.hidden} drawings, want 1`);
if (hideBtn.labelAfter !== '◉ Show all') problems.push(`the button did not flip to Show all: "${hideBtn.labelAfter}"`);
if (hideBtn.backToAll !== null) problems.push(`Show all left a filter: ${JSON.stringify(hideBtn.backToAll)}`);
console.log(`--- ◐ Hide / ◉ Show all: hid ${hideBtn.hidden}, capture would take ${hideBtn.captured}, back to ${hideBtn.shown}`);
await page.click('#mode-buttons button[data-mode="rotate"]');

// The row's ◻ captures exactly what is on screen.
const rowTag = await page.evaluate(() => {
  const app = window.__app;
  app.setDrawVisibleIds(null);
  app.seqSetDrawIds(1, null);
  app.setDrawingVisible(app.draw.group.children[0], false);
  app.setDrawingVisible(app.draw.group.children[3], false);
  const onScreen = app.drawShownIds;
  // The drawings tag lives on the extras line now, beside the muscle one, and
  // wears its own class — `.seq-kf-btn` still indexes the MUSCLE tag alone.
  const tagOf = (i) => document.querySelectorAll('#seq-list .seq-draw-btn')[i];
  const tagBtn = tagOf(1);
  const labelBefore = tagBtn.textContent;
  tagBtn.click();
  const stored = app.seqDrawIds(1);
  const labelAfter = tagOf(1).textContent;
  tagOf(1).click();
  return { onScreen, stored, labelBefore, labelAfter, cleared: app.seqDrawIds(1), status: document.getElementById('status-line').textContent };
});
if (!/^◻/.test(rowTag.labelBefore) || !/^◼/.test(rowTag.labelAfter)) {
  problems.push(`the row tag button reads ${rowTag.labelBefore} → ${rowTag.labelAfter}, want ◻ … → ◼ …`);
}
if (JSON.stringify(rowTag.stored) !== JSON.stringify(rowTag.onScreen)) {
  problems.push(`◻ captured ${JSON.stringify(rowTag.stored)}, on screen was ${JSON.stringify(rowTag.onScreen)}`);
}
if (rowTag.cleared !== null) problems.push(`a second press left ${JSON.stringify(rowTag.cleared)}, want null`);
console.log(`--- Row ◻: captured ${rowTag.stored.length} of what was showing, second press cleared to ${rowTag.cleared}`);

// ---- 4. Export → import, and a legacy file with no drawings ----------------
const roundTrip = await page.evaluate(async () => {
  const app = window.__app;
  app.seqSetDrawIds(1, app.drawings.map((a) => a.id).slice(0, 2));
  let blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { blob = b; return orig(b); };
  HTMLAnchorElement.prototype.click = () => {};
  document.getElementById('seq-export').click();
  URL.createObjectURL = orig;
  const payload = JSON.parse(await blob.text());

  const importFile = async (obj) => {
    window.confirm = () => true;
    const input = document.getElementById('seq-file');
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(obj)], 'seq.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
  };

  // Wipe both, then import the file we just exported.
  app.clearDrawings();
  app.setSeqStates([]);
  await importFile(payload);
  const imported = {
    states: app.seqStates.length,
    drawings: app.drawingsJSON(),
    kf: app.seqDrawIds(1),
  };

  // A LEGACY file: same payload with the drawings key removed. It must import
  // its keyframes and leave the floor exactly as it found it.
  const legacy = { app: 'tangle', type: 'sequence', version: 1, states: payload.states };
  const floorBefore = app.drawingsJSON();
  await importFile(legacy);
  return {
    payloadDrawings: payload.drawings?.length ?? null,
    payloadStates: payload.states?.length ?? null,
    imported,
    legacyStates: app.seqStates.length,
    floorUnchanged: JSON.stringify(floorBefore) === JSON.stringify(app.drawingsJSON()),
    floorCount: app.draw.count,
  };
});
if (roundTrip.payloadDrawings !== 6) problems.push(`the export carries ${roundTrip.payloadDrawings} drawings, want 6`);
if (roundTrip.imported.drawings.length !== 6) problems.push(`the import restored ${roundTrip.imported.drawings.length} drawings, want 6`);
if (roundTrip.imported.states !== roundTrip.payloadStates) {
  problems.push(`the import restored ${roundTrip.imported.states} keyframes, want ${roundTrip.payloadStates}`);
}
if (roundTrip.imported.kf?.length !== 2) problems.push(`kf.draw did not survive the file: ${JSON.stringify(roundTrip.imported.kf)}`);
if (roundTrip.legacyStates !== roundTrip.payloadStates) {
  problems.push(`the legacy file imported ${roundTrip.legacyStates} keyframes, want ${roundTrip.payloadStates}`);
}
if (!roundTrip.floorUnchanged) problems.push('a legacy file (no drawings key) rewrote the floor');
console.log(`--- Export/import: ${roundTrip.payloadDrawings} drawings + ${roundTrip.payloadStates} keyframes round-tripped (kf.draw ${JSON.stringify(roundTrip.imported.kf)}); legacy file left ${roundTrip.floorCount} drawings alone`);

// The imported drawings are the running state too — a reload must find them.
await reload();
const afterImport = await page.evaluate(() => ({
  drawings: window.__app.draw.count,
  states: window.__app.seqStates.length,
}));
if (afterImport.drawings !== 6) problems.push(`after an import + reload, ${afterImport.drawings} drawings came back, want 6`);
console.log(`--- Import persisted: ${afterImport.drawings} drawings, ${afterImport.states} keyframes after a reload`);
await page.screenshot({ path: `${outDir}/draw-persist-imported.png` });

// Leave the session clean for the next script.
await page.evaluate(() => {
  window.__app.setSeqStates([]);
  window.__app.clearDrawings();
});

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
else console.log('\nAll draw-persistence checks passed.');
console.log(logs.length ? `\nConsole errors:\n${logs.join('\n')}` : '\nNo console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
