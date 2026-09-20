// Dev check: muscle highlighting works INSIDE the skeleton view.
//
// The layer dropdown is three mutually exclusive views, and `muscle` used to be
// the only one that drew a belly at all. A teacher showing one muscle on the
// bones had to turn on the whole atlas and then hide ~130 bellies by hand. So
// the SKELETON view gained a third visibility state: the bellies LIT in the
// Muscles panel render over the bare bones, everything else stays off. An empty
// lit set has to look exactly like the old skeleton view — that reduction is
// what let this be plain `skeleton` mode rather than a fourth dropdown entry,
// and it is the regression guard here.
//
// The load-bearing check is #2's POSED half. The bi-articular bellies are
// CPU-skinned every frame by Figure.updateMuscleSkin, which used to early-return
// on `!this.layers?.muscle` — so a belly lit over the skeleton rendered, but
// frozen in its bind pose, and came visibly away from the bone as the joint
// bent. Verified to FAIL with the guard reverted to `!this.layers?.muscle`:
// the attachment centroid then moves 0.0 mm through a 90° knee bend instead of
// the ~5 cm it moves now. Neither the visible flags nor a screenshot at rest
// can see that — only the posed geometry can.
//
// Honours DEV_URL (default http://localhost:5173) and BROWSER_PATH. Saves
// screenshots to argv[2].
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] || '.';
const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--window-size=1500,950', '--use-angle=default'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

// The Muscles panel is a Teach-tab section and ships folded; a hidden chip has
// no clickable point, and this run clicks them for real.
await page.evaluate(() => {
  const a = window.__app;
  a.setVisibleFigures('leader');
  a.activateTab('teach');
  a.setSectionCollapsed(document.getElementById('muscle-section'), false);
  // Start from a clean look — localStorage carries the panel's lit/hidden sets
  // between sessions (tangoPoseStudio.muscleLook.v1), so a previous run's
  // highlights would otherwise be sitting in the "no lit muscles" case.
  document.getElementById('muscle-clear-hl').click();
  document.getElementById('muscle-show-all').click();
});
const setLayer = (mode) => page.evaluate((m) => {
  const sel = document.getElementById('layer-mode');
  sel.value = m;
  sel.dispatchEvent(new Event('change'));
}, mode);

// How many bellies are on screen, out of how many exist, for both dancers.
const visCount = () => page.evaluate(() => {
  const a = window.__app;
  const count = (f) => {
    const all = f.layerMeshes.muscle;
    return { on: all.filter((m) => m.visible).length, total: all.length };
  };
  return { leader: count(a.leader), follower: count(a.follower) };
});

// ---- 1. Skeleton view with nothing lit draws no bellies (as it always did).
await setLayer('skeleton');
await sleep(500);
const empty = await visCount();
if (empty.leader.on !== 0 || empty.follower.on !== 0) {
  problems.push(`skeleton view with an empty lit set shows ${empty.leader.on}/${empty.follower.on} bellies, expected 0`);
}
console.log(`--- skeleton, nothing lit: ${empty.leader.on} of ${empty.leader.total} bellies visible`);
await page.screenshot({ path: `${outDir}/ms-skeleton-empty.png` });

// Pick a SKINNED (bi-articular) belly that crosses the knee, so posing the knee
// has to deform it. Its two nodes are the atlas seats hip_L/knee_L — the
// gastrocnemius heads on this atlas, which ride the femoral condyles and cross
// the knee.
const target = await page.evaluate(() => {
  const f = window.__app.leader;
  for (let i = 0; i < f._skinMuscles.length; i++) {
    const sm = f._skinMuscles[i];
    const a = sm.nodeA.userData.jointName;
    const b = sm.nodeB.userData.jointName;
    const label = sm.mesh.userData.muscleName;
    if (!label) continue;
    if ([a, b].includes('knee_L') && [a, b].includes('hip_L')) return { i, label, a, b };
  }
  return null;
});
if (!target) {
  problems.push('no named bi-articular belly crossing the left knee — cannot test the skinning guard');
}
console.log(`--- probe belly: ${target?.label} (${target?.a} → ${target?.b})`);

// The centroid of the tissue COMMITTED to nodeB (skin weight ≥ 0.8), in
// figure-local space, read off the live geometry attribute — which is exactly
// what updateMuscleSkin writes and nothing else touches.
const attach = (i) => page.evaluate((idx) => {
  const sm = window.__app.leader._skinMuscles[idx];
  const p = sm.mesh.geometry.attributes.position.array;
  let n = 0; let x = 0; let y = 0; let z = 0;
  for (let k = 0; k < sm.weight.length; k++) {
    if (sm.weight[k] < 0.8) continue;
    x += p[k * 3]; y += p[k * 3 + 1]; z += p[k * 3 + 2]; n++;
  }
  return n ? [x / n, y / n, z / n] : null;
}, i);

// Click the belly's "highlight" chip for real, through the panel.
const clickChip = async (label) => {
  const found = await page.evaluate((want) => {
    for (const row of document.querySelectorAll('.muscle-row')) {
      if (row.querySelector('label').textContent.trim() !== want) continue;
      const btn = row.querySelector('.muscle-hl');
      btn.id = 'probe-hl-chip';
      row.scrollIntoView({ block: 'center' });
      return true;
    }
    return false;
  }, label);
  if (!found) return false;
  await page.click('#probe-hl-chip'); // a real pointer click: the chip must be usable here
  await page.evaluate(() => document.getElementById('probe-hl-chip').removeAttribute('id'));
  return true;
};

// ---- 2. Lighting a belly in skeleton view shows exactly that belly...
if (target) {
  if (!await clickChip(target.label)) problems.push(`no "${target.label}" row in the Muscles panel to click`);
  await sleep(500);
  const lit = await visCount();
  const shown = await page.evaluate(() => window.__app.leader.layerMeshes.muscle
    .filter((m) => m.visible).map((m) => m.userData.muscleName));
  if (shown.some((n) => n !== target.label)) {
    problems.push(`lighting "${target.label}" also revealed ${[...new Set(shown.filter((n) => n !== target.label))].join(', ')}`);
  }
  if (!shown.length) problems.push(`lighting "${target.label}" in skeleton view revealed nothing`);
  console.log(`--- skeleton, "${target.label}" lit: ${lit.leader.on} of ${lit.leader.total} visible (follower ${lit.follower.on})`);
  if (lit.follower.on !== lit.leader.on) {
    problems.push(`the lit belly shows on ${lit.leader.on} meshes for the leader but ${lit.follower.on} for the follower (labels light both dancers)`);
  }
  await page.screenshot({ path: `${outDir}/ms-skeleton-lit.png` });

  // ...and it is POSED, not frozen at bind. This is the updateMuscleSkin guard.
  const before = await attach(target.i);
  await page.evaluate(() => {
    window.__app.leader.setJointDegrees({ knee_L: { x: 90 } });
    window.__app.markEdit?.(window.__app.leader);
  });
  await sleep(700);
  const after = await attach(target.i);
  if (!before || !after) {
    problems.push('could not read the belly attachment centroid (no vertices at weight ≥ 0.8)');
  } else {
    const moved = Math.hypot(...after.map((v, k) => v - before[k])) * 1000;
    console.log(`--- "${target.label}" attachment moved ${moved.toFixed(1)} mm through a 90° knee bend`);
    if (moved < 10) {
      problems.push(`the lit belly is frozen at bind: its attachment moved only ${moved.toFixed(1)} mm through a 90° knee bend (updateMuscleSkin is still gated on layers.muscle)`);
    }
  }
  await page.screenshot({ path: `${outDir}/ms-skeleton-lit-posed.png` });
  await page.evaluate(() => window.__app.leader.setJointDegrees({ knee_L: { x: 0 } }));
  await sleep(400);
}

// ---- 3. Unlighting hides it again; the other two views are unchanged.
if (target) {
  await clickChip(target.label);
  await sleep(400);
  const off = await visCount();
  if (off.leader.on !== 0) problems.push(`unlighting left ${off.leader.on} bellies on screen in skeleton view`);
  console.log(`--- unlit again: ${off.leader.on} visible`);
  await page.screenshot({ path: `${outDir}/ms-skeleton-unlit.png` });
}

await setLayer('muscle');
await sleep(500);
const all = await visCount();
if (all.leader.on !== all.leader.total) {
  problems.push(`muscle view shows ${all.leader.on} of ${all.leader.total} bellies, expected all`);
}
console.log(`--- muscle view: ${all.leader.on} of ${all.leader.total} visible`);
await page.screenshot({ path: `${outDir}/ms-muscle-mode.png` });

// Body view hides every belly even with one lit — the avatar is opaque.
if (target) await clickChip(target.label);
await setLayer('body');
await sleep(500);
const body = await visCount();
if (body.leader.on !== 0) problems.push(`body view shows ${body.leader.on} bellies with one lit, expected 0`);
console.log(`--- body view with one lit: ${body.leader.on} visible`);
await page.screenshot({ path: `${outDir}/ms-body-mode.png` });

// ---- 4. A slide round-trips skeleton + lit. getViewState stores `layer` and
// `muscles.lit` separately, and applyViewState replays the layer FIRST — so the
// lit set has to re-run the visibility pass after it, or the slide comes back
// as a bare skeleton.
await setLayer('skeleton');
await sleep(400);
const slideLit = await visCount();
if (slideLit.leader.on === 0) problems.push('setup for the slide check: nothing lit is showing in skeleton view');
const slide = await page.evaluate(() => JSON.parse(JSON.stringify(
  window.__app.getCoupleState('probe slide', { view: true }))));
if (slide.view?.layer !== 'skeleton') problems.push(`the slide recorded layer "${slide.view?.layer}", expected "skeleton"`);
if (!slide.view?.muscles?.lit?.length) problems.push('the slide recorded no lit muscles');

// Walk away from that view entirely, then show the slide.
await setLayer('muscle');
if (target) await clickChip(target.label); // and drop the highlight
await sleep(400);
await page.evaluate((s) => window.__app.applyCoupleState(s), slide);
await sleep(700);
const restored = await visCount();
const mode = await page.evaluate(() => document.getElementById('layer-mode').value);
if (mode !== 'skeleton') problems.push(`the slide restored layer "${mode}", expected "skeleton"`);
if (restored.leader.on !== slideLit.leader.on) {
  problems.push(`the slide restored ${restored.leader.on} visible bellies, expected ${slideLit.leader.on}`);
}
console.log(`--- slide round trip: layer ${mode}, ${restored.leader.on} bellies visible (saved ${slideLit.leader.on})`);
await page.screenshot({ path: `${outDir}/ms-slide-restored.png` });

// The panel's nudge must tell the truth: it is only the opaque body view that
// hides the bellies now.
const note = await page.evaluate(() => {
  const el = document.getElementById('muscle-layer-note');
  const at = (m) => {
    const sel = document.getElementById('layer-mode');
    sel.value = m; sel.dispatchEvent(new Event('change'));
    return el.hidden;
  };
  return { skeleton: at('skeleton'), muscle: at('muscle'), body: at('body') };
});
if (!note.skeleton) problems.push('the "turn on the Muscles layer" note still shows in skeleton view, where the chips work');
if (!note.muscle) problems.push('the muscle-layer note shows in the muscle view');
if (note.body) problems.push('the muscle-layer note is missing in body view, where nothing renders');

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'All muscle-in-skeleton checks passed.');
console.log(logs.length ? `Console errors:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
process.exit(problems.length || logs.length ? 1 : 0);
