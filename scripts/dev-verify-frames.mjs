// Frame agreement gate: do the skeleton and body layers put the same
// anatomical landmark in the same place — IN EVERY POSE?
//
// This is the instrument the other suites lack, in two ways:
//
//  1. CORRESPONDING LANDMARKS, not node centroids. dev-verify-alignment.mjs
//     compares the centroid of all geometry hanging on a joint node against the
//     centroid of the skin attributed to it. Those are different objects (the
//     skeleton's `spine` node owns the whole vertebral column and ribcage; the
//     avatar's Spine bone owns a patch of skin), so its large torso numbers are
//     partly an artifact of ownership, not misalignment. src/landmarks.js
//     instead defines one point with an independent recipe per layer.
//
//  2. MULTIPLE POSES. The rig/atlas divergence is ~6 mm at rest and ~180 mm at
//     the embrace's deep elbow flexion, so a rest-only metric cannot see that
//     class of bug in principle — which is exactly how a green suite coexisted
//     with two rendered hands hanging 15 cm apart. Every pose below is sampled.
//
// Usage: node scripts/dev-verify-frames.mjs [outDir]   (dev server running)
// Honours DEV_URL for a dev server on another port.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || null;
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const URL = process.env.DEV_URL || 'http://localhost:5173/';

// Presets that stress different frames: rest (baseline), close embrace (deep
// elbow flexion — the palm-hold bug), walk (pitched/rolled feet — the foot
// bug), cruzada + ocho (crossed legs, dissociation), volcada (extreme lean).
const POSES = [
  { name: 'rest', preset: 0 },
  { name: 'close-embrace', preset: 1 },
  { name: 'walk', preset: 2 },
  { name: 'cruzada', preset: 4 },
  { name: 'forward-ocho', preset: 5 },
  { name: 'volcada', preset: 8 },
];

// Per-landmark tolerance (mm), on two different quantities:
//
//   abs    — the largest layer gap in any single pose.
//   spread — how much that gap CHANGES across poses (max − min).
//
// `spread` is the sharper instrument and the one to trust. A gap that grows
// with flexion is the signature of the rig/atlas divergence — two trees
// pivoting about different centers — which is precisely the failure that hid
// behind a green suite.
//
// `abs: null` means the absolute gap is REPORTED BUT NOT GATED. That is the
// honest setting for every bone-under-skin landmark: the true soft-tissue
// thickness over an iliac crest or a jugular notch is a real, unknown,
// non-zero distance, so any absolute threshold there is a number invented to
// be passed. Gating it would mean either tuning regexes until they hit a
// figure I made up, or suppressing a real signal. Only landmarks where the two
// layers genuinely describe the SAME visible place — the endpoints, where the
// bone is the thing inside the glove or shoe — get an absolute gate.
const TOL = {
  palm_center: { abs: 25, spread: 15 },
  fingertip_middle: { abs: 30, spread: 20 },
  // Informational: on a HEELED figure this compares the calcaneus to the shoe's
  // heel BLOCK, which hangs below and behind it by design — the follower reads
  // ~48 mm where the leader's flat shoe reads ~11 mm, and that difference is
  // her heel, not a defect. Same rule as the torso landmarks: no absolute gate
  // where the two layers do not describe the same object. Aim (AXIS_DEG_TOL)
  // and toe_tip are the foot's real acceptance tests.
  heel_back: { abs: null, spread: 15 },
  toe_tip: { abs: 30, spread: 20 },
  ankle_center: { abs: null, spread: 20 },
  acromion: { abs: null, spread: 25 },
  iliac_crest: { abs: null, spread: 25 },
  c7_spinous: { abs: null, spread: 20 },
  jugular_notch: { abs: null, spread: 25 },
};
const DEFAULT_TOL = { abs: 40, spread: 20 };

// How far a landmark may wander inside its own rig joint node's local frame
// across poses. This is the tightest and most important number the gate
// produces: it is the only one that can see a joint node diverging from the
// geometry it nominally represents, which is what a constraint solving on that
// node is actually aiming at.
const RIG_DRIFT_TOL = 15;

// How far the skeleton's midline through a part may point away from the
// avatar's. This is the foot's real acceptance test: aim, not overlay.
const AXIS_DEG_TOL = 5;

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const report = await page.evaluate(async (POSES) => {
  const { bindLandmarks, measureLandmarks, measureAxes } = await import('/src/landmarks.js');
  const app = window.__app;

  // Freeze each landmark's vertex set once, at rest, for every figure.
  app.applyPreset(0);
  for (const fig of app.figures) {
    fig.group.updateMatrixWorld(true);
    bindLandmarks(fig);
  }

  const out = { poses: [], coverage: null };
  // Coverage: which landmarks resolved in which layer (an empty set means the
  // recipe's regex matched nothing — a broken recipe, not a passing measurement).
  const f0 = app.figures[0];
  out.coverage = Object.entries(f0.landmarkSets).map(([key, s]) => ({
    key, skel: s.skeleton ? s.skeleton.length : 0, body: s.body ? s.body.length : 0,
  }));

  for (const pose of POSES) {
    app.applyPreset(pose.preset);
    // Let per-frame constraints (embrace, collision, floor clamp) settle.
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    const figs = [];
    for (const fig of app.figures) {
      fig.syncAtlasNodes?.();
      fig.group.updateMatrixWorld(true);
      figs.push({
        name: fig.name,
        marks: measureLandmarks(fig).map((m) => ({
          key: m.key, joint: m.joint, gapMm: m.gapMm,
          rigLocal: m.rigLocal ? m.rigLocal.toArray() : null,
          atlasLocal: m.atlasLocal ? m.atlasLocal.toArray() : null,
        })),
        axes: measureAxes(fig),
        axisFitDeg: fig.calibration?.axisDeg || null,
        heelPitchDeg: fig.heelPitchDeg || 0,
      });
    }
    out.poses.push({ name: pose.name, figures: figs });
  }
  app.applyPreset(0);
  return out;
}, POSES);

// ---- coverage first: an unresolved landmark is a broken recipe, not a pass ----
const unresolved = report.coverage.filter((c) => !c.skel || !c.body);
console.log('landmark coverage (verts selected per layer):');
for (const c of report.coverage) {
  const flag = (!c.skel || !c.body) ? '  <-- UNRESOLVED' : '';
  console.log(`  ${c.key.padEnd(20)} skel ${String(c.skel).padStart(4)} / body ${String(c.body).padStart(4)}${flag}`);
}

const problems = [];

// ---- midline agreement: does the skeletal foot POINT the way the shoe does ----
// Kept separate from the gap table on purpose. A foot can be perfectly aimed
// and still show a big heel/toe gap purely for being a different length than
// the shoe, so aim needs its own number.
const axisRows = new Map(); // `${figure}|${key}` -> {deg:[], off:[]}
for (const pose of report.poses) {
  for (const fig of pose.figures) {
    for (const a of fig.axes || []) {
      const k = `${fig.name}|${a.key}`;
      if (!axisRows.has(k)) axisRows.set(k, { deg: [], off: [] });
      axisRows.get(k).deg.push(a.deg);
      axisRows.get(k).off.push(a.offsetMm);
    }
  }
}
if (axisRows.size) {
  console.log('\n=== midline agreement (skeleton vs body long axis) ===');
  console.log('  part                    worst angle   worst off-axis offset   (correction applied at build)');
  for (const [k, v] of axisRows) {
    const [figure, key] = k.split('|');
    const dMax = Math.max(...v.deg);
    const oMax = Math.max(...v.off);
    // A heeled figure's skeletal foot is deliberately pitched up at the heel (a
    // pure sagittal tilt; see Figure.#pitchHeeledFoot), so the midline sits that
    // far off the shoe's flat sole BY DESIGN. Allow the design pitch on top of
    // the ordinary aim tolerance; 0 for a flat foot leaves the check unchanged.
    const heelPitch = report.poses[0].figures.find((f) => f.name === figure)?.heelPitchDeg || 0;
    const tol = AXIS_DEG_TOL + heelPitch;
    const flagD = dMax > tol ? '!' : ' ';
    const fitDeg = report.poses[0].figures.find((f) => f.name === figure)?.axisFitDeg?.[key];
    const was = fitDeg == null ? '' : `   was ${fitDeg.toFixed(1)}° off`;
    const heel = heelPitch ? `   (${heelPitch.toFixed(1)}° heel)` : '';
    console.log(`  ${(`${figure}/${key}`).padEnd(24)} ${dMax.toFixed(1).padStart(7)}°${flagD}  ${oMax.toFixed(1).padStart(9)} mm${was}${heel}`);
    if (dMax > tol) {
      problems.push(`${figure}/${key}: midlines ${dMax.toFixed(1)}° apart (tol ${tol.toFixed(1)}°) — the foot points a different way than the shoe`);
    }
  }
}

// ---- collect every (figure, landmark) series across poses ----
const series = new Map(); // `${figure}|${key}` -> [{ pose, mm }, …]
for (const pose of report.poses) {
  for (const fig of pose.figures) {
    for (const m of fig.marks) {
      if (m.gapMm == null) continue;
      const k = `${fig.name}|${m.key}`;
      if (!series.has(k)) series.set(k, []);
      series.get(k).push({ pose: pose.name, mm: m.gapMm, rigLocal: m.rigLocal, atlasLocal: m.atlasLocal, joint: m.joint });
    }
  }
}

const rows = [];
for (const [k, pts] of series) {
  const [figure, key] = k.split('|');
  const tol = TOL[key.replace(/_[LR]$/, '')] ?? DEFAULT_TOL;
  const hi = pts.reduce((a, p) => (p.mm > a.mm ? p : a));
  const lo = pts.reduce((a, p) => (p.mm < a.mm ? p : a));
  const spread = hi.mm - lo.mm;

  // Rig-node drift: how far the landmark WANDERS in its own joint node's local
  // frame across poses. Zero means the node faithfully represents the landmark;
  // a big number means constraint code aiming at that node is aiming at a
  // phantom. Reported as the widest separation between any two poses.
  let rigDriftMm = null;
  const locs = pts.filter((p) => p.rigLocal).map((p) => p.rigLocal);
  if (locs.length > 1) {
    let worstPair = 0;
    for (let i = 0; i < locs.length; i++) {
      for (let j = i + 1; j < locs.length; j++) {
        const d = Math.hypot(locs[i][0] - locs[j][0], locs[i][1] - locs[j][1], locs[i][2] - locs[j][2]);
        if (d > worstPair) worstPair = d;
      }
    }
    rigDriftMm = worstPair * 1000;
  }
  // Absolute offset from the rig node to the landmark it names, worst pose.
  // rigDrift says the node MOVES relative to the geometry; this says how far
  // from that geometry it sits at all — which is what a collision capsule or a
  // contact pin anchored on that node is actually wrong by.
  const offMm = locs.length
    ? Math.max(...locs.map((l) => Math.hypot(l[0], l[1], l[2]) * 1000)) : null;
  const aLocs = pts.filter((p) => p.atlasLocal).map((p) => p.atlasLocal);
  let atlasDriftMm = null;
  let atlasOffMm = null;
  if (aLocs.length > 1) {
    let w = 0;
    for (let i = 0; i < aLocs.length; i++) {
      for (let j = i + 1; j < aLocs.length; j++) {
        const dd = Math.hypot(aLocs[i][0] - aLocs[j][0], aLocs[i][1] - aLocs[j][1], aLocs[i][2] - aLocs[j][2]);
        if (dd > w) w = dd;
      }
    }
    atlasDriftMm = w * 1000;
    atlasOffMm = Math.max(...aLocs.map((l) => Math.hypot(l[0], l[1], l[2]) * 1000));
  }
  if (rigDriftMm != null && rigDriftMm > RIG_DRIFT_TOL) {
    problems.push(`${figure}/${key}: WANDERS ${rigDriftMm.toFixed(0)}mm inside the `
      + `'${pts[0].joint}' rig node across poses — code aiming at that node aims at a phantom`);
  }
  rows.push({ figure, key, hi, lo, spread, tol, rigDriftMm, offMm, atlasDriftMm, atlasOffMm });
  if (tol.abs != null && hi.mm > tol.abs) {
    problems.push(`${figure}/${key}: ${hi.mm.toFixed(0)}mm gap @ ${hi.pose} (abs tol ${tol.abs})`);
  }
  if (spread > tol.spread) {
    problems.push(`${figure}/${key}: gap MOVES ${spread.toFixed(0)}mm across poses `
      + `(${lo.mm.toFixed(0)}@${lo.pose} → ${hi.mm.toFixed(0)}@${hi.pose}, spread tol ${tol.spread})`);
  }
}

// Spread first — a gap that moves with pose is the frame bug; a large but
// steady gap is usually just bone-under-skin.
rows.sort((a, b) => (b.rigDriftMm ?? 0) - (a.rigDriftMm ?? 0));
console.log('\n=== per landmark: layer gap (worst / spread) and rig-node drift ===');
console.log('  landmark                    rigDrift nodeOff | atlasDrift atlasOff');
for (const r of rows) {
  const flagA = r.tol.abs == null ? '~' : (r.hi.mm > r.tol.abs ? '!' : ' ');
  const flagS = r.spread > r.tol.spread ? '!' : ' ';
  const rd = r.rigDriftMm == null ? '    -  '
    : `${r.rigDriftMm.toFixed(1).padStart(6)}${r.rigDriftMm > RIG_DRIFT_TOL ? '!' : ' '}`;
  const f = (v) => (v == null ? '    -' : v.toFixed(0).padStart(5));
  console.log(`  ${(`${r.figure}/${r.key}`).padEnd(28)}${f(r.rigDriftMm)}${f(r.offMm)}   |${f(r.atlasDriftMm)}${f(r.atlasOffMm)}`);
}

if (unresolved.length) {
  console.log(`\nUNRESOLVED RECIPES (regex matched no geometry):\n  ${unresolved.map((u) => u.key).join(', ')}`);
}
if (problems.length) console.log(`\nPROBLEMS:\n${problems.map((p) => `  ${p}`).join('\n')}`);
else console.log('\nAll landmarks within tolerance in every pose.');
console.log('\n' + (errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.'));

await browser.close();
process.exit(errors.length || unresolved.length ? 1 : 0);
