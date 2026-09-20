// Dev check for a keyframe's OWN caption and OWN muscle highlighting — the two
// fields of the `kf` block this feature owns (`kf.caption`, `kf.muscles`).
//
// Five things, each the answer to a way this can be wrong:
//  1. THE CAPTION IS ON SCREEN, measured in PIXELS on the overlay canvas and
//     not in state. CLAUDE.md's cautionary tale is "Fade others": every faded
//     belly really did carry `opacity 0.06` while rendering solid, so a check
//     of the state passes straight through that whole class of bug. The caption
//     is drawn by studio.drawCaption onto the hud, so the honest question is
//     how many pixels it put in the bottom band — asserted at t=0 (none),
//     while keyframe 2 is the current one (many) and once keyframe 3 has been
//     reached (none again). The draw RECORD (studio.captionBox) is checked
//     beside it, because the two disagreeing is itself a bug.
//  2. IT SURVIVES THE EXPORTS. A photo composites GL + overlay, so the caption
//     is in it for free — but "for free" is exactly the kind of claim that
//     stops being true. And a recording composites into studio.recorder.canvas
//     frame by frame, which is the canvas MediaRecorder captures: if
//     app.recordPlayback ever reached for the GL canvas directly, that canvas
//     would carry the dancer and no caption (and no labels either).
//  3. A KEYFRAME'S HIGHLIGHT LIGHTS EXACTLY ITS BELLIES — in the muscle view
//     AND in the skeleton view, where the lit set is what decides which bellies
//     are on screen at all (Figure.#syncMuscleVisibility). Scrubbing to an
//     untagged keyframe puts the user's running look back, chips included.
//  4. THE RUNNING LOOK IS NOT TOUCHED. This is the trap: applyViewState ends
//     with saveMuscleLook() because showing a SLIDE makes that slide's look the
//     running one, but a scrub is not a slide. Crossing an overriding keyframe
//     must leave `tangoPoseStudio.muscleLook.v1` byte-identical — asserted as a
//     string comparison, so a re-serialisation that happens to be equivalent
//     still counts as the write it is.
//  5. `kf.draw` (the drawings feature's key) survives beside them, through a
//     reload and through the export/import file — the merge rule in setKfField.
//
// Usage: node scripts/dev-verify-keyframe-extras.mjs <outDir>  (dev server up)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-kf-extras';
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
await new Promise((r) => setTimeout(r, 1500));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The overlay only redraws on a rendered frame (main.js renders on demand).
const frames = (n = 3) => page.evaluate((k) => new Promise((res) => {
  const step = (i) => (i <= 0 ? res() : requestAnimationFrame(() => step(i - 1)));
  window.__app.requestRender(k + 2);
  step(k);
}), n);

// Pixel counters shared by every check below. The hud is a transparent canvas
// holding nothing but the overlay, so "alpha > 16 in the bottom band" IS the
// caption; a composited image (photo, recorder frame) is counted by its near-
// WHITE pixels instead, which is the caption's ink over a dark stage.
const COUNTERS = `
  const bandOf = (h) => ({ y0: Math.floor(h * 0.78), y1: h });
  const countAlpha = (canvas) => {
    const b = bandOf(canvas.height);
    const d = canvas.getContext('2d').getImageData(0, b.y0, canvas.width, b.y1 - b.y0).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++;
    return n;
  };
  const countInk = (canvas) => {
    const b = bandOf(canvas.height);
    const d = canvas.getContext('2d').getImageData(0, b.y0, canvas.width, b.y1 - b.y0).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200 && d[i + 3] > 200) n++;
    }
    return n;
  };
`;

// ---- setup: a 3-keyframe chain, no labels (their pills are white too) ------
const setup = await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.clearDrawings();
  app.setSeqStates([]);
  localStorage.removeItem('tangoPoseStudio.sequence.v1');
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.seqSetCaption(1, 'Here the leader’s left obliques fire');
  return {
    n: app.seqStates.length,
    caption: app.seqCaption(1),
    kf0: app.seqStates[0].kf ?? null,
    kf1: JSON.stringify(app.seqStates[1].kf),
  };
});
console.log('--- setup:', JSON.stringify(setup));
if (setup.n !== 3) problems.push(`built ${setup.n} keyframes, want 3`);
if (!setup.caption) problems.push('seqSetCaption stored nothing');
if (setup.kf0 !== null) problems.push('an untagged keyframe grew a kf block');

// ---- 1. the caption, in PIXELS ---------------------------------------------
const bandAt = async (t) => {
  await page.evaluate((tt) => window.__app.applySeqT(tt), t);
  await frames(3);
  // Wrapped in an IIFE: every page.evaluate of a STRING runs in the same global
  // scope, so a bare `const` in the prelude is a redeclaration the second time.
  return page.evaluate(`(() => { ${COUNTERS}
    const hud = document.getElementById('hud');
    return { px: countAlpha(hud), box: window.__app.studio.captionBox, text: window.__app.caption() };
  })()`);
};
// t = 0.2 is inside segment 1, so keyframe 1 is the one being travelled FROM.
// t = 0.6 is inside segment 2 (keyframe 2), t = 1 has reached keyframe 3.
const atStart = await bandAt(0.2);
const atKf2 = await bandAt(0.6);
const atEnd = await bandAt(1);
console.log('--- caption pixels:', JSON.stringify({
  start: atStart.px, kf2: atKf2.px, end: atEnd.px,
  boxes: [!!atStart.box, !!atKf2.box, !!atEnd.box],
  texts: [atStart.text, atKf2.text, atEnd.text],
}));
if (atStart.px > 200) problems.push(`keyframe 1 drew ${atStart.px} px in the caption band — it carries no caption`);
if (atKf2.px < 2000) problems.push(`keyframe 2's caption drew only ${atKf2.px} px — it is not on screen`);
if (atEnd.px > 200) problems.push(`the caption survived past keyframe 3 (${atEnd.px} px)`);
if (atStart.box || atEnd.box) problems.push('studio.captionBox is set with no caption showing');
if (!atKf2.box) problems.push('the caption drew pixels but recorded no box');
if (atKf2.box && atKf2.box.top + atKf2.box.height > 1000) {
  problems.push(`the caption box runs off the frame (top ${atKf2.box.top}, height ${atKf2.box.height})`);
}
if (atStart.text || atEnd.text || !atKf2.text) problems.push('studio.caption disagrees with what was drawn');
await page.evaluate(() => window.__app.applySeqT(0.6));
await frames(3);
await page.screenshot({ path: `${outDir}/caption-on-keyframe-2.png` });

// The callout columns must leave the band alone rather than writing over it.
const room = await page.evaluate(async () => {
  const app = window.__app;
  // Low anchors, so their callouts are the ones that would be pushed into the
  // band if nothing reserved it.
  for (const j of ['ankle_L', 'ankle_R', 'toes_L', 'toes_R', 'knee_L', 'knee_R']) {
    app.addLabel(app.leader, 'joint', j);
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const box = app.studio.captionBox;
  const lowest = Math.max(0, ...(app.studio.lastLayout ?? []).map((p) => (p.box ? p.box.top + p.box.height : 0)));
  const out = { lowest, capTop: box?.top ?? null, labels: (app.studio.lastLayout ?? []).length };
  app.clearLabels();
  return out;
});
console.log('--- callouts vs the band:', JSON.stringify(room));
if (room.labels && room.capTop !== null && room.lowest > room.capTop) {
  problems.push(`a callout reaches ${room.lowest.toFixed(0)} px, under the caption's top at ${room.capTop.toFixed(0)}`);
}

// ---- 2. the exports carry it ------------------------------------------------
const photo = await page.evaluate(`
  (async () => { ${COUNTERS}
    const app = window.__app;
    const shot = async () => {
      const url = app.photoDataURL(1);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return countInk(c);
    };
    app.applySeqT(0.6);
    const withCap = await shot();
    app.applySeqT(0.2);
    const without = await shot();
    app.applySeqT(0.6);
    return { withCap, without };
  })()
`);
console.log('--- photo ink in the band:', JSON.stringify(photo));
if (photo.withCap - photo.without < 500) {
  problems.push(`app.photoDataURL lost the caption (${photo.withCap} vs ${photo.without} ink px)`);
}

// The recorded video. MediaRecorder captures studio.recorder.canvas, which
// studio.renderFrame composites GL + hud into every frame — so reading that
// canvas mid-recording is reading what the file will contain. A recordPlayback
// that captured the GL canvas directly would show the dancer and no caption.
const rec = await page.evaluate(`
  (async () => { ${COUNTERS}
    const app = window.__app;
    HTMLAnchorElement.prototype.click = () => {};
    // Two keyframes, the caption on the FIRST: extras come from the keyframe
    // being travelled from, so it holds for the whole playback.
    app.setSeqStates([]);
    app.applyPreset(1); app.seqAdd();
    app.applyPreset(2); app.seqAdd();
    app.seqSetCaption(0, 'Caption in the recording');
    app.seqSetDuration(0, 3);
    const started = app.recordPlayback(app.seqStates, 'verify-kf-caption');
    const t0 = performance.now();
    while (!app.studio.recorder && performance.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!app.studio.recorder) return { started, armed: false };
    await new Promise((r) => setTimeout(r, 500)); // let a few frames composite
    const canvas = app.studio.recorder.canvas;
    const ink = countInk(canvas);
    const sameAsGl = canvas === app.renderer?.domElement;
    while (app.recording && performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return { started, armed: true, ink, sameAsGl, w: canvas.width, h: canvas.height };
  })()
`);
console.log('--- recorded frame:', JSON.stringify(rec));
if (!rec.started) problems.push('recordPlayback refused to start');
if (!rec.armed) problems.push('the recorder never armed (H.264 warm-up?)');
else if (rec.ink < 500) {
  problems.push(`the captured frame holds ${rec.ink} caption ink px — recordPlayback is not compositing the overlay`);
}

// ---- 3. a keyframe's own muscle highlighting --------------------------------
const musSetup = await page.evaluate(() => {
  const app = window.__app;
  if (!app.muscles.length) return { skip: true };
  // The RUNNING look, set through the panel's own chips so it is authored the
  // way a user authors it (and really reaches muscleLook.v1).
  const chipFor = (label) => [...document.querySelectorAll('#muscle-list .muscle-row')]
    .find((r) => r.querySelector('label')?.textContent.trim() === label)
    ?.querySelector('.muscle-hl');
  const running = app.muscles[0].label;
  const kfOnly = app.muscles[1].label;
  chipFor(running)?.click();
  return { skip: false, running, kfOnly, litAfter: [...(app.leader.litMuscles ?? [])] };
});
if (musSetup.skip) {
  console.log('--- muscles: atlas unavailable in this session, skipping');
} else {
  const lookBefore = await page.evaluate(() => localStorage.getItem('tangoPoseStudio.muscleLook.v1'));

  const mus = await page.evaluate(async (names) => {
    const app = window.__app;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.setSeqStates([]);
    app.applyPreset(0); app.seqAdd();
    app.applyPreset(1); app.seqAdd();
    app.applyPreset(2); app.seqAdd();
    app.seqSetMuscles(1, { lit: [names.kfOnly], colors: [[names.kfOnly, '#22ff55']] });

    const chipActive = (label) => [...document.querySelectorAll('#muscle-list .muscle-row')]
      .find((r) => r.querySelector('label')?.textContent.trim() === label)
      ?.querySelector('.muscle-hl')?.classList.contains('active') ?? null;
    const bellies = (label) => {
      const out = [];
      app.leader.group.traverse((o) => { if (o.userData?.muscleName === label) out.push(o); });
      return out;
    };
    const read = () => ({
      lit: [...(app.leader.litMuscles ?? [])].sort(),
      chipRunning: chipActive(names.running),
      chipKf: chipActive(names.kfOnly),
      kfColor: bellies(names.kfOnly)[0]?.material.color.getHexString() ?? null,
      // Skeleton view shows exactly the LIT bellies over the bare bones.
      kfVisible: bellies(names.kfOnly).some((m) => m.visible),
      runVisible: bellies(names.running).some((m) => m.visible),
      note: !document.getElementById('muscle-kf-note').hidden,
    });

    const setLayer = (v) => {
      const sel = document.getElementById('layer-mode');
      sel.value = v;
      sel.dispatchEvent(new Event('change'));
    };

    setLayer('muscle');
    app.applySeqT(0.6); await frame();
    const muscleView = read();
    setLayer('skeleton');
    await frame();
    const skeletonView = read();
    app.applySeqT(0.2); await frame();           // untagged keyframe 1
    const restored = read();
    return { muscleView, skeletonView, restored };
  }, musSetup);

  // Scrub back and forth across the overriding keyframe a few times — the
  // playhead crossing it is exactly what must not persist.
  await page.evaluate(async () => {
    const app = window.__app;
    for (const t of [0.6, 0.2, 0.7, 0.9, 0.3, 0.6]) {
      app.applySeqT(t);
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const lookAfter = await page.evaluate(() => localStorage.getItem('tangoPoseStudio.muscleLook.v1'));

  console.log('--- muscle override:', JSON.stringify(mus));
  const { muscleView, skeletonView, restored } = mus;
  if (!muscleView.lit.includes(musSetup.kfOnly) || muscleView.lit.includes(musSetup.running)) {
    problems.push(`the keyframe lit ${JSON.stringify(muscleView.lit)}, want only ${musSetup.kfOnly}`);
  }
  if (muscleView.kfColor !== '22ff55') {
    problems.push(`the keyframe's colour did not reach the belly (#${muscleView.kfColor})`);
  }
  if (muscleView.chipKf !== true || muscleView.chipRunning !== false) {
    problems.push(`the Muscles panel's chips lie about what is lit (kf ${muscleView.chipKf}, running ${muscleView.chipRunning})`);
  }
  if (!muscleView.note) problems.push('nothing tells the user the panel is showing a keyframe\'s look');
  // Skeleton view: the lit set is what is DRAWN there, so the override must be
  // what the viewer sees over the bare bones.
  if (!skeletonView.kfVisible) problems.push('the keyframe\'s belly is not drawn in skeleton view');
  if (skeletonView.runVisible) problems.push('the running look\'s belly is still drawn in skeleton view under an override');
  if (!restored.lit.includes(musSetup.running) || restored.lit.includes(musSetup.kfOnly)) {
    problems.push(`an untagged keyframe did not restore the running look (${JSON.stringify(restored.lit)})`);
  }
  if (restored.chipRunning !== true || restored.chipKf !== false) {
    problems.push('the chips did not go back with the running look');
  }
  if (restored.note) problems.push('the keyframe-look note stayed up after the override ended');
  if (!restored.runVisible) problems.push('the running look\'s belly did not come back in skeleton view');

  // ---- 4. THE TRAP: scrubbing must not persist a keyframe's look ----------
  console.log('--- muscleLook.v1 unchanged by scrubbing:', lookBefore === lookAfter);
  if (lookBefore !== lookAfter) {
    problems.push(`scrubbing rewrote the saved running look:\n  before ${lookBefore}\n  after  ${lookAfter}`);
  }
  await page.evaluate(() => {
    const sel = document.getElementById('layer-mode');
    sel.value = 'muscle';
    sel.dispatchEvent(new Event('change'));
    window.__app.applySeqT(0.6);
  });
  await frames(3);
  await page.screenshot({ path: `${outDir}/keyframe-muscles.png` });
}

// ---- 5. kf.draw, caption and muscles side by side ---------------------------
const merged = await page.evaluate(async () => {
  const app = window.__app;
  app.clearDrawings();
  app.setSeqStates([]);
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.addDrawLine({ x: -0.6, z: 0.3 }, { x: 0.4, z: 0.3 });
  app.addDrawCircle({ x: 0.5, z: -0.4 }, 0.3);
  app.seqSetDrawIds(0, app.drawings.map((d) => d.id).slice(0, 1));
  app.seqSetCaption(0, 'all three at once');
  app.seqSetMuscles(0, { lit: [app.muscles[0]?.label ?? 'x'], colors: [] });
  const both = JSON.parse(JSON.stringify(app.seqStates[0].kf));

  // The UI's own export → import round trip.
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

  // …and a keyframe with no kf block at all must still carry none.
  return {
    both,
    imported: JSON.parse(JSON.stringify(app.seqStates[0].kf ?? null)),
    secondKf: app.seqStates[1]?.kf ?? null,
    drawings: app.drawings.length,
  };
});
console.log('--- kf side by side:', JSON.stringify(merged));
for (const key of ['draw', 'caption', 'muscles']) {
  if (!merged.both?.[key]) problems.push(`kf.${key} is missing after all three were set`);
  if (JSON.stringify(merged.imported?.[key]) !== JSON.stringify(merged.both?.[key])) {
    problems.push(`kf.${key} did not round-trip the export/import file`);
  }
}
if (merged.secondKf !== null) problems.push('an untouched keyframe gained a kf block through the file');

// …and across a reload, which is the only proof they are stored rather than
// merely held in memory.
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await sleep(1500);
const reloaded = await page.evaluate(() => {
  const app = window.__app;
  return {
    kf: JSON.parse(JSON.stringify(app.seqStates[0]?.kf ?? null)),
    captionField: document.querySelector('#seq-list .seq-caption')?.value ?? null,
    musButton: document.querySelector('#seq-list .seq-kf-btn')?.textContent ?? null,
    rows: document.querySelectorAll('#seq-list .pose-item').length,
  };
});
console.log('--- after reload:', JSON.stringify(reloaded));
if (reloaded.kf?.caption !== 'all three at once') problems.push('the caption did not survive a reload');
if (!reloaded.kf?.muscles || !reloaded.kf?.draw) problems.push('kf.muscles / kf.draw did not survive a reload');
if (reloaded.captionField !== 'all three at once') problems.push('the row does not show the stored caption');
if (!/◼/.test(reloaded.musButton ?? '')) problems.push(`the muscle tag does not show as tagged ("${reloaded.musButton}")`);
if (reloaded.rows !== 2) problems.push(`the extras line changed the row count (${reloaded.rows} .pose-item for 2 keyframes)`);

// Typing a caption into the row's own field commits it, and clearing it drops
// the key rather than storing an empty string.
const typed = await page.evaluate(() => {
  const app = window.__app;
  // Re-queried each time: committing re-renders the list, so the element that
  // fired the first `change` is no longer the one on screen (and its own
  // generation guard would refuse to speak for the list anyway).
  const box = () => document.querySelectorAll('#seq-list .seq-caption')[1];
  box().value = 'weight over the standing foot';
  box().dispatchEvent(new Event('change'));
  const stored = app.seqCaption(1);
  box().value = '';
  box().dispatchEvent(new Event('change'));
  return { stored, cleared: app.seqStates[1].kf ?? null, now: app.seqCaption(1) };
});
console.log('--- row caption field:', JSON.stringify(typed));
if (typed.stored !== 'weight over the standing foot') problems.push(`the row's caption field stored "${typed.stored}"`);
if (typed.cleared !== null) problems.push('an emptied caption left a kf block behind');

// The muscle tag button: capture, then clear.
const tag = await page.evaluate(() => {
  const app = window.__app;
  const btn = () => document.querySelectorAll('#seq-list .seq-kf-btn')[1];
  const before = btn().textContent;
  btn().click();
  const captured = app.seqMuscles(1);
  btn().click();
  return { before, captured, after: app.seqMuscles(1), kf: app.seqStates[1].kf ?? null };
});
console.log('--- muscle tag button:', JSON.stringify(tag));
if (!/◻/.test(tag.before)) problems.push('an untagged keyframe does not read as untagged');
if (!tag.captured) problems.push('the muscle tag captured nothing');
if (tag.after !== null) problems.push('a second press did not clear the muscle tag');

await page.evaluate(() => {
  window.__app.setSeqStates([]);
  window.__app.clearDrawings();
  window.__app.clearKeyframeExtras();
});

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
else console.log('\nAll keyframe caption / muscle checks passed.');
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length || problems.length ? 1 : 0);
