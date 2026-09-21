// Dev check for the per-keyframe EDIT FOCUS (✎ on a keyframe row) — "make this
// drawing / this highlight belong to keyframe 3 and to nothing else".
//
// What each section answers, and why it is measured the way it is:
//
//  1. THE DATA MODEL, on what is RENDERED. A drawing's visibility is a `visible`
//     flag plus a raycast filter, and both are downstream of the record — so a
//     check that reads `kf.own` and stops has verified the bookkeeping and not
//     the feature. Every count below is taken from `app.draw.group.children`'s
//     own `visible` flags, and the two decisive cases are re-checked with a REAL
//     POINTER CLICK on the shape (Drawings.pickAt filters to what is SHOWN, so
//     a hidden drawing must not take a click either).
//  2. THE REDUCTION GUARD. With nothing owned anywhere and the keyframe
//     untagged the filter must be exactly `null` — the value every sequence
//     authored before this carries, and the one `setVisibleIds` treats as no
//     filter at all. It is asserted as `=== null`, not as "everything is
//     visible": an explicit list of every id LOOKS identical on screen and is
//     not the same thing (it silently excludes whatever is drawn next).
//     dev-verify-draw-persist.mjs's own 6/6/6/2/2/6 rows are the other half of
//     this and must go on passing unchanged.
//  3. THE MUSCLE SEAM. While a keyframe is focused every Muscles-panel edit
//     writes THAT keyframe, and the user's running look — and
//     `tangoPoseStudio.muscleLook.v1` with it — must come through the session
//     BYTE-IDENTICAL. That storage string is compared as a string, for the
//     reason dev-verify-keyframe-extras.mjs records: a re-serialisation that
//     happens to be equivalent is still the write it is. The lit set is read off
//     the FIGURES (`app.leader.litMuscles` + the bellies' own materials), never
//     off the panel alone.
//  4. EVERY EXIT. A mode with one way in and eight ways out is a mode that gets
//     stuck on, and a stuck focus quietly files a teacher's next hour of
//     drawings under one keyframe. All of them are exercised.
//  5. IDENTITY, NOT INDEX. A reorder must keep the focus on the same keyframe.
//
// Usage: node scripts/dev-verify-seq-focus.mjs <outDir>   (dev server up)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-seq-focus';
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173/';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1800));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);

// Screen (CSS px) coordinates of a world point — the draw gate's helper.
const toScreen = (x, y, z) => page.evaluate(([wx, wy, wz]) => {
  const app = window.__app;
  const v = app.leader.group.position.clone().set(wx, wy, wz);
  v.project(app.camera);
  return [(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight];
}, [x, y, z]);

// ---- setup: three keyframes and two PUBLIC drawings ------------------------
// Public = authored with no keyframe focused, so nobody owns them; they are the
// control group — every untagged keyframe must go on showing both.
const setup = await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.clearDrawings();
  app.setSeqStates([]);
  localStorage.removeItem('tangoPoseStudio.sequence.v1');
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.addDrawCircle({ x: -1.4, z: -1.0 }, 0.3);
  app.addDrawLine({ x: -1.4, z: 1.2 }, { x: -0.4, z: 1.2 });
  return {
    n: app.seqStates.length,
    ids: app.drawings.map((a) => a.id),
    filter: app.drawVisibleIds,
    kfs: app.seqStates.map((s) => s.kf ?? null),
    focus: app.seqFocusIndex(),
  };
});
say(`--- setup: ${JSON.stringify(setup)}`);
if (setup.n !== 3) problems.push(`built ${setup.n} keyframes, want 3`);
if (setup.ids.length !== 2) problems.push(`built ${setup.ids.length} public drawings, want 2`);
if (setup.filter !== null) problems.push(`a fresh session already carries a filter: ${JSON.stringify(setup.filter)}`);
if (setup.kfs.some(Boolean)) problems.push(`a fresh keyframe grew a kf block: ${JSON.stringify(setup.kfs)}`);
if (setup.focus !== -1) problems.push(`something is focused before anything asked (${setup.focus})`);
const PUBLIC = setup.ids;

// ---- 1. taking the focus ---------------------------------------------------
// A REAL click on the row's ✎, not app.seqFocus: the button, its pressed state,
// the row mark and the banner are the whole durable indicator of this mode.
await page.evaluate(() => {
  const s = document.getElementById('sequence-section');
  if (s.classList.contains('collapsed')) s.querySelector('.collapse-toggle').click();
  document.querySelector('#tab-strip button[data-tab="teach"]')?.click();
});
await sleep(200);
await page.evaluate(() => document.querySelectorAll('#seq-list .seq-focus-btn')[1].click());
await sleep(250);
const entered = await page.evaluate(() => {
  const app = window.__app;
  const row = document.querySelectorAll('#seq-list .pose-item')[1];
  return {
    index: app.seqFocusIndex(),
    pressed: document.querySelectorAll('#seq-list .seq-focus-btn')[1].getAttribute('aria-pressed'),
    rowMarked: row.classList.contains('seq-focus'),
    banner: !document.getElementById('seq-focus-note').hidden,
    bannerText: document.getElementById('seq-focus-note').textContent.replace(/\s+/g, ' ').trim(),
    muscleNote: !document.getElementById('muscle-focus-note').hidden,
    status: document.getElementById('status-line').textContent,
    // Entering shows the keyframe, so the couple must be standing at it.
    posedAt: JSON.stringify(app.leader.getPose().position)
      === JSON.stringify(app.seqStates[1].figures[0].position),
    kf: app.seqStates[1].kf ?? null,
  };
});
say(`--- ✎ on row 2: ${JSON.stringify(entered)}`);
if (entered.index !== 1) problems.push(`✎ focused keyframe ${entered.index + 1}, want 2`);
if (entered.pressed !== 'true' || !entered.rowMarked) problems.push('the focused row does not read as focused');
if (!entered.banner) problems.push('no durable banner while a keyframe is focused');
if (!entered.muscleNote) problems.push('the Muscles panel does not say the edits are scoped');
if (!entered.posedAt) problems.push('taking the focus did not show the keyframe');
if (entered.kf) problems.push(`taking the focus wrote into the keyframe: ${JSON.stringify(entered.kf)}`);

// ---- 2. a drawing authored while focused belongs to that keyframe ----------
// REAL two-click authoring in Draw mode, from the top view (so a floor click
// lands where it is aimed and the finished line is easy to click again).
await page.evaluate(() => window.__app.setView('top'));
await sleep(500);
await page.click('#mode-buttons button[data-mode="draw"]');
await page.click('#draw-tools button[data-tool="line"]');
await sleep(150);
const OWN_A = [0.6, -1.1], OWN_B = [1.6, -1.1];
const [ax, ay] = await toScreen(OWN_A[0], 0, OWN_A[1]);
const [bx, by] = await toScreen(OWN_B[0], 0, OWN_B[1]);
await page.mouse.click(ax, ay);
await sleep(120);
await page.mouse.move((ax + bx) / 2, (ay + by) / 2);
await sleep(80);
await page.mouse.click(bx, by);
await sleep(250);
const authored = await page.evaluate(() => {
  const app = window.__app;
  return {
    n: app.drawings.length,
    last: app.drawings.at(-1),
    own: app.seqOwnIds(1),
    otherOwn: [app.seqOwnIds(0), app.seqOwnIds(2)],
    filter: app.drawVisibleIds,
    visible: app.draw.group.children.filter((o) => o.visible).length,
    tag: [...document.querySelectorAll('#draw-tools')].length
      && !document.getElementById('draw-focus-tag').hidden,
  };
});
const OWNED = authored.last?.id;
say(`--- drawn while focused: id ${OWNED}, own ${JSON.stringify(authored.own)}, others ${JSON.stringify(authored.otherOwn)}, ${authored.visible} of ${authored.n} showing`);
if (authored.n !== 3) problems.push(`two real clicks authored ${authored.n - 2} drawings, want 1`);
if (!OWNED || JSON.stringify(authored.own) !== JSON.stringify([OWNED])) {
  problems.push(`the new drawing was not filed under the focused keyframe (own ${JSON.stringify(authored.own)})`);
}
if (authored.otherOwn.some((o) => o !== null)) problems.push('another keyframe claimed it too');
if (authored.visible !== 3) problems.push(`the keyframe being edited hides its own new drawing (${authored.visible} of 3)`);
if (!authored.tag) problems.push('the Draw toolbar does not show the focus');
await page.screenshot({ path: `${outDir}/focus-draw-toolbar.png`, clip: { x: 0, y: 0, width: 1500, height: 120 } });

// ---- 3. it shows on keyframe 2 and NOWHERE else -----------------------------
// Across a t sweep AND through Show, because those are two different seams onto
// a keyframe (applyStatesT and seqApply) and only one of them used to exist.
const sweep = await page.evaluate((owned) => {
  const app = window.__app;
  const shown = () => app.draw.group.children.filter((o) => o.visible)
    .map((o) => o.userData.annotation.id);
  const out = { scrub: [], show: [] };
  // t = 0 / 0.2 travel FROM keyframe 1; 0.5 reaches keyframe 2; 0.75 is inside
  // its segment; 1 reaches keyframe 3.
  for (const t of [0, 0.2, 0.5, 0.75, 1]) {
    app.applySeqT(t);
    out.scrub.push({ t, ids: shown(), owned: shown().includes(owned) });
  }
  for (let i = 0; i < 3; i++) {
    app.seqApply(i);
    out.show.push({ i, ids: shown(), owned: shown().includes(owned) });
  }
  return out;
}, OWNED);
say(`--- scrub: ${sweep.scrub.map((r) => `t${r.t}:${r.ids.length}${r.owned ? '+own' : ''}`).join(' ')}`);
say(`--- Show : ${sweep.show.map((r) => `kf${r.i + 1}:${r.ids.length}${r.owned ? '+own' : ''}`).join(' ')}`);
const wantScrub = [false, false, true, true, false];
sweep.scrub.forEach((r, k) => {
  if (r.owned !== wantScrub[k]) {
    problems.push(`at t=${r.t} the owned drawing is ${r.owned ? 'showing' : 'hidden'}, want the opposite`);
  }
  for (const id of PUBLIC) {
    if (!r.ids.includes(id)) problems.push(`at t=${r.t} a PUBLIC drawing (${id}) went missing`);
  }
});
sweep.show.forEach((r) => {
  if (r.owned !== (r.i === 1)) {
    problems.push(`Show on keyframe ${r.i + 1} ${r.owned ? 'shows' : 'hides'} the owned drawing`);
  }
});

// The RAYCAST half: a hidden drawing must not take a click either. Same screen
// point (the midpoint of a straight world segment lies on its straight image),
// once where it is shown and once where it is not.
const [mx, my] = [(ax + bx) / 2, (ay + by) / 2];
const pickAt = async (i) => {
  await page.evaluate((k) => window.__app.seqApply(k), i);
  await sleep(200);
  await page.evaluate(() => window.__app.selectDrawing(null));
  await page.mouse.click(mx, my);
  await sleep(200);
  return page.evaluate(() => window.__app.drawSelected?.userData.annotation.id ?? null);
};
const pickOn = await pickAt(1);
const pickOff = await pickAt(0);
say(`--- real click on the owned line: keyframe 2 → ${pickOn}, keyframe 1 → ${pickOff}`);
if (pickOn !== OWNED) problems.push(`a click on the owned drawing at its own keyframe selected ${pickOn}`);
if (pickOff !== null) problems.push(`a hidden drawing still took a click (${pickOff})`);

// ---- 4. claim and release an existing drawing -------------------------------
// The toolbar toggle, with a drawing selected while focused — the way a shape
// authored earlier joins a keyframe.
await page.evaluate(() => {
  const app = window.__app;
  app.seqFocus(1);
  app.selectDrawing(app.draw.group.children[0]); // a PUBLIC one
});
await sleep(200);
const claim = await page.evaluate((pub) => {
  const app = window.__app;
  const shown = () => app.draw.group.children.filter((o) => o.visible)
    .map((o) => o.userData.annotation.id);
  const btn = document.getElementById('draw-own');
  const before = btn.textContent;
  btn.click();
  const owned = app.seqOwnIds(1);
  // Show on ANOTHER row is itself an exit (section 11), so the focus is
  // retaken before the release — reading the other keyframe must not silently
  // end the session this check is still inside.
  app.seqApply(0);
  const atOther = shown().includes(pub[0]);
  app.seqFocus(1);
  const atOwn = shown().includes(pub[0]);
  // Re-select it: showing the OTHER keyframe hid this drawing, and
  // setVisibleIds drops a selection that has gone off screen (handles over
  // nothing, and the ray would still find them). So the toolbar has no target
  // until the user picks it again — which is right, and is what this re-select
  // stands in for.
  app.selectDrawing(app.draw.group.children[0]);
  const label = document.getElementById('draw-own').textContent;
  const stillFocused = app.seqFocusIndex();
  document.getElementById('draw-own').click(); // release
  const ownAfter = app.seqOwnIds(1);
  app.seqApply(0);
  const released = shown().includes(pub[0]);
  return { before, owned, atOther, atOwn, label, released, ownAfter, stillFocused };
}, PUBLIC);
say(`--- claim/release: "${claim.before}" → owns ${JSON.stringify(claim.owned)}; at kf1 ${claim.atOther}, at kf2 ${claim.atOwn}; "${claim.label}" → released, kf1 ${claim.released}`);
if (claim.stillFocused !== 1) problems.push(`re-taking the focus after Show landed on ${claim.stillFocused}`);
if (!claim.owned?.includes(PUBLIC[0])) problems.push('claiming did not add the drawing to kf.own');
if (claim.atOther) problems.push('a claimed drawing still shows on another keyframe');
if (!claim.atOwn) problems.push('a claimed drawing stopped showing on its own keyframe');
if (claim.released !== true) problems.push('releasing did not put the drawing back on every keyframe');
if (claim.ownAfter?.includes(PUBLIC[0])) problems.push('releasing left the id in kf.own');

// ---- 5. a TAGGED keyframe shows its subset ∪ its own ------------------------
const tagged = await page.evaluate((pub) => {
  const app = window.__app;
  const shown = () => app.draw.group.children.filter((o) => o.visible)
    .map((o) => o.userData.annotation.id);
  app.seqSetDrawIds(1, [pub[0]]);          // tag: one public drawing only
  app.seqApply(1);
  return { ids: shown(), kf: JSON.parse(JSON.stringify(app.seqStates[1].kf)) };
}, PUBLIC);
say(`--- tagged ∪ own: ${JSON.stringify(tagged.ids)} from ${JSON.stringify(tagged.kf)}`);
if (!tagged.ids.includes(PUBLIC[0]) || !tagged.ids.includes(OWNED) || tagged.ids.includes(PUBLIC[1])) {
  problems.push(`a tagged keyframe showed ${JSON.stringify(tagged.ids)}, want [${PUBLIC[0]}, ${OWNED}]`);
}

// ---- 6. ◻ Drawings capture EXCLUDES what the keyframe owns ------------------
// An owned id captured into kf.draw is a ghost: release the drawing later and
// the keyframe goes on showing it with nothing to say why.
const capture = await page.evaluate(() => {
  const app = window.__app;
  app.seqSetDrawIds(1, null);
  app.seqApply(1);
  const onScreen = app.drawShownIds;
  const btn = document.querySelectorAll('#seq-list .seq-draw-btn')[1];
  const before = btn.textContent;
  btn.click();
  const stored = app.seqDrawIds(1);
  const own = app.seqOwnIds(1);
  const shown = app.draw.group.children.filter((o) => o.visible).length;
  return {
    onScreen, stored, own, shown, before,
    after: document.querySelectorAll('#seq-list .seq-draw-btn')[1].textContent,
    kfBtns: document.querySelectorAll('#seq-list .seq-kf-btn').length,
  };
});
say(`--- ◻ Drawings: on screen ${JSON.stringify(capture.onScreen)} → stored ${JSON.stringify(capture.stored)} (own ${JSON.stringify(capture.own)}), "${capture.before}" → "${capture.after}", still ${capture.shown} showing`);
if (capture.stored?.includes(OWNED)) problems.push('the capture stored an OWNED id in kf.draw');
if (JSON.stringify(capture.stored) !== JSON.stringify(capture.onScreen.filter((i) => i !== OWNED))) {
  problems.push(`the capture stored ${JSON.stringify(capture.stored)}, want everything on screen but the owned one`);
}
if (capture.shown !== capture.onScreen.length) problems.push('capturing changed what is on screen');
if (!/^◻/.test(capture.before) || !/^◼/.test(capture.after)) {
  problems.push(`the drawings tag reads "${capture.before}" → "${capture.after}"`);
}
// One .seq-kf-btn per row still (the MUSCLE tag) — the selector the extras gate
// indexes by. The drawings tag wears its own class.
if (capture.kfBtns !== 3) problems.push(`${capture.kfBtns} .seq-kf-btn for 3 rows — the drawings tag stole the selector`);

// ---- 7a. deleting a drawing PRUNES the ids that named it --------------------
// A stale id is harmless on screen (it matches no child, so it filters
// nothing) — but it keeps `owned` non-empty, and that alone stops the
// reduction below from ever firing again.
const pruned = await page.evaluate(() => {
  const app = window.__app;
  app.seqFocus(null);
  const before = app.seqStates.map((s) => s.kf?.own ?? null);
  app.clearDrawings();
  return { before, after: app.seqStates.map((s) => s.kf?.own ?? null) };
});
say(`--- prune on delete: own ${JSON.stringify(pruned.before)} → ${JSON.stringify(pruned.after)}`);
if (!pruned.before.some(Boolean)) problems.push('nothing was owned going into the prune check');
if (pruned.after.some(Boolean)) problems.push(`removing the drawings left stale ids: ${JSON.stringify(pruned.after)}`);

// ---- 7b. the REDUCTION GUARD -----------------------------------------------
// Nothing owned anywhere + an untagged keyframe = exactly `null`.
const reduction = await page.evaluate(() => {
  const app = window.__app;
  app.seqFocus(null);
  app.addDrawCircle({ x: -1.4, z: -1.0 }, 0.3);
  app.addDrawLine({ x: -1.4, z: 1.2 }, { x: -0.4, z: 1.2 });
  for (let i = 0; i < app.seqStates.length; i++) {
    app.seqSetOwnIds(i, null);
    app.seqSetDrawIds(i, null);
  }
  const out = [];
  for (const t of [0, 0.3, 0.5, 1]) { app.applySeqT(t); out.push(app.drawVisibleIds); }
  app.seqApply(1);
  const viaShow = app.drawVisibleIds;
  app.clearKeyframeExtras();
  return { out, viaShow, off: app.drawVisibleIds, kfs: app.seqStates.map((s) => s.kf ?? null) };
});
say(`--- reduction: scrub ${JSON.stringify(reduction.out)}, Show ${JSON.stringify(reduction.viaShow)}, off-timeline ${JSON.stringify(reduction.off)}`);
if (reduction.out.some((f) => f !== null) || reduction.viaShow !== null || reduction.off !== null) {
  problems.push('with nothing owned the filter is not exactly null — an explicit list is NOT the same thing');
}
if (reduction.kfs.some(Boolean)) problems.push(`clearing own/draw left a kf block: ${JSON.stringify(reduction.kfs)}`);

// ---- 8. delete the keyframe: its drawings go, Undo brings both back ---------
const del = await page.evaluate(() => {
  const app = window.__app;
  app.seqFocus(1);
  app.addDrawLine({ x: 2.0, z: 0.2 }, { x: 2.6, z: 0.2 });   // owned by kf 2
  const mine = app.seqOwnIds(1);
  const before = app.drawings.length;
  [...document.querySelectorAll('#seq-list .pose-item')[1].querySelectorAll('button')].at(-1).click(); // ✕ — the row's LAST button, not a fixed index: the row keeps gaining controls
  const afterN = app.seqStates.length;
  const afterDraw = app.drawings.length;
  const focusAfter = app.seqFocusIndex();
  const status = document.getElementById('status-line').textContent;
  document.querySelector('#status-line button').click();       // Undo
  return {
    mine, before, afterN, afterDraw, focusAfter, status,
    keyframes: app.seqStates.length,
    drawings: app.drawings.length,
    ids: app.drawings.map((a) => a.id),
    own: app.seqOwnIds(1),
  };
});
say(`--- delete + Undo: ${del.before} drawings → ${del.afterDraw}, ${del.afterN} keyframes; Undo → ${del.keyframes} keyframes, ${del.drawings} drawings, own ${JSON.stringify(del.own)}`);
say(`    status said: "${del.status}"`);
if (del.afterDraw !== del.before - 1) problems.push(`deleting the keyframe left ${del.afterDraw} drawings, want ${del.before - 1}`);
if (del.afterN !== 2) problems.push(`✕ left ${del.afterN} keyframes, want 2`);
if (del.focusAfter !== -1) problems.push('deleting the focused keyframe left the focus on');
if (del.keyframes !== 3 || del.drawings !== del.before) problems.push('Undo did not restore BOTH the keyframe and its drawings');
if (JSON.stringify(del.own) !== JSON.stringify(del.mine)) {
  problems.push(`Undo restored the keyframe with own ${JSON.stringify(del.own)}, want ${JSON.stringify(del.mine)}`);
}

// ---- 9. a SHARED drawing survives while one owner is left ------------------
// Union semantics: a duplicated keyframe legitimately lists the same ids, and a
// drawing is dropped only when its LAST owner goes.
const shared = await page.evaluate(() => {
  const app = window.__app;
  const id = app.seqOwnIds(1).at(-1);
  app.seqOwnDrawing(2, id, true);       // now owned by keyframes 2 AND 3
  const before = app.drawings.length;
  app.seqDelete(1);
  const survived = app.drawings.some((a) => a.id === id);
  const stillOwned = app.seqOwnIds(1);  // keyframe 3 has slid into index 1
  app.seqDelete(1);                     // its LAST owner
  return { id, before, survived, stillOwned, after: app.drawings.length, gone: !app.drawings.some((a) => a.id === id) };
});
say(`--- shared ${shared.id}: after the first owner went ${shared.survived ? 'survived' : 'GONE'} (owned by ${JSON.stringify(shared.stillOwned)}), after the last ${shared.gone ? 'gone' : 'STILL THERE'}`);
if (!shared.survived) problems.push('a drawing two keyframes owned was deleted with the first of them');
if (!shared.gone) problems.push('a drawing was kept after its last owner was deleted');

// ---- 10. a reorder keeps the focus on the SAME keyframe --------------------
const reorder = await page.evaluate(() => {
  const app = window.__app;
  app.setSeqStates([]);
  app.clearDrawings();
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.seqSetName(1, 'the cross');
  app.seqFocus(1);
  const before = { i: app.seqFocusIndex(), name: app.seqName(app.seqFocusIndex()) };
  app.seqMoveTo(1, 0);                  // drag it to the top
  const after = { i: app.seqFocusIndex(), name: app.seqName(app.seqFocusIndex()) };
  const marked = [...document.querySelectorAll('#seq-list .pose-item')]
    .map((r) => r.classList.contains('seq-focus'));
  return { before, after, marked };
});
say(`--- reorder: focus was ${reorder.before.i} "${reorder.before.name}" → ${reorder.after.i} "${reorder.after.name}"; rows marked ${JSON.stringify(reorder.marked)}`);
if (reorder.after.name !== reorder.before.name) problems.push('a reorder moved the focus to a different keyframe');
if (reorder.after.i !== 0) problems.push(`the focus followed the row to index ${reorder.after.i}, want 0`);
if (JSON.stringify(reorder.marked) !== JSON.stringify([true, false, false])) {
  problems.push(`the wrong row is marked after a reorder: ${JSON.stringify(reorder.marked)}`);
}

// ---- 11. every exit --------------------------------------------------------
const exits = await page.evaluate(async () => {
  const app = window.__app;
  const out = {};
  const take = () => app.seqFocus(1);
  const gone = (k) => { out[k] = app.seqFocusIndex(); };

  take(); document.querySelectorAll('#seq-list .seq-focus-btn')[1].click(); gone('pencil-again');
  take(); app.cancelPending(); gone('escape');
  take(); app.seqFocus(2); out['another-row'] = app.seqFocusIndex(); // MOVES, does not end
  app.seqFocus(null);
  take(); app.seqApply(0); gone('show-other');
  take(); app.seqApply(1); out['show-same'] = app.seqFocusIndex();   // keeps it
  app.seqFocus(null);
  take(); app.applySeqT(0.4); gone('scrub');
  take(); app.playSeq(null); app.stopSeq(); gone('play');
  take(); app.enterPresent(); gone('present'); app.exitPresent();
  // ⟳ REPLACES the keyframe object, and the focus is tracked by identity — the
  // natural gesture (focus, adjust the pose, re-record) must not end the session,
  // and neither must undoing it.
  take(); app.seqUpdate(1); out['re-record'] = app.seqFocusIndex();
  document.querySelector('#status-line button')?.click(); out['re-record-undo'] = app.seqFocusIndex();
  app.seqFocus(null);
  // Add and ⧉-of-the-focused-row move the playhead to a NEW keyframe: drawings
  // made from there on must not go on being filed under the old one.
  take(); { const at = app.seqAdd(); gone('add'); app.seqDelete(at); }
  take(); { const at = app.seqDuplicate(1); gone('duplicate-self'); app.seqDelete(at); }
  take(); { const at = app.seqDuplicate(0); out['duplicate-other'] = app.seqFocusIndex(); app.seqFocus(null); app.seqDelete(at); }
  take(); app.setSeqStates(app.seqStates.slice()); gone('load');
  return out;
}, null);
say(`--- exits: ${JSON.stringify(exits)}`);
for (const k of ['pencil-again', 'escape', 'show-other', 'scrub', 'play', 'present', 'add', 'duplicate-self', 'load']) {
  if (exits[k] !== -1) problems.push(`"${k}" left the focus on keyframe ${exits[k] + 1}`);
}
if (exits['another-row'] !== 2) problems.push('focusing another row did not move the focus there');
if (exits['show-same'] !== 1) problems.push('Show on the FOCUSED row dropped its own focus');
if (exits['re-record'] !== 1) problems.push(`⟳ on the focused keyframe moved the focus to ${exits['re-record']}`);
if (exits['re-record-undo'] !== 1) problems.push(`undoing that ⟳ moved the focus to ${exits['re-record-undo']}`);
if (exits['duplicate-other'] !== 2) problems.push(`⧉ on ANOTHER row should keep the focus on the same keyframe (now row 3), got ${exits['duplicate-other']}`);

// Esc order: a running playback and a half-drawn shape both come first, and
// leaving the focus must not ALSO deselect in the same press.
const escOrder = await page.evaluate(() => {
  const app = window.__app;
  app.seqFocus(1);
  app.selectJoint(app.leader, 'elbow_L');
  const first = app.cancelPending();
  return { first, focus: app.seqFocusIndex(), stillSelected: !!app.selected, second: app.cancelPending() };
});
say(`--- Esc: first press → "${escOrder.first}" (focus ${escOrder.focus}, selection kept ${escOrder.stillSelected}), second → "${escOrder.second}"`);
if (escOrder.first !== 'seqfocus') problems.push(`Esc reported "${escOrder.first}" instead of leaving the focus`);
if (!escOrder.stillSelected) problems.push('one Esc left the focus AND deselected');

// ---- 12. the MUSCLE seam ---------------------------------------------------
// Two REAL chip clicks and a REAL swatch edit while focused. The running look
// must come through byte-identical, and the other keyframes must go on showing
// it.
const musNames = await page.evaluate(() => {
  const app = window.__app;
  const labels = (app.muscles || []).map((m) => m.label);
  return { running: labels[0], a: labels[1], b: labels[2], n: labels.length };
});
if (musNames.n < 3) problems.push(`only ${musNames.n} muscles in the atlas — the muscle checks cannot run`);
say(`--- muscle probes: running "${musNames.running}", focused "${musNames.a}" + "${musNames.b}"`);

const chipClick = (label) => page.evaluate((l) => {
  const row = [...document.querySelectorAll('#muscle-list .muscle-row')]
    .find((r) => r.querySelector('label')?.textContent.trim() === l);
  row.querySelector('.muscle-hl').click();
}, label);

// Set the RUNNING look first, with no keyframe focused, and let it save.
await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  const sel = document.getElementById('layer-mode');
  sel.value = 'muscle';
  sel.dispatchEvent(new Event('change'));
  const s = document.getElementById('muscle-section');
  if (s.classList.contains('collapsed')) s.querySelector('.collapse-toggle').click();
  document.querySelector('#muscle-clear-hl').click();
  await new Promise((r) => requestAnimationFrame(r));
});
await chipClick(musNames.running);
await sleep(200);
const lookBefore = await page.evaluate(() => localStorage.getItem('tangoPoseStudio.muscleLook.v1'));

await page.evaluate(() => window.__app.seqFocus(1));
await sleep(250);
await chipClick(musNames.a);
await sleep(150);
await chipClick(musNames.b);
await sleep(150);
await page.evaluate((l) => {
  const row = [...document.querySelectorAll('#muscle-list .muscle-row')]
    .find((r) => r.querySelector('label')?.textContent.trim() === l);
  const sw = row.querySelector('.chip-color');
  sw.value = '#22ff55';
  sw.dispatchEvent(new Event('input'));
}, musNames.a);
await sleep(250);

const musDuring = await page.evaluate((names) => {
  const app = window.__app;
  const bellies = (label) => {
    const out = [];
    app.leader.group.traverse((o) => { if (o.userData?.muscleName === label) out.push(o); });
    return out;
  };
  const chips = () => [...document.querySelectorAll('#muscle-list .muscle-hl.active')]
    .map((b) => b.parentElement.querySelector('label').textContent.trim()).sort();
  return {
    kf: JSON.parse(JSON.stringify(app.seqMuscles(1))),
    onFigure: [...(app.leader.litMuscles ?? [])].sort(),
    colorOnBelly: bellies(names.a)[0]?.material.color.getHexString() ?? null,
    chips: chips(),
    store: localStorage.getItem('tangoPoseStudio.muscleLook.v1'),
    banner: !document.getElementById('muscle-focus-note').hidden,
  };
}, musNames);
say(`--- focused muscle edits: kf.muscles ${JSON.stringify(musDuring.kf)}`);
say(`    on the figure ${JSON.stringify(musDuring.onFigure)}, belly colour #${musDuring.colorOnBelly}, chips ${JSON.stringify(musDuring.chips)}`);
const wantLit = [musNames.running, musNames.a, musNames.b].sort();
if (JSON.stringify([...(musDuring.kf?.lit ?? [])].sort()) !== JSON.stringify(wantLit)) {
  problems.push(`the keyframe stored ${JSON.stringify(musDuring.kf?.lit)}, want ${JSON.stringify(wantLit)} (seeded from the running look, then the two clicks)`);
}
if (!(musDuring.kf?.colors ?? []).some(([l, h]) => l === musNames.a && h === '#22ff55')) {
  problems.push(`the colour did not reach the keyframe: ${JSON.stringify(musDuring.kf?.colors)}`);
}
if (musDuring.colorOnBelly !== '22ff55') problems.push(`the colour did not reach the belly (#${musDuring.colorOnBelly})`);
if (JSON.stringify(musDuring.onFigure) !== JSON.stringify(wantLit)) {
  problems.push(`the figures show ${JSON.stringify(musDuring.onFigure)}, want ${JSON.stringify(wantLit)}`);
}
if (!musDuring.banner) problems.push('the Muscles panel stopped saying the edits are scoped');
if (musDuring.store !== lookBefore) {
  problems.push(`a focused edit rewrote the saved running look:\n  before ${lookBefore}\n  after  ${musDuring.store}`);
}

// The other keyframes still show the RUNNING look, and leaving hands the panel
// back to it.
const musAfter = await page.evaluate(async (names) => {
  const app = window.__app;
  const chips = () => [...document.querySelectorAll('#muscle-list .muscle-hl.active')]
    .map((b) => b.parentElement.querySelector('label').textContent.trim()).sort();
  app.seqApply(0);
  await new Promise((r) => requestAnimationFrame(r));
  const atOther = { lit: [...(app.leader.litMuscles ?? [])].sort(), chips: chips() };
  app.clearKeyframeExtras();
  await new Promise((r) => requestAnimationFrame(r));
  const offTimeline = { lit: [...(app.leader.litMuscles ?? [])].sort(), chips: chips() };
  app.seqFocus(1);
  await new Promise((r) => requestAnimationFrame(r));
  const backIn = { lit: [...(app.leader.litMuscles ?? [])].sort(), chips: chips() };
  app.seqFocus(null);
  await new Promise((r) => requestAnimationFrame(r));
  return {
    atOther, offTimeline, backIn,
    store: localStorage.getItem('tangoPoseStudio.muscleLook.v1'),
    kfIntact: JSON.parse(JSON.stringify(app.seqMuscles(1))),
    names,
  };
}, musNames);
say(`--- after the session: other keyframe ${JSON.stringify(musAfter.atOther.lit)}, off the timeline ${JSON.stringify(musAfter.offTimeline.lit)}, back in ${JSON.stringify(musAfter.backIn.lit)}`);
if (JSON.stringify(musAfter.atOther.lit) !== JSON.stringify([musNames.running])) {
  problems.push(`another keyframe shows ${JSON.stringify(musAfter.atOther.lit)}, want the running look [${musNames.running}]`);
}
if (JSON.stringify(musAfter.offTimeline.chips) !== JSON.stringify([musNames.running])) {
  problems.push(`leaving the focus did not hand the chips back: ${JSON.stringify(musAfter.offTimeline.chips)}`);
}
if (JSON.stringify(musAfter.backIn.lit) !== JSON.stringify(wantLit)) {
  problems.push(`re-entering the focus did not show the keyframe's own look: ${JSON.stringify(musAfter.backIn.lit)}`);
}
if (musAfter.store !== lookBefore) {
  problems.push(`the session as a whole rewrote the saved running look:\n  before ${lookBefore}\n  after  ${musAfter.store}`);
}
say(`--- muscleLook.v1 byte-identical across the whole focused session: ${musAfter.store === lookBefore}`);

// ---- 13. round trips: a reload and an export → import ----------------------
const roundTrip = await page.evaluate(async () => {
  const app = window.__app;
  app.clearDrawings();
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.seqFocus(1);
  app.addDrawLine({ x: -2.0, z: 0.4 }, { x: -1.2, z: 0.4 });
  app.seqFocus(null);
  const own = app.seqOwnIds(1);

  let blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { blob = b; return orig(b); };
  HTMLAnchorElement.prototype.click = () => {};
  document.getElementById('seq-export').click();
  URL.createObjectURL = orig;
  const payload = JSON.parse(await blob.text());

  window.confirm = () => true;
  app.setSeqStates([]);
  app.clearDrawings();
  const input = document.getElementById('seq-file');
  const dt = new DataTransfer();
  dt.items.add(new File([JSON.stringify(payload)], 'seq.json', { type: 'application/json' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 500));
  return {
    own,
    exported: payload.states[1].kf?.own ?? null,
    imported: app.seqOwnIds(1),
    drawings: app.drawings.map((a) => a.id),
  };
});
say(`--- export/import: own ${JSON.stringify(roundTrip.own)} → file ${JSON.stringify(roundTrip.exported)} → back ${JSON.stringify(roundTrip.imported)} with ${JSON.stringify(roundTrip.drawings)}`);
if (JSON.stringify(roundTrip.exported) !== JSON.stringify(roundTrip.own)
  || JSON.stringify(roundTrip.imported) !== JSON.stringify(roundTrip.own)) {
  problems.push('kf.own did not survive export → import');
}

await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await sleep(1800);
const reloaded = await page.evaluate(() => {
  const app = window.__app;
  const shown = () => app.draw.group.children.filter((o) => o.visible)
    .map((o) => o.userData.annotation.id);
  const own = app.seqOwnIds(1);
  app.seqApply(0);
  const atOther = shown();
  app.seqApply(1);
  const atOwn = shown();
  return {
    own, atOther, atOwn,
    focus: app.seqFocusIndex(),
    banner: !document.getElementById('seq-focus-note').hidden,
    drawings: app.drawings.length,
  };
});
say(`--- after a reload: own ${JSON.stringify(reloaded.own)}, kf1 shows ${JSON.stringify(reloaded.atOther)}, kf2 shows ${JSON.stringify(reloaded.atOwn)}; focus ${reloaded.focus}`);
if (!reloaded.own?.length) problems.push('kf.own did not survive a reload');
if (reloaded.atOther.some((id) => reloaded.own.includes(id))) {
  problems.push('after a reload the owned drawing shows on another keyframe');
}
if (!reloaded.own.every((id) => reloaded.atOwn.includes(id))) {
  problems.push('after a reload the owned drawing does not show on its own keyframe');
}
// Focus is SESSION state: it must never come back from storage, and never be
// serialized into a keyframe.
if (reloaded.focus !== -1 || reloaded.banner) problems.push('the edit focus was restored from storage — it is session state');

// ---- 14. the LAST exit: a recording ----------------------------------------
// Deliberately last. A capture enters Present, waits on the H.264 encoder and
// then drives applyStatesT from the render loop for its whole length — a live
// one re-applies a keyframe's extras several times a second, which is exactly
// the machinery every check above is measuring. Run it in the middle and it
// silently overwrites the muscle override between two chip clicks (measured:
// it did, and the section read as a broken seam rather than a dirty harness).
// So it goes here, and the cleanup is POLLED rather than slept on.
const rec = await page.evaluate(() => {
  const app = window.__app;
  app.seqFocus(1);
  const started = app.recordPlayback(app.seqStates, 'focus-exit-probe');
  return { started, focus: app.seqFocusIndex(), presenting: app.presenting };
});
await page.evaluate(() => window.__app.stopRecording());
await page.waitForFunction(() => !window.__app.recording && !window.__app.presenting,
  { timeout: 30000 }).catch(() => problems.push('the probe recording never finished'));
say(`--- record: started ${rec.started} (Present ${rec.presenting}), focus ${rec.focus}`);
if (!rec.started) problems.push('the probe recording never started, so the exit is unverified');
if (rec.focus !== -1) problems.push('starting a recording left the focus on');

// ---- the pictures ----------------------------------------------------------
// At the REAL sidebar width, with the Sequence section scrolled to and every
// other section folded away — a picture of the panel that is meant to be
// looked at, not a crop of whatever happened to be at the top of the column.
await page.evaluate(() => {
  const app = window.__app;
  app.seqSetName(1, 'the cross');
  app.seqFocus(1);
  for (const s of document.querySelectorAll('#sidebar section')) {
    const open = !s.classList.contains('collapsed');
    if (open !== (s.id === 'sequence-section')) s.querySelector('.collapse-toggle').click();
  }
  document.getElementById('sequence-section').scrollIntoView({ block: 'start' });
});
await sleep(500);
const sidebar = await page.evaluate(() => {
  const r = document.getElementById('sidebar').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
await page.screenshot({ path: `${outDir}/focus-sequence-panel.png`, clip: sidebar });
await page.click('#mode-buttons button[data-mode="draw"]');
await sleep(300);
await page.screenshot({ path: `${outDir}/focus-draw-toolbar-2.png`, clip: { x: 0, y: 0, width: 1500, height: 120 } });

console.log('');
if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(`  * ${p}`);
} else {
  console.log('All per-keyframe edit-focus checks passed.');
}
console.log(errors.length ? `\nConsole errors:\n${errors.join('\n')}` : '\nNo console errors.');
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
