// Dev check for the two texts a SEQUENCE puts on the picture — a keyframe's own
// NAME and its CAPTION — and for the three things the user can do to them:
// move them (one placement each, for the whole sequence), colour them and hide
// them (both per keyframe, in its `kf` block).
//
// Everything visible is counted in RENDERED PIXELS, never in state. CLAUDE.md's
// cautionary tale is "Fade others": every faded belly really did carry
// `opacity 0.06` while rendering solid, so a check of the state passes straight
// through that whole class of bug. A colour that never reaches the canvas, a
// hide that leaves the words on screen and a placement that an export quietly
// re-derives are all the same shape of bug, so all three are read off the
// picture here.
//
// What it proves, and why each one is here:
//  1. THE NAME IS DRAWN — on a keyframe the user named, and NOT on one they did
//     not, NOR on a legacy "Keyframe 2". `seqAdd` used to store that string as a
//     real value, so every sequence saved before this carries one; it is the
//     row's placeholder frozen into the file, it goes stale on the first
//     reorder, and stamping it over a recorded video would caption the third
//     step "Keyframe 1".
//  2. IT SURVIVES THE EXPORTS — a photo (which composites GL + overlay) and a
//     LIVE RECORDER FRAME (the canvas MediaRecorder captures). "For free" is
//     exactly the sort of claim that stops being true.
//  3. A REAL POINTER DRAG moves each block, without orbiting the camera (its
//     position must be byte-identical: the grab is armed by hover because
//     OrbitControls listens on the same canvas) and without selecting a joint
//     behind it.
//  4. THE PLACEMENT IS A FRACTION of the frame — measured by where the ink
//     lands in a 1× photo versus a 2× one, since an export redraws every block
//     at its own resolution and must not re-derive the spot from pixels.
//  5. IT PERSISTS — across a reload, and through the export → import file; a
//     LEGACY file carrying no `textPos` key imports to the default placement.
//  6. COLOUR AND HIDE ARE PER KEYFRAME — the colour shows in pixels on its own
//     keyframe and not on its neighbour, and hiding removes the pixels there
//     and only there.
//  7. A REAL SECOND TAP on a block opens the colour picker for the keyframe
//     that is showing (counted in pointerup — the native `dblclick` never fires
//     under CDP, see dev-verify-label-gestures.mjs).
//  8. AN UNTOUCHED KEYFRAME IS BYTE-IDENTICAL — no empty `kf` block left behind
//     by any of this.
//  9. A CAPTION DRAGGED OUT OF THE BOTTOM BAND STOPS RESERVING callout room —
//     the mirror of titleBottom's "only while it is in the top band" rule. A
//     caption beside the dancer is IN the shot, not under it.
// 10. THE COG-TRAIL REBUILD LEAVES THE TEXT ALONE — it replays the chain ~289
//     times per edit to sample a path, and passes `extras: false` for it.
//
// Usage: node scripts/dev-verify-seq-text.mjs <outDir>   (dev server up)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-seq-text';
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173/';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950'],
  userDataDir: `${process.env.TEMP}/verify-seq-text`,
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The overlay only redraws on a rendered frame (main.js renders on demand).
const frames = (n = 3) => page.evaluate((k) => new Promise((res) => {
  const step = (i) => (i <= 0 ? res() : requestAnimationFrame(() => step(i - 1)));
  window.__app.requestRender(k + 2);
  step(k);
}), n);

// Pixel counters, shared by every check below. The hud is a transparent canvas
// carrying nothing but the overlay, so "alpha > 16 inside this region" IS the
// block; a COMPOSITED image (a photo, a recorder frame) has the stage behind it
// and is counted by ink instead — near-white for the default theme text, or
// near a given hue for a keyframe's own colour.
const COUNTERS = `
  const REGION = {
    name: { x0: 0.0, x1: 0.42, y0: 0.0, y1: 0.22 },
    caption: { x0: 0.1, x1: 0.9, y0: 0.80, y1: 1.0 },
  };
  const px = (canvas, region) => {
    const r = REGION[region];
    const x0 = Math.floor(canvas.width * r.x0);
    const y0 = Math.floor(canvas.height * r.y0);
    const w = Math.ceil(canvas.width * (r.x1 - r.x0));
    const h = Math.ceil(canvas.height * (r.y1 - r.y0));
    return { d: canvas.getContext('2d').getImageData(x0, y0, w, h).data, x0, y0, w, h };
  };
  const countAlpha = (canvas, region) => {
    const { d } = px(canvas, region);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++;
    return n;
  };
  const countInk = (canvas, region) => {
    const { d } = px(canvas, region);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200 && d[i + 3] > 200) n++;
    }
    return n;
  };
  // Pixels within tol of a given rgb — how a picked colour is proved to have
  // reached the canvas rather than only the record.
  const countHue = (canvas, region, rgb, tol = 48) => {
    const { d } = px(canvas, region);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 120
        && Math.abs(d[i] - rgb[0]) < tol
        && Math.abs(d[i + 1] - rgb[1]) < tol
        && Math.abs(d[i + 2] - rgb[2]) < tol) n++;
    }
    return n;
  };
  // Where the ink sits, as a FRACTION of the whole image — the export-resolution
  // independent way to ask "did the block land in the same place?".
  const inkCentroid = (canvas, region) => {
    const { d, x0, y0, w } = px(canvas, region);
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200 && d[i + 3] > 200) {
        const p = i / 4;
        sx += x0 + (p % w); sy += y0 + Math.floor(p / w); n++;
      }
    }
    return n ? { x: sx / n / canvas.width, y: sy / n / canvas.height, n } : null;
  };
  const loadShot = async (scale) => {
    const url = window.__app.photoDataURL(scale);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  };
`;

// A CSS-pixel point on the canvas for a block's centre, so a real mouse can
// aim at it.
const blockPoint = (key) => page.evaluate((k) => {
  const app = window.__app;
  const b = k === 'name' ? app.studio.seqNameBox : app.studio.captionBox;
  if (!b) return null;
  const gl = document.querySelector('#viewport canvas:not(#hud)');
  const hud = document.getElementById('hud');
  const r = gl.getBoundingClientRect();
  const sx = r.width / hud.width;
  const sy = r.height / hud.height;
  return {
    x: r.left + (b.left + b.width / 2) * sx,
    y: r.top + (b.top + b.height / 2) * sy,
    box: { left: b.left, top: b.top, width: b.width, height: b.height },
    hudW: hud.width, hudH: hud.height, sx, sy,
  };
}, key);

// ---- setup: three keyframes, one named + captioned, one legacy-named --------
const setup = await page.evaluate(() => {
  const app = window.__app;
  app.clearLabels();
  app.clearDrawings();
  app.setSeqStates([]);
  app.setSeqTextPositions(null);
  localStorage.removeItem('tangoPoseStudio.sequence.v1');
  localStorage.removeItem('tangoPoseStudio.seqText.v1');
  app.setBackdrop('dark');
  app.setFrame('slide');
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  // Keyframe 1: never named (what seqAdd now leaves behind).
  // Keyframe 2: a real name the user typed, plus a caption.
  // Keyframe 3: a LEGACY auto-name, written straight into the state the way
  // every file saved before this carries it.
  app.seqSetName(1, 'the cross');
  app.seqSetCaption(1, 'Weight over the standing foot');
  app.seqStates[2].name = 'Keyframe 2'; // deliberately stale, as a reorder leaves it
  app.onSeqChanged();
  return {
    names: app.seqStates.map((s) => s.name),
    kf0: app.seqStates[0].kf ?? null,
    kf2: app.seqStates[2].kf ?? null,
    screen: [0, 1, 2].map((i) => app.seqNameForScreen(i)),
  };
});
console.log('--- setup:', JSON.stringify(setup));
if (setup.names[0] !== '') problems.push(`seqAdd stored a name of its own ("${setup.names[0]}") — an auto name goes stale on the first reorder`);
if (setup.screen.join('|') !== '|the cross|') {
  problems.push(`the picture would draw ${JSON.stringify(setup.screen)}, want only the typed name`);
}

// ---- 1. the name, in PIXELS -------------------------------------------------
const nameAt = async (t) => {
  await page.evaluate((tt) => window.__app.applySeqT(tt), t);
  await frames(3);
  // Wrapped in an IIFE: every page.evaluate of a STRING shares one global
  // scope, so a bare `const` in the prelude redeclares on the second call.
  return page.evaluate(`(() => { ${COUNTERS}
    const hud = document.getElementById('hud');
    return {
      px: countAlpha(hud, 'name'),
      cap: countAlpha(hud, 'caption'),
      box: window.__app.studio.seqNameBox,
      text: window.__app.seqNameShown(),
    };
  })()`);
};
// t = 0.2 sits inside segment 1 (keyframe 1 is the one travelled FROM), t = 0.6
// inside segment 2 (keyframe 2), t = 1 has reached keyframe 3.
const unnamed = await nameAt(0.2);
const named = await nameAt(0.6);
const legacy = await nameAt(1);
console.log('--- name pixels:', JSON.stringify({
  unnamed: unnamed.px, named: named.px, legacy: legacy.px,
  boxes: [!!unnamed.box, !!named.box, !!legacy.box],
  texts: [unnamed.text, named.text, legacy.text],
}));
if (unnamed.px > 200) problems.push(`an unnamed keyframe drew ${unnamed.px} px of name`);
if (named.px < 1200) problems.push(`the named keyframe drew only ${named.px} px — the name is not on screen`);
if (legacy.px > 200) problems.push(`a legacy "Keyframe 2" name was stamped on the picture (${legacy.px} px)`);
if (unnamed.box || legacy.box) problems.push('studio.seqNameBox is set with no name showing');
if (!named.box) problems.push('the name drew pixels but recorded no box');
if (named.text !== 'the cross') problems.push(`studio.seqName reads "${named.text}"`);
await page.evaluate(() => window.__app.applySeqT(0.6));
await frames(3);
await page.screenshot({ path: `${outDir}/01-name-and-caption.png` });

// ---- 2. the exports carry it, and the placement is a FRACTION ---------------
const exported = await page.evaluate(`
  (async () => { ${COUNTERS}
    const app = window.__app;
    app.applySeqT(0.6);
    const one = await loadShot(1);
    const two = await loadShot(2);
    app.applySeqT(0.2);
    const none = await loadShot(1);
    app.applySeqT(0.6);
    return {
      one: { ink: countInk(one, 'name'), c: inkCentroid(one, 'name'), w: one.width, h: one.height },
      two: { ink: countInk(two, 'name'), c: inkCentroid(two, 'name'), w: two.width, h: two.height },
      none: countInk(none, 'name'),
    };
  })()
`);
console.log('--- photo:', JSON.stringify(exported));
if (exported.one.ink - exported.none < 400) {
  problems.push(`app.photoDataURL lost the name (${exported.one.ink} vs ${exported.none} ink px)`);
}
if (exported.two.w !== exported.one.w * 2) problems.push('the 2× photo is not twice the size');
if (exported.one.c && exported.two.c) {
  const dx = Math.abs(exported.one.c.x - exported.two.c.x);
  const dy = Math.abs(exported.one.c.y - exported.two.c.y);
  console.log(`--- name ink centroid: 1× (${exported.one.c.x.toFixed(4)}, ${exported.one.c.y.toFixed(4)}) · 2× (${exported.two.c.x.toFixed(4)}, ${exported.two.c.y.toFixed(4)})`);
  if (dx > 0.004 || dy > 0.004) {
    problems.push(`the name lands at a different FRACTION at 2× (Δ ${dx.toFixed(4)}, ${dy.toFixed(4)})`);
  }
} else problems.push('no name ink found in one of the photos');

// The recorded video. MediaRecorder captures studio.recorder.canvas, which
// studio.renderFrame composites GL + hud into every frame — so reading that
// canvas mid-recording is reading what the file will hold.
const rec = await page.evaluate(`
  (async () => { ${COUNTERS}
    const app = window.__app;
    HTMLAnchorElement.prototype.click = () => {};
    app.setSeqStates([]);
    app.applyPreset(1); app.seqAdd();
    app.applyPreset(2); app.seqAdd();
    app.seqSetName(0, 'recorded step');   // the keyframe travelled FROM
    app.seqSetDuration(0, 3);
    const started = app.recordPlayback(app.seqStates, 'verify-seq-name');
    const t0 = performance.now();
    while (!app.studio.recorder && performance.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!app.studio.recorder) return { started, armed: false };
    await new Promise((r) => setTimeout(r, 500)); // let a few frames composite
    const canvas = app.studio.recorder.canvas;
    const ink = countInk(canvas, 'name');
    const sameAsGl = canvas === app.renderer?.domElement;
    while (app.recording && performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return { started, armed: true, ink, sameAsGl };
  })()
`);
console.log('--- recorded frame:', JSON.stringify(rec));
if (!rec.started) problems.push('recordPlayback refused to start');
if (!rec.armed) problems.push('the recorder never armed (H.264 warm-up?)');
else if (rec.ink < 400) {
  problems.push(`the captured frame holds ${rec.ink} px of name — recordPlayback is not compositing the overlay`);
}

// ---- 3. REAL pointer drags --------------------------------------------------
// Rebuild the three-keyframe chain the recording replaced, and park on the
// named, captioned one so BOTH blocks are on screen to be grabbed.
await page.evaluate(() => {
  const app = window.__app;
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.seqSetName(1, 'the cross');
  app.seqSetCaption(1, 'Weight over the standing foot');
  app.seqSetName(2, 'collection');
  app.applySeqT(0.6);
  app.deselect();
});
await frames(3);

for (const [key, dx, dy] of [['name', 300, 240], ['caption', -260, -420]]) {
  const p = await blockPoint(key);
  if (!p) { problems.push(`no ${key} block on screen to drag`); continue; }
  const before = await page.evaluate(() => ({
    cam: window.__app.camera.position.toArray(),
    target: window.__app.orbit.target.toArray(),
    selected: window.__app.selected?.jointName ?? null,
  }));
  await page.mouse.move(p.x, p.y); // hover arms the grab
  await sleep(140);
  await page.mouse.down();
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 14 });
  await page.mouse.up();
  await sleep(350);
  const after = await page.evaluate((k) => ({
    pos: window.__app.seqTextPos(k),
    cam: window.__app.camera.position.toArray(),
    target: window.__app.orbit.target.toArray(),
    selected: window.__app.selected?.jointName ?? null,
    box: k === 'name' ? window.__app.studio.seqNameBox : window.__app.studio.captionBox,
  }), key);
  const camMoved = Math.hypot(...after.cam.map((v, i) => v - before.cam[i]));
  const tgtMoved = Math.hypot(...after.target.map((v, i) => v - before.target[i]));
  if (!after.pos) { problems.push(`the ${key} block did not move on a real pointer drag`); continue; }
  // The canvas is rendered at 1920×1080 behind a smaller CSS box, so the ask in
  // CSS px scales into canvas px by the same factor the drag reads.
  const gotX = (after.pos.x * p.hudW) - (p.box.left + p.box.width / 2);
  const gotY = (after.pos.y * p.hudH) - p.box.top;
  console.log(`--- ${key} drag: moved ${gotX.toFixed(0)}, ${gotY.toFixed(0)} canvas px (asked ${(dx / p.sx).toFixed(0)}, ${(dy / p.sy).toFixed(0)}); camera ${(camMoved * 1000).toFixed(2)} mm, target ${(tgtMoved * 1000).toFixed(2)} mm; selected ${after.selected}`);
  if (Math.abs(gotX - dx / p.sx) > 14 || Math.abs(gotY - dy / p.sy) > 14) {
    problems.push(`the ${key} block did not track the cursor`);
  }
  if (camMoved > 1e-9 || tgtMoved > 1e-9) {
    problems.push(`dragging the ${key} block orbited the camera (${camMoved.toFixed(4)} m / target ${tgtMoved.toFixed(4)} m)`);
  }
  if (after.selected !== before.selected) {
    problems.push(`dragging the ${key} block selected a joint (${after.selected})`);
  }
  if (!after.box) problems.push(`the ${key} block stopped drawing after its drag`);
}
await frames(3);
await page.screenshot({ path: `${outDir}/02-blocks-dragged.png` });

// ---- 9. the dragged caption stops reserving the bottom band ------------------
// (Checked here, while the caption is up beside the dancer.)
const roomAfter = await page.evaluate(async () => {
  const app = window.__app;
  for (const j of ['ankle_L', 'ankle_R', 'toes_L', 'toes_R', 'knee_L', 'knee_R']) {
    app.addLabel(app.leader, 'joint', j);
  }
  app.requestRender(3);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const hud = document.getElementById('hud');
  const lowest = Math.max(0, ...(app.studio.lastLayout ?? []).map((p) => (p.box ? p.box.top + p.box.height : 0)));
  return { lowest, h: hud.height, capTop: app.studio.captionBox?.top ?? null, labels: (app.studio.lastLayout ?? []).length };
});
console.log('--- callouts with the caption moved up:', JSON.stringify(roomAfter));
if (roomAfter.lowest < roomAfter.h * 0.80) {
  problems.push(`a caption moved out of the bottom band is still reserving it (callouts stop at ${(roomAfter.lowest / roomAfter.h).toFixed(3)}h)`);
}
// …and putting it back re-reserves, so the rule is the caption's position and
// not a switch that got stuck.
const roomBack = await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqTextPos('caption', null);
  app.requestRender(3);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const lowest = Math.max(0, ...(app.studio.lastLayout ?? []).map((p) => (p.box ? p.box.top + p.box.height : 0)));
  const out = { lowest, capTop: app.studio.captionBox?.top ?? null };
  app.clearLabels();
  return out;
});
console.log('--- callouts with the caption back at the foot:', JSON.stringify(roomBack));
if (roomBack.capTop !== null && roomBack.lowest > roomBack.capTop) {
  problems.push(`a callout reaches ${roomBack.lowest.toFixed(0)} px, under the caption's top at ${roomBack.capTop.toFixed(0)}`);
}

// ---- 5. the placement persists ----------------------------------------------
const roundTrip = await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqTextPos('name', { x: 0.62, y: 0.12 });
  app.setSeqTextPos('caption', { x: 0.30, y: 0.55 });
  const set = app.seqTextPositions();
  const stored = localStorage.getItem('tangoPoseStudio.seqText.v1');

  // The UI's own export → import round trip.
  let blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { blob = b; return orig(b); };
  HTMLAnchorElement.prototype.click = () => {};
  document.getElementById('seq-export').click();
  URL.createObjectURL = orig;
  const payload = JSON.parse(await blob.text());

  window.confirm = () => true;
  app.setSeqTextPositions(null);
  const input = document.getElementById('seq-file');
  const load = async (obj) => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(obj)], 'seq.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));
    return app.seqTextPositions();
  };
  const imported = await load(payload);
  // A LEGACY file — one saved before the texts could be placed — carries no
  // `textPos` key at all and must land at the default, not at whatever the
  // previous sequence left on screen.
  const legacyFile = { ...payload };
  delete legacyFile.textPos;
  const legacy = await load(legacyFile);
  // Put the placement back so the reload below has something to restore.
  await load(payload);
  return { set, stored, payloadKey: payload.textPos, imported, legacy, version: payload.version };
});
console.log('--- placement round trip:', JSON.stringify(roundTrip));
if (roundTrip.version !== 1) problems.push(`the export bumped its version to ${roundTrip.version}`);
if (!roundTrip.stored || !JSON.parse(roundTrip.stored).name) problems.push('the placement was not saved to localStorage');
if (JSON.stringify(roundTrip.imported) !== JSON.stringify(roundTrip.set)) {
  problems.push('the placement did not survive the export/import file');
}
if (roundTrip.legacy.name !== null || roundTrip.legacy.caption !== null) {
  problems.push(`a legacy file without textPos imported with a placement (${JSON.stringify(roundTrip.legacy)})`);
}

// ---- 6/7. colour and hide, PER KEYFRAME -------------------------------------
const PINK = [255, 45, 85];
const styled = await page.evaluate(`
  (async () => { ${COUNTERS}
    const app = window.__app;
    const frame = () => new Promise((r) => { app.requestRender(3); requestAnimationFrame(() => requestAnimationFrame(r)); });
    app.setSeqTextPositions(null);          // read the name where it is drawn by default
    app.seqSetName(2, 'collection');
    app.seqSetTextStyle(1, 'name', { color: '#ff2d55' });
    app.applySeqT(0.6); await frame();
    const hud = document.getElementById('hud');
    const coloured = { hue: countHue(hud, 'name', [255, 45, 85]), all: countAlpha(hud, 'name') };
    app.applySeqT(1); await frame();        // keyframe 3, named but NOT coloured
    const neighbour = { hue: countHue(hud, 'name', [255, 45, 85]), all: countAlpha(hud, 'name') };
    // Hide it on keyframe 2 only.
    app.applySeqT(0.6); await frame();
    app.seqSetTextStyle(1, 'name', { hidden: true });
    await frame();
    const hidden = { all: countAlpha(hud, 'name'), box: !!app.studio.seqNameBox };
    app.applySeqT(1); await frame();
    const neighbourShown = { all: countAlpha(hud, 'name') };
    app.applySeqT(0.6); await frame();
    // …and the caption's own hide, which must not take the name's with it.
    app.seqSetTextStyle(1, 'caption', { hidden: true });
    await frame();
    const capHidden = countAlpha(hud, 'caption');
    const kf = JSON.parse(JSON.stringify(app.seqStates[1].kf));
    // Put both back.
    app.seqSetTextStyle(1, 'name', { hidden: false });
    app.seqSetTextStyle(1, 'caption', { hidden: false });
    await frame();
    return {
      coloured, neighbour, hidden, neighbourShown, capHidden, kf,
      restored: countAlpha(hud, 'name'),
      untouchedKf: app.seqStates[0].kf ?? null,
    };
  })()
`);
console.log('--- colour + hide:', JSON.stringify(styled));
if (styled.coloured.hue < 300) problems.push(`the picked colour drew only ${styled.coloured.hue} px of its own hue`);
if (styled.neighbour.all < 1000) problems.push('the neighbouring keyframe drew no name at all — wrong baseline');
if (styled.neighbour.hue > 60) problems.push(`the colour bled onto the neighbouring keyframe (${styled.neighbour.hue} px)`);
if (styled.hidden.all > 200) problems.push(`hiding the name left ${styled.hidden.all} px on screen`);
if (styled.hidden.box) problems.push('a hidden name still records a box — it would stay grabbable');
if (styled.neighbourShown.all < 1000) problems.push('hiding one keyframe\'s name hid its neighbour\'s too');
if (styled.capHidden > 200) problems.push(`hiding the caption left ${styled.capHidden} px on screen`);
if (styled.restored < 1000) problems.push('un-hiding the name did not bring it back');
if (styled.untouchedKf !== null) problems.push('an untouched keyframe grew a kf block');
for (const k of ['nameColor', 'nameHidden', 'captionHidden']) {
  if (!(k in styled.kf)) problems.push(`kf.${k} is missing after it was set`);
}
await page.evaluate(() => { window.__app.applySeqT(0.6); });
await frames(3);
await page.screenshot({ path: `${outDir}/03-coloured-name.png` });

// ---- 8. each key merges and deletes on its own ------------------------------
const merge = await page.evaluate(() => {
  const app = window.__app;
  const s = app.seqStates[1];
  app.seqSetTextStyle(1, 'name', { hidden: false });
  app.seqSetTextStyle(1, 'caption', { hidden: false });
  const withColour = JSON.parse(JSON.stringify(s.kf));
  app.seqSetTextStyle(1, 'name', { color: null });
  const afterColour = JSON.parse(JSON.stringify(s.kf ?? null));
  // A keyframe carrying nothing else must lose its block entirely rather than
  // keeping an empty one — that is what makes an untouched file byte-identical.
  const bare = app.seqStates[2];
  const before = JSON.stringify(bare);
  app.seqSetTextStyle(2, 'caption', { color: '#00ff88' });
  app.seqSetTextStyle(2, 'caption', { color: null });
  return { withColour, afterColour, sameAfterRoundTrip: JSON.stringify(bare) === before, kfLeft: bare.kf ?? null };
});
console.log('--- kf merge/delete:', JSON.stringify(merge));
if ('nameHidden' in (merge.withColour ?? {})) problems.push('un-hiding left a nameHidden key behind');
if (merge.afterColour && 'nameColor' in merge.afterColour) problems.push('clearing the colour left its key behind');
if (!merge.sameAfterRoundTrip || merge.kfLeft !== null) {
  problems.push('setting then clearing a colour left the keyframe changed (an empty kf block?)');
}

// ---- 7. a REAL second tap opens the colour picker ---------------------------
await page.evaluate(() => {
  const app = window.__app;
  app.__asked = null;
  app.ui.__pick = app.ui.pickSeqTextColor;
  app.ui.pickSeqTextColor = (i, which) => { app.__asked = { i, which }; };
  app.setSeqTextPositions(null);
  app.applySeqT(0.6);
  app.requestRender(3);
});
await frames(3);
for (const key of ['name', 'caption']) {
  const p = await blockPoint(key);
  if (!p) { problems.push(`no ${key} block on screen to tap`); continue; }
  await page.evaluate(() => { window.__app.__asked = null; });
  await page.mouse.move(p.x, p.y); // hover hands the cursor to the block
  await sleep(140);
  await page.mouse.click(p.x, p.y);
  await page.mouse.click(p.x, p.y); // the second tap opens the picker
  await sleep(280);
  const asked = await page.evaluate(() => window.__app.__asked);
  console.log(`--- second tap on the ${key}: ${JSON.stringify(asked)}`);
  if (!asked) { problems.push(`a second tap on the ${key} opened no colour picker`); continue; }
  if (asked.which !== key || asked.i !== 1) {
    problems.push(`the ${key} tap asked for ${JSON.stringify(asked)}, expected keyframe 1 (index) / ${key}`);
  }
}
await page.evaluate(() => { window.__app.ui.pickSeqTextColor = window.__app.ui.__pick; });

// ---- 10. the COG-trail rebuild leaves the text alone ------------------------
const trail = await page.evaluate(async () => {
  const app = window.__app;
  app.applySeqT(0.6);
  const before = { name: app.seqNameShown(), caption: app.caption() };
  // A hand edit is what fires the trail's ~289 replays of the chain.
  app.editJoint(app.leader, 'elbow_L', () => {
    app.leader.setJointDegrees({ elbow_L: { x: -40 } });
  });
  await new Promise((r) => setTimeout(r, 400));
  return { before, after: { name: app.seqNameShown(), caption: app.caption() } };
});
console.log('--- across a COG-trail rebuild:', JSON.stringify(trail));
if (JSON.stringify(trail.before) !== JSON.stringify(trail.after)) {
  problems.push('the COG-trail rebuild changed the on-screen text (extras: false?)');
}

// ---- both blocks still work in PRESENT MODE ---------------------------------
// Present hides the chrome and takes the keyboard, and the pick spheres leave
// the slide with it — but the texts are the slide, so they must stay drawn AND
// stay grabbable. (Fullscreen is refused headless; everything else applies.)
const presenting = await page.evaluate(`
  (async () => { ${COUNTERS}
    const app = window.__app;
    const frame = () => new Promise((r) => { app.requestRender(3); requestAnimationFrame(() => requestAnimationFrame(r)); });
    app.applySeqT(0.6); await frame();
    await app.enterPresent?.();
    await frame(); await frame();
    const hud = document.getElementById('hud');
    const b = app.studio.seqNameBox;
    const gl = document.querySelector('#viewport canvas:not(#hud)');
    const r = gl.getBoundingClientRect();
    const hit = b ? app.studio.blockHit(
      (b.left + b.width / 2) * (r.width / hud.width),
      (b.top + b.height / 2) * (r.height / hud.height)) : null;
    const out = { name: countAlpha(hud, 'name'), caption: countAlpha(hud, 'caption'), hit, presenting: !!app.presenting };
    app.exitPresent?.();
    await frame();
    return out;
  })()
`);
console.log('--- in Present mode:', JSON.stringify(presenting));
if (!presenting.presenting) problems.push('Present mode never engaged — the rest of this check is meaningless');
if (presenting.name < 1000 || presenting.caption < 1000) {
  problems.push(`Present mode dropped the sequence texts (name ${presenting.name} px, caption ${presenting.caption} px)`);
}
if (presenting.hit !== 'name') problems.push(`the name block is not grabbable while presenting (hit ${presenting.hit})`);

// ---- 5b. and across a RELOAD ------------------------------------------------
const wanted = await page.evaluate(() => {
  const app = window.__app;
  app.setSeqTextPos('name', { x: 0.7, y: 0.3 });
  app.setSeqTextPos('caption', { x: 0.25, y: 0.62 });
  return app.seqTextPositions();
});
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await sleep(2000);
const reloaded = await page.evaluate(() => {
  const app = window.__app;
  return {
    pos: app.seqTextPositions(),
    stored: localStorage.getItem('tangoPoseStudio.seqText.v1'),
    rows: document.querySelectorAll('#seq-list .pose-item').length,
    eyes: document.querySelectorAll('#seq-list .seq-eye').length,
    resetShown: !document.getElementById('seq-text-row').hidden,
  };
});
console.log('--- after reload:', JSON.stringify(reloaded), 'wanted', JSON.stringify(wanted));
if (JSON.stringify(reloaded.pos) !== JSON.stringify(wanted)) {
  problems.push('the placement did not survive a reload (the ready-guard?)');
}
if (!reloaded.resetShown) problems.push('the ⟲ reset row is hidden although both texts have been moved');
if (!reloaded.eyes) problems.push('the row grew no show/hide controls for its texts');

// The sidebar row, at its real width, with the section open.
await page.evaluate(() => {
  document.querySelector('#sidebar-tabs [data-tab="teach"]').click();
  const sec = document.getElementById('sequence-section');
  if (sec.classList.contains('collapsed')) sec.querySelector('.collapse-toggle').click();
  sec.scrollIntoView({ block: 'start' });
});
await sleep(400);
const sec = await page.$('#sequence-section');
if (sec) await sec.screenshot({ path: `${outDir}/04-sidebar-row.png` });

await page.evaluate(() => {
  const app = window.__app;
  app.setSeqStates([]);
  app.setSeqTextPositions(null);
  app.clearKeyframeExtras();
  app.clearLabels();
  localStorage.removeItem('tangoPoseStudio.sequence.v1');
  localStorage.removeItem('tangoPoseStudio.seqText.v1');
});

if (problems.length) console.log(`\nPROBLEMS:\n- ${problems.join('\n- ')}`);
else console.log('\nAll sequence-text checks passed.');
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));
await browser.close();
process.exit(errors.length || problems.length ? 1 : 0);
