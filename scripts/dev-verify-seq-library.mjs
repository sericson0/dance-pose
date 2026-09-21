// Dev check for the SEQUENCE LIBRARY — several named figures beside the one
// timeline, so starting a second giro no longer means exporting a file first or
// losing the first one.
//
// The thing under test is a BUNDLE, not a keyframe list: a saved sequence is
// its keyframes (with their timing, names, captions and kf tags), where the two
// on-screen texts sit, and the floor drawings its kf.draw ids point at. Losing
// any one of those makes the entry unreplayable, and a check that compares only
// `states` passes straight through that — so every comparison here is
// record-for-record over the WHOLE bundle.
//
// What it proves, and why each one is here:
//  1. TWO DIFFERENT SEQUENCES round-trip whole — different keyframe counts,
//     different timing, a caption, a kf.draw tag, its drawings, and a dragged
//     text placement. Saved, the other one loaded over it, then loaded back and
//     compared as JSON against what was saved.
//  2. DEEP COPY BOTH WAYS. setSeqStates keeps the array it is handed and
//     normalizeSeqTiming mutates it in place, so a library entry handed over by
//     reference would be rewritten by the next keyframe edit — silently, and
//     only noticed when the entry is next loaded. Edit the loaded timeline hard
//     (rename, retime, delete a keyframe) and the stored entry must be
//     byte-identical.
//  3. THE DIRTY MARKER is content, not an edited-since flag: it appears on an
//     edit, on a text drag and on a drawing restyle, and clears on Save. It
//     must also be CLEAN the instant a load finishes — if applying a bundle and
//     re-capturing it were not an identity, every freshly loaded sequence would
//     claim unsaved work.
//  4. THE CONFIRMS ARE REAL and live in the UI layer. A dirty Load asks (and
//     dismissing it changes NOTHING); a clean Load asks nothing; an
//     overwrite-Save asks. The scripted app.seqLib* paths must never open one —
//     the headless scripts drive them directly, and a dialog there hangs a run.
//  5. DELETE offers Undo on the status line (single item: no dialog), and the
//     Undo restores the entry AND its place in the order.
//  6. THE ORDER AND THE CURRENT ENTRY SURVIVE A RELOAD, and a sequence named
//     "order" works — the running order lives in its own key precisely so a
//     name cannot collide with it.
//  7. FILE EXPORT → IMPORT equals the library bundle (one capture/apply pair
//     serves both), and a LEGACY file — a bare array, and the object form with
//     no `drawings`/`textPos` — imports exactly as before, leaving the floor
//     alone.
//  8. A FULL QUOTA IS REPORTED. Bundles are big; a Save that silently did
//     nothing is a figure lost at the next New. Simulated by stubbing
//     localStorage.setItem to throw for the library key alone.
//
// Usage: node scripts/dev-verify-seq-library.mjs <outDir>   (dev server up)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-seq-library';
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173/';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950'],
  userDataDir: `${process.env.TEMP}/verify-seq-library`,
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

// Every window.confirm the page raises lands here, so a dialog can be both
// OBSERVED (it happened) and answered. Puppeteer blocks the page until it is
// handled, which is also what makes "no dialog" testable: nothing is recorded.
const dialogs = [];
let dialogAnswer = true;
page.on('dialog', async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  await (dialogAnswer ? d.accept() : d.dismiss());
});
const takeDialogs = () => dialogs.splice(0, dialogs.length);

await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const KEYS = {
  lib: 'tangoPoseStudio.seqLibrary.v1',
  order: 'tangoPoseStudio.seqLibOrder.v1',
  cur: 'tangoPoseStudio.seqCurrent.v1',
  seq: 'tangoPoseStudio.sequence.v1',
  text: 'tangoPoseStudio.seqText.v1',
  draw: 'tangoPoseStudio.drawings.v1',
};

// A clean slate in every store this touches, so a previous run cannot pass a
// check for us.
await page.evaluate((keys) => {
  const app = window.__app;
  app.setSeqStates([]);
  app.clearKeyframeExtras();
  app.clearDrawings();
  app.setSeqTextPositions(null);
  for (const k of Object.values(keys)) localStorage.removeItem(k);
  app.setBackdrop('dark');
  app.setFrame('slide');
  // The Sequence section and the library block both open, so a screenshot at
  // the end shows the real panel and a click can reach the rows.
  document.querySelector('#sidebar-tabs [data-tab="teach"]').click();
  const sec = document.getElementById('sequence-section');
  if (sec.classList.contains('collapsed')) sec.querySelector('.collapse-toggle').click();
  const lib = document.getElementById('seq-lib');
  if (lib.classList.contains('collapsed')) lib.querySelector('.sub-toggle').click();
}, KEYS);

// ---- build figure A, save it ------------------------------------------------
// Three keyframes, uneven timing, a caption, a dragged caption placement, two
// floor drawings and a kf.draw tag naming one of them.
const savedA = await page.evaluate(() => {
  const app = window.__app;
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.seqSetName(0, 'salida');
  app.seqSetName(1, 'cross');
  app.seqSetTravel(1, 3.5);
  app.seqSetHold(1, 1.25);
  app.seqSetCaption(1, 'Weight over the standing foot');
  app.seqSetTextStyle(1, 'caption', { color: '#ff2d55' });
  const l1 = app.addDrawLine([0, 0], [0.5, 0.5]);
  const c1 = app.addDrawCircle([0.2, 0.2], 0.3);
  app.seqSetDrawIds(1, [l1.userData.annotation.id]);
  app.setSeqTextPos('caption', { x: 0.31, y: 0.58 });
  const ok = app.seqLibSave('Salida to cross');
  return {
    ok,
    bundle: app.seqBundle(),
    entry: app.seqLibEntry('Salida to cross'),
    current: app.seqLibCurrent(),
    names: app.seqLibNames(),
    drawIds: [l1.userData.annotation.id, c1.userData.annotation.id],
  };
});
console.log('--- A saved:', JSON.stringify({
  ok: savedA.ok, current: savedA.current, names: savedA.names,
  keyframes: savedA.bundle.states.length, drawings: savedA.bundle.drawings.length,
  textPos: savedA.bundle.textPos, tagged: savedA.bundle.states[1].kf,
}));
if (!savedA.ok) problems.push('seqLibSave refused to save figure A');
if (!same(savedA.entry, savedA.bundle)) problems.push('the stored entry is not the bundle that was captured');
if (savedA.current.name !== 'Salida to cross') problems.push(`current entry is ${JSON.stringify(savedA.current)}`);
if (savedA.current.dirty) problems.push('the timeline reads DIRTY the instant it was saved');
if (savedA.bundle.drawings.length !== 2) problems.push(`the bundle carries ${savedA.bundle.drawings.length} drawings, expected 2`);
if (!savedA.bundle.textPos?.caption) problems.push('the bundle lost the dragged caption placement');

// ---- build figure B over it, save it ---------------------------------------
// A DIFFERENT shape in every respect the bundle carries: two keyframes, no
// caption, its own drawings (a fresh floor), a name placement rather than a
// caption one.
const savedB = await page.evaluate(() => {
  const app = window.__app;
  app.seqLibNew();
  app.clearDrawings();
  app.setSeqTextPositions(null);
  app.applyPreset(3); app.seqAdd();
  app.applyPreset(4); app.seqAdd();
  app.seqSetName(0, 'ocho start');
  app.seqSetName(1, 'ocho pivot');
  app.seqSetTravel(1, 0.8);
  const t = app.addDrawText([0.4, -0.3], 'pivot here');
  app.seqSetDrawIds(0, [t.userData.annotation.id]);
  app.setSeqTextPos('name', { x: 0.66, y: 0.14 });
  const ok = app.seqLibSave('Ocho');
  return { ok, bundle: app.seqBundle(), current: app.seqLibCurrent(), names: app.seqLibNames() };
});
console.log('--- B saved:', JSON.stringify({
  ok: savedB.ok, current: savedB.current, names: savedB.names,
  keyframes: savedB.bundle.states.length, drawings: savedB.bundle.drawings.length,
  textPos: savedB.bundle.textPos,
}));
if (savedB.names.join(' | ') !== 'Salida to cross | Ocho') {
  problems.push(`the order is [${savedB.names}], expected the save order`);
}
if (savedB.current.dirty) problems.push('B reads dirty immediately after its save');

// ---- 1. load each back and compare the WHOLE bundle -------------------------
for (const [name, want] of [['Salida to cross', savedA.bundle], ['Ocho', savedB.bundle]]) {
  const got = await page.evaluate((n) => {
    const app = window.__app;
    app.seqLibLoad(n);
    return {
      bundle: app.seqBundle(),
      current: app.seqLibCurrent(),
      // The drawings really on the floor, and the placement really in the
      // studio — read from the live scene, not from the record we just stored.
      floor: app.drawings.length,
      shown: app.drawShownIds?.length ?? null,
      caption: app.caption(),
      seqName: app.seqNameShown(),
    };
  }, name);
  console.log(`--- loaded "${name}":`, JSON.stringify({
    current: got.current, keyframes: got.bundle.states.length, floor: got.floor,
    textPos: got.bundle.textPos, caption: got.caption, seqName: got.seqName,
  }));
  if (!same(got.bundle, want)) {
    problems.push(`loading "${name}" did not reproduce its bundle`);
    // Name the part that differs, so a failure says where to look.
    for (const part of ['states', 'drawings', 'textPos']) {
      if (!same(got.bundle[part], want[part])) console.log(`    ${part} differs`);
    }
  }
  if (got.current.name !== name) problems.push(`after loading "${name}" the current entry is ${got.current.name}`);
  if (got.current.dirty) problems.push(`"${name}" reads DIRTY the instant it finished loading`);
  if (got.floor !== want.drawings.length) {
    problems.push(`loading "${name}" put ${got.floor} drawings on the floor, expected ${want.drawings.length}`);
  }
  // A load hands the view back: the caption band and the name block belong to
  // the sequence being REPLACED until the new chain is scrubbed.
  if (got.caption || got.seqName) {
    problems.push(`loading "${name}" left the previous sequence's text on screen (name "${got.seqName}", caption "${got.caption}")`);
  }
}

// ---- 2. the library copy is not mutated by editing the loaded timeline ------
const notMutated = await page.evaluate(() => {
  const app = window.__app;
  app.seqLibLoad('Salida to cross');
  const before = app.seqLibEntry('Salida to cross');
  // Everything a timeline edit can reach: the pose, the label, the timing, the
  // kf block, the count — plus the drawings and the placement.
  app.seqSetName(1, 'RENAMED');
  app.seqSetTravel(1, 9);
  app.seqSetCaption(1, 'different words');
  app.seqDelete(2);
  app.setSeqTextPos('caption', { x: 0.1, y: 0.1 });
  app.removeLastDrawing();
  const after = app.seqLibEntry('Salida to cross');
  return { before, after, dirty: app.seqLibCurrent().dirty, live: app.seqStates.length };
});
console.log('--- after editing the loaded timeline:', JSON.stringify({
  entryUntouched: same(notMutated.before, notMutated.after),
  dirty: notMutated.dirty, liveKeyframes: notMutated.live,
}));
if (!same(notMutated.before, notMutated.after)) {
  problems.push('editing the loaded timeline rewrote the LIBRARY entry (a shallow copy somewhere)');
}
if (!same(notMutated.after, savedA.bundle)) problems.push('the stored entry drifted from what was saved');
if (!notMutated.dirty) problems.push('a heavily edited timeline does not read dirty');

// ---- 3. the dirty marker, in the DOM, and what clears it --------------------
const marker = await page.evaluate(() => {
  const app = window.__app;
  const el = document.getElementById('seq-lib-current');
  const read = () => ({ text: el.textContent, cls: el.className, dirty: app.seqLibCurrent().dirty });
  app.seqLibLoad('Salida to cross');
  const clean = read();
  app.seqSetName(0, 'edited');
  const edited = read();
  document.getElementById('seq-lib-update').click(); // the quick Save: no dialog
  const saved = read();
  // A text drag and a drawing restyle are bundle changes too.
  app.setSeqTextPos('name', { x: 0.2, y: 0.2 });
  const afterText = read();
  document.getElementById('seq-lib-update').click();
  // NOTE: app.drawings is the RECORD list; selectDrawing wants the Object3D
  // (it checks the parent), so a record silently selects nothing and the
  // restyle then only sets the style for the NEXT shape.
  app.selectDrawing(app.draw.group.children[0]);
  app.setDrawStyle({ color: '#00ff88' });
  const afterDraw = read();
  document.getElementById('seq-lib-update').click();
  const finalClean = read();
  // …and undoing an edit back to the saved figure stops claiming work is lost
  // (the marker is CONTENT, not an edited-since flag).
  const wasName = app.seqName(0);
  app.seqSetName(0, 'something else');
  const dirtyAgain = read();
  app.seqSetName(0, wasName);
  const backToClean = read();
  return { clean, edited, saved, afterText, afterDraw, finalClean, dirtyAgain, backToClean };
});
console.log('--- dirty marker:', JSON.stringify(marker));
if (marker.clean.dirty || marker.clean.text.includes('•')) problems.push('a freshly loaded sequence shows the dirty marker');
if (!marker.edited.dirty || !marker.edited.text.includes('•')) problems.push('editing a keyframe did not raise the dirty marker');
if (!marker.edited.cls.includes('seq-dirty')) problems.push('the dirty marker carries no seq-dirty class');
if (marker.saved.dirty) problems.push('the quick Save did not clear the dirty marker');
if (!marker.afterText.dirty) problems.push('moving an on-screen text did not dirty the bundle');
if (!marker.afterDraw.dirty) problems.push('restyling a floor drawing did not dirty the bundle');
if (marker.finalClean.dirty) problems.push('the quick Save left the bundle dirty');
if (!marker.dirtyAgain.dirty) problems.push('a rename did not dirty the bundle');
if (marker.backToClean.dirty) problems.push('undoing the edit by hand left the marker dirty — it is a flag, not a comparison');

// ---- 4. the confirms: REAL clicks, dialogs observed -------------------------
// A helper that finds a library row by its name and clicks one of its buttons.
const rowClick = (name, label) => page.evaluate((n, l) => {
  const row = [...document.querySelectorAll('#seq-lib-list .pose-item')]
    .find((r) => r.querySelector('.name')?.textContent === n);
  if (!row) return false;
  // Both, joined: the ✕ and the arrows carry a glyph in textContent and their
  // real meaning in aria-label, so `||` would match only the glyph.
  const btn = [...row.querySelectorAll('button')]
    .find((b) => `${b.textContent} ${b.getAttribute('aria-label') ?? ''}`.includes(l));
  if (!btn) return false;
  btn.click();
  return true;
}, name, label);

// (a) CLEAN timeline loading another: no dialog at all.
takeDialogs();
const cleanLoad = await page.evaluate(() => {
  const app = window.__app;
  app.seqLibLoad('Salida to cross');
  document.getElementById('seq-lib-update').click(); // make certain it is clean
  return app.seqLibCurrent();
});
if (!(await rowClick('Ocho', 'Load'))) problems.push('no Load button on the Ocho row');
await sleep(400);
const cleanDialogs = takeDialogs();
const afterCleanLoad = await page.evaluate(() => window.__app.seqLibCurrent());
console.log('--- clean Load:', JSON.stringify({ from: cleanLoad, dialogs: cleanDialogs, now: afterCleanLoad }));
if (cleanDialogs.length) problems.push(`loading over a CLEAN timeline asked ${JSON.stringify(cleanDialogs)}`);
if (afterCleanLoad.name !== 'Ocho') problems.push('the clean Load did not load');

// (b) DIRTY timeline: asks, and DISMISSING changes nothing.
await page.evaluate(() => window.__app.seqSetName(0, 'unsaved edit'));
const beforeDismiss = await page.evaluate(() => ({
  bundle: window.__app.seqBundle(), current: window.__app.seqLibCurrent(),
}));
dialogAnswer = false;
takeDialogs();
await rowClick('Salida to cross', 'Load');
await sleep(400);
const dismissed = takeDialogs();
const afterDismiss = await page.evaluate(() => ({
  bundle: window.__app.seqBundle(), current: window.__app.seqLibCurrent(),
}));
console.log('--- dirty Load, dismissed:', JSON.stringify({ dialogs: dismissed, current: afterDismiss.current }));
if (dismissed.length !== 1) problems.push(`a dirty Load raised ${dismissed.length} dialogs, expected 1`);
if (!same(beforeDismiss.bundle, afterDismiss.bundle)) problems.push('dismissing the Load confirm loaded anyway');
if (afterDismiss.current.name !== beforeDismiss.current.name) problems.push('dismissing the Load confirm changed the current entry');

// (c) …and ACCEPTING loads.
dialogAnswer = true;
takeDialogs();
await rowClick('Salida to cross', 'Load');
await sleep(400);
const accepted = takeDialogs();
const afterAccept = await page.evaluate(() => window.__app.seqLibCurrent());
console.log('--- dirty Load, accepted:', JSON.stringify({ dialogs: accepted.length, now: afterAccept }));
if (!accepted.length) problems.push('the second dirty Load did not ask');
if (afterAccept.name !== 'Salida to cross' || afterAccept.dirty) {
  problems.push(`accepting the Load left ${JSON.stringify(afterAccept)}`);
}

// (d) overwrite-Save asks; a NEW name does not. And the scripted path never does.
takeDialogs();
await page.evaluate(() => {
  document.getElementById('seq-lib-name').value = 'Salida to cross';
  document.getElementById('seq-lib-save').click();
});
await sleep(300);
const overwriteDialogs = takeDialogs();
await page.evaluate(() => {
  document.getElementById('seq-lib-name').value = 'A brand new name';
  document.getElementById('seq-lib-save').click();
});
await sleep(300);
const newNameDialogs = takeDialogs();
// The scripted path: an overwrite through app.seqLibSave must be silent, or
// every headless run that touches it hangs.
await page.evaluate(() => window.__app.seqLibSave('Salida to cross'));
await sleep(200);
const scriptedDialogs = takeDialogs();
console.log('--- save confirms:', JSON.stringify({
  overwrite: overwriteDialogs.map((d) => d.message),
  newName: newNameDialogs.length, scripted: scriptedDialogs.length,
}));
if (overwriteDialogs.length !== 1) problems.push(`saving over an existing name raised ${overwriteDialogs.length} dialogs`);
if (newNameDialogs.length) problems.push('saving under a fresh name asked a question');
if (scriptedDialogs.length) problems.push('app.seqLibSave opened a dialog — a headless run would hang here');

// (e) New: asks when dirty, silent when clean.
takeDialogs();
await page.evaluate(() => {
  const app = window.__app;
  app.seqLibLoad('Salida to cross');
  document.getElementById('seq-lib-new').click(); // clean → no question
});
await sleep(300);
const cleanNew = takeDialogs();
const afterCleanNew = await page.evaluate(() => ({
  n: window.__app.seqStates.length, cur: window.__app.seqLibCurrent(),
  floor: window.__app.drawings.length,
}));
await page.evaluate(() => {
  const app = window.__app;
  app.seqLibLoad('Ocho');
  app.seqSetName(0, 'dirty');
  document.getElementById('seq-lib-new').click(); // dirty → asks (accepted)
});
await sleep(300);
const dirtyNew = takeDialogs();
const afterDirtyNew = await page.evaluate(() => ({
  n: window.__app.seqStates.length, cur: window.__app.seqLibCurrent(),
  names: window.__app.seqLibNames(),
}));
console.log('--- New:', JSON.stringify({
  cleanDialogs: cleanNew.length, afterCleanNew,
  dirtyDialogs: dirtyNew.length, afterDirtyNew,
}));
if (cleanNew.length) problems.push('New on a clean timeline asked a question');
if (afterCleanNew.n !== 0 || afterCleanNew.cur.name) problems.push('New did not empty the timeline');
if (afterCleanNew.floor === 0) problems.push('New wiped the floor drawings — it must leave the diagram alone');
if (dirtyNew.length !== 1) problems.push(`New on a dirty timeline raised ${dirtyNew.length} dialogs`);
if (afterDirtyNew.n !== 0) problems.push('New did not empty the dirty timeline after the confirm');
if (afterDirtyNew.names.length !== 3) problems.push(`New changed the library (${afterDirtyNew.names.length} entries)`);

// ---- 5. Delete + the status-line Undo ---------------------------------------
takeDialogs();
const beforeDelete = await page.evaluate(() => ({
  names: window.__app.seqLibNames(),
  entry: window.__app.seqLibEntry('Ocho'),
}));
await rowClick('Ocho', 'Delete the saved sequence');
await sleep(300);
const deleteDialogs = takeDialogs();
const afterDelete = await page.evaluate(() => ({
  names: window.__app.seqLibNames(),
  status: document.getElementById('status-line')?.textContent ?? '',
  undo: [...(document.getElementById('status-line')?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
}));
console.log('--- deleted "Ocho":', JSON.stringify(afterDelete));
if (deleteDialogs.length) problems.push('a single Delete interrupted with a dialog');
if (afterDelete.names.includes('Ocho')) problems.push('Delete left the entry in the library');
if (!afterDelete.undo.includes('Undo')) problems.push('Delete offered no Undo on the status line');
await page.evaluate(() => {
  [...document.getElementById('status-line').querySelectorAll('button')]
    .find((b) => b.textContent === 'Undo')?.click();
});
await sleep(300);
const undone = await page.evaluate(() => ({
  names: window.__app.seqLibNames(),
  entry: window.__app.seqLibEntry('Ocho'),
}));
console.log('--- after Undo:', JSON.stringify({ names: undone.names, restored: same(undone.entry, beforeDelete.entry) }));
if (!same(undone.names, beforeDelete.names)) {
  problems.push(`Undo restored the order as [${undone.names}], expected [${beforeDelete.names}]`);
}
if (!same(undone.entry, beforeDelete.entry)) problems.push('Undo restored a different bundle');

// ---- 6. a sequence called "order", then a RELOAD ----------------------------
// The running order lives in its own storage key exactly so this name cannot
// collide with it; if it did, saving "order" would either vanish or corrupt
// every other entry's place.
const orderName = await page.evaluate(() => {
  const app = window.__app;
  app.seqLibLoad('Ocho');
  const ok = app.seqLibSave('order');
  return { ok, names: app.seqLibNames(), entry: !!app.seqLibEntry('order'), current: app.seqLibCurrent() };
});
console.log('--- a sequence named "order":', JSON.stringify(orderName));
if (!orderName.ok || !orderName.entry) problems.push('a sequence named "order" could not be saved');
if (!orderName.names.includes('order')) problems.push('"order" is missing from the list');

const wanted = await page.evaluate(() => {
  const app = window.__app;
  app.seqLibLoad('Salida to cross');
  return { names: app.seqLibNames(), current: app.seqLibCurrent(), bundle: app.seqBundle() };
});
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await sleep(2500);
const reloaded = await page.evaluate(() => {
  const app = window.__app;
  return {
    names: app.seqLibNames(),
    current: app.seqLibCurrent(),
    bundle: app.seqBundle(),
    marker: document.getElementById('seq-lib-current')?.textContent ?? null,
    rows: [...document.querySelectorAll('#seq-lib-list .pose-item .name')].map((n) => n.textContent),
  };
});
console.log('--- after reload:', JSON.stringify({
  names: reloaded.names, current: reloaded.current, marker: reloaded.marker, rows: reloaded.rows,
}));
if (!same(reloaded.names, wanted.names)) problems.push(`the order did not survive the reload ([${reloaded.names}] vs [${wanted.names}])`);
if (reloaded.current.name !== wanted.current.name) problems.push('the current entry did not survive the reload');
if (reloaded.current.dirty) problems.push('an untouched timeline reads DIRTY after a reload');
if (!same(reloaded.bundle, wanted.bundle)) problems.push('the running timeline did not come back byte-identical');
if (!same(reloaded.rows, reloaded.names)) problems.push('the rendered list disagrees with seqLibNames');

// ---- 7. file export → import equals the library bundle ----------------------
const fileTrip = await page.evaluate(async () => {
  const app = window.__app;
  app.seqLibLoad('Salida to cross');
  const bundle = app.seqBundle();

  let blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { blob = b; return orig(b); };
  HTMLAnchorElement.prototype.click = () => {};
  document.getElementById('seq-export').click();
  URL.createObjectURL = orig;
  const payload = JSON.parse(await blob.text());

  // The import confirms when there is something to lose, and the dialog handler
  // outside cannot be used inside an evaluate — stub it for these three loads.
  const realConfirm = window.confirm;
  window.confirm = () => true;
  const input = document.getElementById('seq-file');
  const load = async (obj) => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(obj)], 'seq.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 600));
    return { bundle: app.seqBundle(), floor: app.drawings.length, current: app.seqLibCurrent() };
  };
  app.seqLibNew();
  app.clearDrawings();
  app.setSeqTextPositions(null);
  const imported = await load(payload);

  // LEGACY 1: the object form with no `drawings` and no `textPos` — the file a
  // build before either travelled with a sequence wrote. It must leave the
  // floor exactly as it is and land at the default placement.
  const floorBefore = app.drawingsJSON();
  const legacyObj = { app: 'tangle', type: 'sequence', version: 1, states: payload.states };
  const legacy = await load(legacyObj);
  // LEGACY 2: the bare array, older still.
  const legacyArray = await load(payload.states);

  window.confirm = realConfirm;
  return {
    payloadKeys: Object.keys(payload),
    envelope: { app: payload.app, type: payload.type, version: payload.version },
    bundle, imported,
    legacy: { ...legacy, floorBefore: floorBefore.length, floorSame: JSON.stringify(app.drawingsJSON()) === JSON.stringify(floorBefore) },
    legacyArray,
  };
});
console.log('--- file round trip:', JSON.stringify({
  keys: fileTrip.payloadKeys, envelope: fileTrip.envelope,
  importedEqualsLibrary: same(fileTrip.imported.bundle, fileTrip.bundle),
  importedCurrent: fileTrip.imported.current,
  legacyFloor: [fileTrip.legacy.floorBefore, fileTrip.legacy.floor, fileTrip.legacy.floorSame],
  legacyTextPos: fileTrip.legacy.bundle.textPos,
  legacyArrayKeyframes: fileTrip.legacyArray.bundle.states.length,
}));
if (!same(fileTrip.envelope, { app: 'tangle', type: 'sequence', version: 1 })) {
  problems.push(`the file envelope changed: ${JSON.stringify(fileTrip.envelope)}`);
}
for (const k of ['app', 'type', 'version', 'states', 'drawings', 'textPos']) {
  if (!fileTrip.payloadKeys.includes(k)) problems.push(`the export file lost its "${k}" key`);
}
if (!same(fileTrip.imported.bundle, fileTrip.bundle)) {
  problems.push('export → import does not reproduce the library bundle — the file and the entry are different shapes');
}
if (fileTrip.imported.current.name !== null) {
  problems.push('importing a FILE claimed a library entry it did not come from');
}
if (!fileTrip.legacy.floorSame || fileTrip.legacy.floor !== fileTrip.legacy.floorBefore) {
  problems.push('a legacy file with no `drawings` key changed the floor');
}
if (fileTrip.legacy.bundle.textPos.name !== null || fileTrip.legacy.bundle.textPos.caption !== null) {
  problems.push(`a legacy file with no textPos imported a placement (${JSON.stringify(fileTrip.legacy.bundle.textPos)})`);
}
if (fileTrip.legacyArray.bundle.states.length !== fileTrip.bundle.states.length) {
  problems.push('a bare-array legacy file did not import its keyframes');
}

// ---- 8. a full quota is REPORTED, and nothing pretends to be saved ----------
const quota = await page.evaluate((libKey) => {
  const app = window.__app;
  app.seqLibLoad('order');
  const real = Storage.prototype.setItem;
  Storage.prototype.setItem = function setItem(k, v) {
    if (k === libKey) {
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    }
    return real.call(this, k, v);
  };
  let threw = null;
  let ok = null;
  try { ok = app.seqLibSave('Too big to store'); } catch (e) { threw = String(e); }
  const status = document.getElementById('status-line');
  const out = {
    ok, threw,
    status: status?.textContent ?? '',
    kind: status?.className ?? '',
    names: app.seqLibNames(),
    current: app.seqLibCurrent(),
  };
  Storage.prototype.setItem = real;
  out.after = app.seqLibNames();
  return out;
}, KEYS.lib);
console.log('--- quota:', JSON.stringify(quota));
if (quota.threw) problems.push(`a full quota escaped as an exception: ${quota.threw}`);
if (quota.ok !== false) problems.push('seqLibSave reported success on a failed write');
if (!/storage is full/i.test(quota.status)) problems.push(`the quota failure said "${quota.status}"`);
if (!quota.kind.includes('error')) problems.push(`the quota message is not an error (${quota.kind})`);
if (quota.names.includes('Too big to store')) problems.push('a sequence that was NOT stored appears in the list');
if (quota.current.name === 'Too big to store') problems.push('a failed Save still claimed the timeline as that entry');

// ---- 9. the EASE setting rides in the bundle --------------------------------
// It is a setting of the sequence, not of a keyframe: a figure saved eased and
// loaded linear replays the lesson with a different character. It must also
// DIRTY the entry (it is part of what Save would write), and an entry saved
// before easing existed — no key at all — must load OFF, explicitly, because
// setSeqStates leaves the previous sequence's choice standing.
const easeLib = await page.evaluate(() => {
  const app = window.__app;
  const name = app.seqLibNames()[0];
  app.seqLibLoad(name);
  // The entry was saved from a timeline begun EMPTY, which eases by default —
  // so go to linear first and save THAT, or "turn it on" changes nothing.
  app.setSeqEase(false);
  app.seqLibSave(name);
  app.setSeqEase(true);
  const dirtyOn = app.seqLibCurrent().dirty;
  app.seqLibSave(name);
  const stored = app.seqLibEntry(name).ease;
  app.setSeqEase(false);
  const dirtyOff = app.seqLibCurrent().dirty;
  app.seqLibLoad(name);
  const back = app.seqEase();
  // a legacy entry: strip the key in storage, load it over an EASED timeline
  const KEY = 'tangoPoseStudio.seqLibrary.v1';
  const lib = JSON.parse(localStorage.getItem(KEY));
  delete lib[name].ease;
  localStorage.setItem(KEY, JSON.stringify(lib));
  app.setSeqEase(true);
  app.seqLibLoad(name);
  return { dirtyOn, stored, dirtyOff, back, legacy: app.seqEase(), clean: !app.seqLibCurrent().dirty };
});
console.log(`--- ease in the bundle: ${JSON.stringify(easeLib)}`);
if (!easeLib.dirtyOn || !easeLib.dirtyOff) problems.push('toggling Ease did not dirty the saved sequence');
if (easeLib.stored !== true) problems.push(`the saved entry carries ease=${easeLib.stored}, want true`);
if (easeLib.back !== true) problems.push('loading an eased entry left the timeline linear');
if (easeLib.legacy !== false) problems.push('an entry with no `ease` key loaded EASED — it predates the setting and must play as it did');
if (!easeLib.clean) problems.push('a legacy entry reads as dirty the moment it is loaded');

// ---- the panel, at its real width -------------------------------------------
await page.evaluate(() => {
  const app = window.__app;
  app.seqLibLoad('Salida to cross');
  app.seqSetName(0, 'edited, so the dirty dot shows');
  document.querySelector('#sidebar-tabs [data-tab="teach"]').click();
  const sec = document.getElementById('sequence-section');
  if (sec.classList.contains('collapsed')) sec.querySelector('.collapse-toggle').click();
  const lib = document.getElementById('seq-lib');
  if (lib.classList.contains('collapsed')) lib.querySelector('.sub-toggle').click();
  sec.scrollIntoView({ block: 'start' });
});
await sleep(500);
const sec = await page.$('#sequence-section');
if (sec) await sec.screenshot({ path: `${outDir}/01-sequence-library.png` });
await page.screenshot({ path: `${outDir}/02-panel-in-app.png` });
// …and folded, which is how the block keeps a long panel readable.
await page.evaluate(() => document.querySelector('#seq-lib .sub-toggle').click());
await sleep(300);
if (sec) await sec.screenshot({ path: `${outDir}/03-library-folded.png` });

// ---- tidy up: leave no library behind for the next run ----------------------
await page.evaluate((keys) => {
  const app = window.__app;
  app.setSeqStates([]);
  app.clearKeyframeExtras();
  app.clearDrawings();
  app.setSeqTextPositions(null);
  for (const k of Object.values(keys)) localStorage.removeItem(k);
}, KEYS);

if (problems.length) console.log(`\nPROBLEMS:\n- ${problems.join('\n- ')}`);
else console.log('\nAll sequence-library checks passed.');
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length || problems.length ? 1 : 0);
