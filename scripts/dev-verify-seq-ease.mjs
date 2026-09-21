// Dev check for EASED TRANSITIONS in the movement sequence — the sequence-wide
// "Ease in/out" toggle (app.seqEase / app.setSeqEase, easeU in main.js).
//
// What it pins, and why each is here rather than taken on trust:
//  - OFF is the OLD ARITHMETIC. Every t is compared against the linear map
//    computed from the keyframes' OWN stored angles, so the reference does not
//    pass through the code under test at all. A joint lerps component-wise
//    (lerpPose), so angle(t) = a + (b − a)·u is exact, and the whole change is
//    what u is — which makes this the sharpest possible statement of "ease off
//    changed nothing".
//  - ON follows the REST RULE: ease out of a keyframe only where the couple
//    was at rest there (the first, the last, or a hold > 0) and into one only
//    where it will rest; a pass-through keyframe is crossed at speed. Measured
//    as the normalized slope f'(0)/f'(1) of each segment — 0 at an eased end,
//    ~1 at a linear one, ~1.5 at the free end of a one-sided curve (the halves
//    of smoothstep, see easeU). This is the check that would catch "easing
//    every segment to a stop", which looks right in a screenshot and stutters
//    on video.
//  - the COG TRAIL is byte-identical on and off. The trail is sampled by POSE
//    PARAMETER, and easing is a remap of TIME — so if a single vertex moves,
//    the remap has leaked into applyStatesU and the shape of the path now
//    depends on the tempo it is played at.
//  - endpoints are EXACT. Every eased branch is exactly 0 at u = 0 and 1 at
//    u = 1 in floating point, so a keyframe arrival still renders that
//    keyframe's own pose bit for bit and a hold is byte-stable across its band.
//  - no overshoot: the pose never leaves the segment's own [A, B] interval and
//    never reverses inside a segment (an eased u must stay in [0, 1] and
//    non-decreasing — a spline through the keyframes would not).
//  - the grounded planted foot still holds the floor with easing on (the
//    measurement dev-verify-interp-keys uses), A→B is untouched, the flag
//    survives a reload and a file round trip, a legacy file imports OFF, a
//    fresh timeline starts ON, a recording runs eased, and the eased player
//    still takes the stated seconds.
//
// Usage: node scripts/dev-verify-seq-ease.mjs <outDir>   (dev server running)
// Honours DEV_URL and BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const outDir = process.argv[2] || 'shots-seq-ease';
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173/';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  defaultViewport: { width: 1280, height: 900 },
  userDataDir: process.env.USER_DATA_DIR || undefined,
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1800);

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

// ---------------------------------------------------------------- the model
// The expected mapping, written out here in full rather than imported, so the
// script states the rule independently of the implementation. Node-side, on
// numbers the page hands back — nothing in this block runs in the app.
const S = (u) => u * u * (3 - 2 * u);
const linearMap = (holds, moves, t) => {
  const segs = moves.length;
  const total = holds.reduce((a, b) => a + b, 0) + moves.reduce((a, b) => a + b, 0);
  let time = Math.min(Math.max(t, 0), 1) * total;
  for (let j = 0; j < segs; j++) {
    if (time <= holds[j]) return { i: j, u: 0 };
    time -= holds[j];
    if (time <= moves[j] || j === segs - 1) {
      return { i: j, u: Math.min(Math.max(time / moves[j], 0), 1) };
    }
    time -= moves[j];
  }
  return { i: segs - 1, u: 1 };
};
// Is keyframe j one the couple is AT REST on? The chain's ends by
// construction; elsewhere it takes a hold.
const rests = (holds, n, j) => j === 0 || j === n - 1 || holds[j] > 0;
const easedU = (holds, n, i, u) => {
  const out = rests(holds, n, i);
  const into = rests(holds, n, i + 1);
  if (out && into) return S(u);
  if (out) return 2 * S(u / 2);
  if (into) return 2 * S(0.5 + u / 2) - 1;
  return u;
};

// ---------------------------------------------------------------- the chain
// FIVE keyframes, so all four segment kinds appear in one timeline:
//   0 →1  rest → pass-through   (eased out only)
//   1 →2  pass → pass           (linear: a giro's flowing middle)
//   2 →3  pass → rest           (eased in only)
//   3 →4  rest → rest           (the full S)
// The measured joint is an ELBOW, deliberately: the grounded-feet pass
// re-solves hip/knee/ankle after the lerp, so a leg joint is not a clean
// readout of u. Every keyframe is the same standing preset with one elbow
// angle changed, which also keeps the feet identical and the grounding a
// no-op for the arithmetic checks (§7 tests it with the feet really moving).
const ELBOWS = [-10, -60, -120, -35, -90]; // degrees, inside the elbow's [-150, 0]
const built = await page.evaluate(async (degs) => {
  const app = window.__app;
  localStorage.removeItem('tangoPoseStudio.seqEase.v1');
  app.setSeqStates([]);
  app.linkCouple = false;
  for (const d of degs) {
    app.applyPreset(0);
    app.editJoint(app.leader, 'elbow_L', () => {
      app.leader.nodes.elbow_L.rotation.x = d * Math.PI / 180;
    });
    app.seqAdd();
  }
  // A pass-through is hold 0 (the default); rests get a real hold. Distinct
  // moves throughout, so a bug that assumed equal segments shows up.
  app.seqSetTravel(1, 2.0);
  app.seqSetTravel(2, 3.0);
  app.seqSetTravel(3, 1.5);
  app.seqSetTravel(4, 2.5);
  app.seqSetHold(3, 1.5);
  return {
    // The freshly-started timeline's own default — requirement: a sequence
    // begun from an EMPTY list eases.
    freshEase: app.seqEase(),
    boxChecked: document.getElementById('seq-ease').checked,
    holds: app.seqStates.map((_, i) => app.seqHold(i)),
    moves: app.seqStates.slice(1).map((_, i) => app.seqTravel(i + 1)),
    // The reference angles, read from the KEYFRAME DATA, not from a pose.
    keyAngles: app.seqStates.map((s) => s.figures[0].joints.elbow_L[0]),
    total: app.seqSeconds(),
  };
}, ELBOWS);
const { holds, moves, keyAngles } = built;
const N = keyAngles.length;
console.log(`--- chain: ${N} keyframes, moves ${JSON.stringify(moves)}s, holds ${JSON.stringify(holds)}s, ${built.total}s total`);
console.log(`--- fresh timeline default: seqEase=${built.freshEase}, checkbox ${built.boxChecked}`);
check(built.freshEase === true, `a timeline started from empty came up with ease ${built.freshEase}, want true`);
check(built.boxChecked === true, 'the Ease in/out checkbox did not follow the fresh default');

// A sampler: pose at each t and read the elbow back off the figure.
const sampleAt = async (ts, ease) => page.evaluate((list, on) => {
  const app = window.__app;
  app.setSeqEase(on);
  return list.map((t) => { app.applySeqT(t); return app.leader.nodes.elbow_L.rotation.x; });
}, ts, ease);

const DENSE = Array.from({ length: 401 }, (_, k) => k / 400);

// ---- 1. OFF is byte-identical to the linear arithmetic ---------------------
const offAngles = await sampleAt(DENSE, false);
let offWorst = 0;
let offWorstT = 0;
DENSE.forEach((t, k) => {
  const { i, u } = linearMap(holds, moves, t);
  const want = keyAngles[i] + (keyAngles[i + 1] - keyAngles[i]) * u;
  const err = Math.abs(offAngles[k] - want);
  if (err > offWorst) { offWorst = err; offWorstT = t; }
});
console.log(`--- ease OFF vs the linear map over ${DENSE.length} t: worst ${offWorst.toExponential(2)} rad (at t=${offWorstT})`);
check(offWorst < 1e-12, `ease off is no longer the linear arithmetic: ${offWorst.toExponential(2)} rad off at t=${offWorstT}`);

// ---- 2. ON follows the rest rule, to the same precision --------------------
const onAngles = await sampleAt(DENSE, true);
let onWorst = 0;
let onWorstT = 0;
DENSE.forEach((t, k) => {
  const { i, u } = linearMap(holds, moves, t);
  const want = keyAngles[i] + (keyAngles[i + 1] - keyAngles[i]) * easedU(holds, N, i, u);
  const err = Math.abs(onAngles[k] - want);
  if (err > onWorst) { onWorst = err; onWorstT = t; }
});
console.log(`--- ease ON vs the eased map: worst ${onWorst.toExponential(2)} rad (at t=${onWorstT})`);
check(onWorst < 1e-12, `the eased pose does not follow the rest rule: ${onWorst.toExponential(2)} rad off at t=${onWorstT}`);

// …and it is really a DIFFERENT movement: the two runs must part company
// mid-segment (an "ease" that changed nothing would pass §1 and §2 both).
let maxDiff = 0;
DENSE.forEach((_, k) => { maxDiff = Math.max(maxDiff, Math.abs(onAngles[k] - offAngles[k])); });
console.log(`--- ON vs OFF: they differ by up to ${(maxDiff * 180 / Math.PI).toFixed(1)}° mid-segment`);
check(maxDiff > 0.05, `ease on and off give the same poses (max ${maxDiff.toExponential(2)} rad) — the toggle is not reaching the player`);

// ---- 3. Direction, endpoints and no overshoot ------------------------------
// Segment 3 is the full S: early on the eased pose LAGS the linear one (it is
// still leaving the keyframe) and late it LEADS (it is already braking). The
// sign is read against the direction of travel, so it holds whichever way the
// joint is moving.
const shape = await page.evaluate((h, m) => {
  const app = window.__app;
  const total = h.reduce((a, b) => a + b, 0) + m.reduce((a, b) => a + b, 0);
  // t at fraction `u` of segment `seg`, in the chain's running time.
  const tAt = (seg, u) => {
    let time = 0;
    for (let j = 0; j < seg; j++) time += h[j] + m[j];
    time += h[seg] + u * m[seg];
    return time / total;
  };
  const ang = (t, on) => { app.setSeqEase(on); app.applySeqT(t); return app.leader.nodes.elbow_L.rotation.x; };
  const arrivals = app.seqStates.map((_, i) => {
    let time = 0;
    for (let j = 0; j < i; j++) time += h[j] + m[j];
    return (time + h[i]) / total; // the instant keyframe i is REACHED
  });
  return {
    early: { lin: ang(tAt(3, 0.25), false), eased: ang(tAt(3, 0.25), true) },
    late: { lin: ang(tAt(3, 0.75), false), eased: ang(tAt(3, 0.75), true) },
    // Exactness at every arrival, with easing on.
    atKeys: arrivals.map((t) => ang(t, true)),
    // A hold must stand perfectly still across its whole band (keyframe 3).
    hold: [0.0, 0.25, 0.5, 0.75, 1.0].map((f) => {
      let time = 0;
      for (let j = 0; j < 3; j++) time += h[j] + m[j];
      return ang((time + f * h[3]) / total, true);
    }),
  };
}, holds, moves);

const dir = Math.sign(keyAngles[4] - keyAngles[3]);
const earlyLag = (shape.early.lin - shape.early.eased) * dir;
const lateLead = (shape.late.eased - shape.late.lin) * dir;
console.log(`--- full-S segment: eased lags linear by ${(earlyLag * 180 / Math.PI).toFixed(1)}° at u=0.25 and leads by ${(lateLead * 180 / Math.PI).toFixed(1)}° at u=0.75`);
check(earlyLag > 0.01, `eased pose does not lag the linear one early in a rest→rest segment (${earlyLag.toExponential(2)} rad)`);
check(lateLead > 0.01, `eased pose does not lead the linear one late in a rest→rest segment (${lateLead.toExponential(2)} rad)`);

const keyErr = shape.atKeys.map((a, i) => Math.abs(a - keyAngles[i]));
console.log(`--- arrival poses (ease on): worst ${Math.max(...keyErr).toExponential(2)} rad off the keyframe's own angle`);
check(Math.max(...keyErr) === 0, `a keyframe arrival is not EXACT with easing on: ${JSON.stringify(keyErr)}`);
const holdSpread = Math.max(...shape.hold) - Math.min(...shape.hold);
console.log(`--- hold band (ease on): spread ${holdSpread.toExponential(2)} rad across 5 samples`);
check(holdSpread === 0, `the hold moved ${holdSpread} rad with easing on — a hold must stand still`);

// Monotone progress: inside each segment the eased pose walks from A to B and
// never past either. Overshoot is what a keyframe-spanning spline would give,
// and it is exactly what this must not do.
let overshoot = 0;
let reversals = 0;
DENSE.forEach((t, k) => {
  const { i } = linearMap(holds, moves, t);
  const lo = Math.min(keyAngles[i], keyAngles[i + 1]);
  const hi = Math.max(keyAngles[i], keyAngles[i + 1]);
  overshoot = Math.max(overshoot, lo - onAngles[k], onAngles[k] - hi);
  if (k === 0) return;
  const prev = linearMap(holds, moves, DENSE[k - 1]);
  if (prev.i !== i) return; // a segment boundary is not a reversal
  const step = (onAngles[k] - onAngles[k - 1]) * Math.sign(keyAngles[i + 1] - keyAngles[i]);
  if (step < -1e-12) reversals++;
});
console.log(`--- monotone: worst overshoot ${overshoot.toExponential(2)} rad, ${reversals} backward steps in ${DENSE.length} samples`);
check(overshoot <= 0, `the eased pose overshot its segment by ${overshoot.toExponential(2)} rad`);
check(reversals === 0, `the eased pose went backwards ${reversals} times inside a segment`);

// ---- 4. The rest rule, measured as SPEED at each segment end ---------------
// The normalized slope of the curve: 0 where the segment is eased, ~1 where it
// is linear, ~1.5 at the free end of a one-sided curve (a half of smoothstep
// hands over at S'(0.5) = 1.5). This is the number that tells a flowing giro
// from a stutter, and no pose comparison can see it.
const speeds = await page.evaluate((h, m) => {
  const app = window.__app;
  app.setSeqEase(true);
  const total = h.reduce((a, b) => a + b, 0) + m.reduce((a, b) => a + b, 0);
  const tAt = (seg, u) => {
    let time = 0;
    for (let j = 0; j < seg; j++) time += h[j] + m[j];
    return (time + h[seg] + u * m[seg]) / total;
  };
  const ang = (t) => { app.applySeqT(t); return app.leader.nodes.elbow_L.rotation.x; };
  const du = 0.002;
  return m.map((_, seg) => {
    const span = app.seqStates[seg + 1].figures[0].joints.elbow_L[0]
      - app.seqStates[seg].figures[0].joints.elbow_L[0];
    const a0 = ang(tAt(seg, 0));
    const a1 = ang(tAt(seg, du));
    const b0 = ang(tAt(seg, 1 - du));
    const b1 = ang(tAt(seg, 1));
    return { start: (a1 - a0) / (du * span), end: (b1 - b0) / (du * span) };
  });
}, holds, moves);
const KIND = ['rest→pass (ease out only)', 'pass→pass (linear)', 'pass→rest (ease in only)', 'rest→rest (full S)'];
const WANT = [{ start: 0, end: 1.5 }, { start: 1, end: 1 }, { start: 1.5, end: 0 }, { start: 0, end: 0 }];
speeds.forEach((s, i) => {
  console.log(`--- seg ${i} ${KIND[i]}: f'(0)=${s.start.toFixed(3)} f'(1)=${s.end.toFixed(3)} (want ${WANT[i].start} / ${WANT[i].end})`);
  check(Math.abs(s.start - WANT[i].start) < 0.05, `segment ${i} (${KIND[i]}) leaves at ${s.start.toFixed(3)}× , want ${WANT[i].start}`);
  check(Math.abs(s.end - WANT[i].end) < 0.05, `segment ${i} (${KIND[i]}) arrives at ${s.end.toFixed(3)}× , want ${WANT[i].end}`);
});

// ---- 5. The COG trail is byte-identical on and off -------------------------
// Presets this time: the elbow chain barely moves a centre of gravity. The
// toggle deliberately does NOT rebuild the trail (it cannot change it), so the
// rebuild is forced by re-setting a travel to the value it already has.
const trail = await page.evaluate(() => {
  const app = window.__app;
  const pts = () => {
    const grp = app.scene.children.find((c) => c.children.some?.((l) => l.isLine && l.material.vertexColors));
    return grp ? grp.children.filter((l) => l.isLine).map((l) => [...l.geometry.attributes.position.array]) : null;
  };
  app.setSeqStates([]);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  app.applyPreset(1); app.seqAdd();
  app.seqSetHold(1, 3);
  app.setSeqEase(false);
  app.seqSetTravel(1, app.seqTravel(1)); // force a rebuild without changing anything
  const off = pts();
  app.setSeqEase(true);
  app.seqSetTravel(1, app.seqTravel(1));
  const on = pts();
  const same = off && on && off.length === on.length
    && off.every((line, i) => line.length === on[i].length && line.every((v, k) => v === on[i][k]));
  return { lines: off?.length, n: off?.[0]?.length / 3, same };
});
console.log(`--- COG trail: ${trail.lines} lines × ${trail.n} samples, identical on/off: ${trail.same}`);
check(trail.same === true, 'the COG trail changed when easing was switched on — the remap has leaked into applyStatesU');

// ---- 6. The A→B compare player is untouched --------------------------------
// A bare [A, B] pair carries no settings, so it stays linear whatever the
// sequence's toggle says — checked with the toggle ON, which is the only state
// in which this can fail.
const ab = await page.evaluate(() => {
  const app = window.__app;
  app.setSeqEase(true);
  app.applyPreset(0);
  app.editJoint(app.leader, 'elbow_L', () => { app.leader.nodes.elbow_L.rotation.x = -0.2; });
  const A = app.getCoupleState('A');
  app.editJoint(app.leader, 'elbow_L', () => { app.leader.nodes.elbow_L.rotation.x = -1.4; });
  const B = app.getCoupleState('B');
  app.setInterpStates(A, B);
  const a = A.figures[0].joints.elbow_L[0];
  const b = B.figures[0].joints.elbow_L[0];
  const worst = [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9].reduce((w, t) => {
    app.applyInterp(t);
    return Math.max(w, Math.abs(app.leader.nodes.elbow_L.rotation.x - (a + (b - a) * t)));
  }, 0);
  return { worst };
});
console.log(`--- A→B with the sequence toggle ON: worst ${ab.worst.toExponential(2)} rad off the straight lerp`);
check(ab.worst < 1e-12, `the A→B player was eased too (${ab.worst.toExponential(2)} rad off linear)`);

// ---- 7. Grounded planted feet, with easing on ------------------------------
// The same measurement dev-verify-interp-keys makes for the linear case: both
// feet grounded at both ends of a snapped step must still touch the floor and
// track the lerped line halfway through. Easing moves WHEN that halfway is,
// not whether the feet are grounded there — but the grounding runs after the
// eased lerp, so it is worth saying so in a number.
const feet = await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqStates([]);
  app.applyPreset(0);
  app.linkCouple = false;
  app.setVisibleFigures('leader');
  const f = app.leader;
  const ankleAt = (side) => f.worldPos(`ankle_${side}`).clone();
  app.seqAdd();
  const aL = ankleAt('L');
  const aR = ankleAt('R');
  app.animateSteps = false;
  app.stepFigure(f, 1);
  app.seqAdd();
  const bL = ankleAt('L');
  const bR = ankleAt('R');
  app.setSeqEase(true);
  // t = 0.5 of a two-keyframe chain is u = 0.5 linear; the full S maps it to
  // 0.5 as well, so the feet must land on exactly the same lerped spots the
  // linear run gives — the strongest form of "easing did not move the path".
  app.applySeqT(0.5);
  const midL = ankleAt('L');
  const midR = ankleAt('R');
  const expL = aL.clone().lerp(bL, 0.5);
  const expR = aR.clone().lerp(bR, 0.5);
  const low = { L: f.footLowY('L'), R: f.footLowY('R') };
  // …and a quarter of the way through, where the eased pose really is
  // somewhere else: the feet must still be ON the floor.
  app.applySeqT(0.25);
  const quarter = { L: f.footLowY('L'), R: f.footLowY('R') };
  app.setVisibleFigures('both');
  return {
    lowL: +low.L.toFixed(4),
    lowR: +low.R.toFixed(4),
    devL: +Math.hypot(midL.x - expL.x, midL.z - expL.z).toFixed(4),
    devR: +Math.hypot(midR.x - expR.x, midR.z - expR.z).toFixed(4),
    qL: +quarter.L.toFixed(4),
    qR: +quarter.R.toFixed(4),
  };
});
console.log(`--- grounded feet (ease on): t=0.5 low L=${feet.lowL} R=${feet.lowR}, ankle off the lerped track L=${feet.devL} R=${feet.devR} m · t=0.25 low L=${feet.qL} R=${feet.qR}`);
for (const [k, v] of Object.entries({ 'L@0.5': feet.lowL, 'R@0.5': feet.lowR, 'L@0.25': feet.qL, 'R@0.25': feet.qR })) {
  check(v >= -0.005 && v <= 0.015, `${k}: a planted foot left the floor with easing on (low ${v})`);
}
check(feet.devL <= 0.02 && feet.devR <= 0.02, `eased t=0.5 put the ankles ${feet.devL}/${feet.devR} m off the lerped track`);
await sleep(200);
await page.screenshot({ path: `${outDir}/seq-ease-grounded.png` });

// ---- 8. Clear resets to the fresh default ----------------------------------
const fresh = await page.evaluate(() => {
  const app = window.__app;
  app.setSeqEase(false);
  const offBefore = app.seqEase();
  app.setSeqStates([]); // what Clear does
  const afterClear = app.seqEase();
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  const afterAdd = app.seqEase();
  // …but the default is a DEFAULT: unticking the box on an empty timeline and
  // then adding the first keyframe must keep the answer just given, not have
  // it overruled by the freshness rule.
  app.setSeqStates([]);
  app.setSeqEase(false);
  app.applyPreset(0); app.seqAdd();
  app.applyPreset(2); app.seqAdd();
  return { offBefore, afterClear, afterAdd, saidOff: app.seqEase(), box: document.getElementById('seq-ease').checked };
});
console.log(`--- fresh default: off→${fresh.offBefore}, cleared→${fresh.afterClear}, first keyframe→${fresh.afterAdd}; unticked-then-added→${fresh.saidOff} (box ${fresh.box})`);
check(fresh.offBefore === false, 'setSeqEase(false) did not take');
check(fresh.afterClear === true, `clearing the timeline left ease ${fresh.afterClear}, want the fresh default true`);
check(fresh.afterAdd === true, 'a keyframe added to an empty timeline did not come up eased');
check(fresh.saidOff === false, 'the fresh default overruled an explicit setSeqEase(false) made before the first keyframe');
check(fresh.box === false, 'the checkbox does not show the setting after the unticked-then-added case');

// ---- 9. The toggle re-poses mid-scrub --------------------------------------
const midScrub = await page.evaluate(() => {
  const app = window.__app;
  app.setSeqEase(false);
  app.applySeqT(0.3);
  const before = app.leader.nodes.elbow_L.rotation.x;
  const t = app.seqT;
  document.getElementById('seq-ease').checked = true;
  document.getElementById('seq-ease').dispatchEvent(new Event('change', { bubbles: true }));
  return { before, after: app.leader.nodes.elbow_L.rotation.x, t, tAfter: app.seqT, on: app.seqEase() };
});
console.log(`--- toggle mid-scrub at t=${midScrub.t}: elbow ${midScrub.before.toFixed(4)} → ${midScrub.after.toFixed(4)} rad, t held at ${midScrub.tAfter}`);
check(midScrub.on === true, 'the checkbox did not reach app.setSeqEase');
check(Math.abs(midScrub.after - midScrub.before) > 1e-6, 'toggling mid-scrub did not re-pose the couple at the current t');
check(midScrub.tAfter === midScrub.t, `toggling moved the scrubber (${midScrub.t} → ${midScrub.tAfter})`);

// ---- 10. Export / import / legacy ------------------------------------------
const round = await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqEase(true);
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

  app.setSeqEase(false);
  await importFile(payload);
  const imported = { ease: app.seqEase(), states: app.seqStates.length, box: document.getElementById('seq-ease').checked };

  // A LEGACY file: the same payload with no `ease` key at all. It was authored
  // against a linear timeline and must import OFF.
  const legacy = { app: 'tangle', type: 'sequence', version: 1, states: payload.states };
  app.setSeqEase(true);
  await importFile(legacy);
  return {
    payloadEase: payload.ease,
    payloadVersion: payload.version,
    imported,
    legacyEase: app.seqEase(),
    legacyStates: app.seqStates.length,
  };
});
console.log(`--- file: exported ease=${round.payloadEase} (version ${round.payloadVersion}) → imported ${round.imported.ease} with ${round.imported.states} keyframes; a legacy file (no key) imported ${round.legacyEase}`);
check(round.payloadEase === true, `the export carries ease=${round.payloadEase}, want true`);
check(round.payloadVersion === 1, `the export bumped the version to ${round.payloadVersion} for an additive key`);
check(round.imported.ease === true, 'the imported file did not bring its ease setting');
check(round.imported.box === true, 'the checkbox did not follow the import');
check(round.legacyEase === false, `a file with no ease key imported ${round.legacyEase}, want false`);
check(round.legacyStates > 0, 'the legacy file imported no keyframes');

// ---- 11. …and a reload -----------------------------------------------------
await page.evaluate(() => window.__app.setSeqEase(true));
await sleep(200);
await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await sleep(1800);
const reloadedOn = await page.evaluate(() => ({
  ease: window.__app.seqEase(),
  states: window.__app.seqStates.length,
  box: document.getElementById('seq-ease').checked,
}));
console.log(`--- reload with ease on: seqEase=${reloadedOn.ease}, ${reloadedOn.states} keyframes back, box ${reloadedOn.box}`);
check(reloadedOn.ease === true, 'ease did not survive a reload');
check(reloadedOn.box === true, 'the checkbox did not follow the restored setting');
check(reloadedOn.states >= 2, 'the sequence did not survive the reload');

await page.evaluate(() => window.__app.setSeqEase(false));
await sleep(200);
await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await sleep(1800);
const reloadedOff = await page.evaluate(() => ({ ease: window.__app.seqEase(), box: document.getElementById('seq-ease').checked }));
console.log(`--- reload with ease off: seqEase=${reloadedOff.ease}, box ${reloadedOff.box}`);
check(reloadedOff.ease === false, 'ease off did not survive a reload (a fresh default overwrote the user\'s choice)');
check(reloadedOff.box === false, 'the checkbox came back ticked after a reload with ease off');

// A session restored from BEFORE this existed — keyframes in storage, no ease
// key — must play exactly as it did: off.
await page.evaluate(() => localStorage.removeItem('tangoPoseStudio.seqEase.v1'));
await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction(() => window.__app, { timeout: 30000 });
await sleep(1800);
const legacySession = await page.evaluate(() => ({
  ease: window.__app.seqEase(),
  states: window.__app.seqStates.length,
}));
console.log(`--- legacy session (${legacySession.states} stored keyframes, no ease key): seqEase=${legacySession.ease}`);
check(legacySession.states >= 2, 'the legacy-session case had no stored sequence to judge');
check(legacySession.ease === false, `a session restored without the key came up ${legacySession.ease}, want false`);

// ---- 12. An eased playback, and an eased recording -------------------------
const played = await page.evaluate(async () => {
  const app = window.__app;
  app.setSeqEase(true);
  app.seqSetTravel(1, 1.2);
  for (let i = 0; i < app.seqStates.length; i++) app.seqSetHold(i, 0);
  const asked = app.seqSeconds();
  const t0 = performance.now();
  app.playSeq(null, null, { from: 0 });
  while (app.seqPlaying && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 60));
  return { asked, secs: (performance.now() - t0) / 1000, t: app.seqT, end: app.leader.nodes.elbow_L.rotation.x };
});
console.log(`--- eased playback: asked ${played.asked}s, took ${played.secs.toFixed(2)}s, ended at t=${played.t}`);
check(!(played.t < 1), `the eased player did not finish (t=${played.t})`);
check(Math.abs(played.secs - played.asked) < 0.35, `an eased ${played.asked}s sequence played in ${played.secs.toFixed(2)}s`);

const rec = await page.evaluate(async () => {
  window.__blobs = [];
  const origURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__blobs.push(b.size); return origURL(b); };
  HTMLAnchorElement.prototype.click = () => {};
  const app = window.__app;
  app.setSeqEase(true);
  const started = app.recordPlayback(app.seqStates, 'verify-seq-ease', { ease: app.seqEase() });
  const eased = app.recording?.ease;
  const t0 = performance.now();
  while (app.recording && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 150));
  return { started, eased, finished: !app.recording, blobKB: Math.round((window.__blobs[0] || 0) / 1024) };
});
console.log(`--- eased recording: started=${rec.started}, job.ease=${rec.eased}, ${rec.blobKB} kB`);
check(rec.started === true, 'recordPlayback refused to start');
check(rec.eased === true, 'the capture job did not carry the ease flag');
check(rec.finished === true, 'the eased recording never stopped');
check(rec.blobKB >= 5, `the eased recording produced only ${rec.blobKB} kB — likely empty`);

// Leave the session clean for the next script.
await page.evaluate(() => {
  window.__app.setSeqStates([]);
  localStorage.removeItem('tangoPoseStudio.seqEase.v1');
  localStorage.removeItem('tangoPoseStudio.sequence.v1');
});

if (problems.length) console.log('\nPROBLEMS:\n' + problems.join('\n'));
else console.log('\nAll easing checks passed.');
console.log(errors.length ? `\nConsole errors:\n${errors.join('\n')}` : '\nNo console errors.');
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
