// Probe: for every movement clip, does the SKELETON stay articulated and do the
// MUSCLES stay attached to the bones they attach to?
//
//   node scripts/dev-probe-clip-anatomy.mjs <outDir> [ids...] [--side=L|R|LR] [--shots]
//
// Runs each clip from the anatomical position (like dev-verify-studio.mjs, so
// every row starts where its range is defined), scrubs t = 0 .. 1, and at each
// step measures, on the LIVE skinned geometry:
//
//   attachment drift  — a skinned belly's origin-end cluster (weight ~0) read in
//                       nodeA's own frame, and its insertion-end cluster
//                       (weight ~1) read in nodeB's frame. A properly glued end
//                       is EXACTLY rigid in that frame, so any drift here is the
//                       belly coming unstuck from its bone. This is the number
//                       for "muscles get unglued from their end positions".
//   saturation        — min/max skin weight. An end that never reaches 0 or 1
//                       is never fully committed to its bone, so BOTH ends float
//                       (the `band` clamp in Figure.#addSkinnedMuscle exists to
//                       stop exactly this).
//   stretch           — |bEnd - aEnd| at t over its value at t=0. A belly much
//                       longer/shorter than bind is being torn or collapsed.
//   inert movers      — a belly the row names as a PRIME MOVER that does not
//                       deform at all through its own clip (rigid on a bone that
//                       the movement never turns) — the slide says "this muscle
//                       does the work" while the model never moves it.
//   bone gap          — min surface distance between the bone clusters seated on
//                       a driven joint and on its parent, at t vs t=0. A gap
//                       that OPENS as the joint bends is the limb coming apart.
//
// Plus a one-off static audit at neutral: which muscles span a driven joint
// (vertices on both sides of its pivot) without being skinned across it.
//
// Honours DEV_URL (default http://localhost:5173) and BROWSER_PATH (default
// Edge, always in an isolated profile so it runs beside an open browser).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const rest = argv.filter((a) => !a.startsWith('--'));
const outDir = rest[0] || '.';
const wantIds = rest.slice(1);
const sideArg = (flags.find((f) => f.startsWith('--side=')) || '--side=R').split('=')[1];
const SIDES = sideArg.toUpperCase() === 'LR' ? ['R', 'L'] : [sideArg.toUpperCase()];
const SHOTS = flags.includes('--shots');
fs.mkdirSync(outDir, { recursive: true });

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tangle-probe-')),
  args: ['--window-size=1500,950', '--use-angle=default'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Muscle view, leader alone.
await page.evaluate(() => {
  const el = document.getElementById('layer-mode');
  el.value = 'muscle';
  el.dispatchEvent(new Event('change'));
  window.__app.setVisibleFigures('leader');
});
await sleep(600);

// ---------------------------------------------------------------- shared page helpers
await page.evaluate(() => {
  const app = window.__app;
  const T = window.__probe = {};
  T.fig = () => app.leader;

  // Figure-local vertex reader that works for BOTH muscle kinds: a skinned belly
  // hangs off `group` (geometry already figure-local), a rigid one hangs off its
  // joint node (geometry node-local). mesh.matrixWorld covers both, and gInv
  // brings the result back into the figure's frame.
  T.localVerts = (mesh, gInv, stride = 1) => {
    const a = mesh.geometry.attributes.position.array;
    const m = mesh.matrixWorld.elements;
    const n = a.length / 3;
    const out = [];
    for (let i = 0; i < n; i += stride) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const g = gInv.elements;
      out.push([
        g[0] * wx + g[4] * wy + g[8] * wz + g[12],
        g[1] * wx + g[5] * wy + g[9] * wz + g[13],
        g[2] * wx + g[6] * wy + g[10] * wz + g[14],
      ]);
    }
    return out;
  };

  // Centroid of the geometry vertices selected by `keep(i)`, expressed in
  // `node`'s LOCAL frame. That frame is the whole point: a belly end welded to
  // its bone is motionless here no matter how the dancer moves.
  T.clusterInNode = (mesh, node, keep) => {
    const arr = mesh.geometry.attributes.position.array;
    const M = node.matrixWorld.clone().invert().multiply(mesh.matrixWorld).elements;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let i = 0; i < arr.length / 3; i++) {
      if (!keep(i)) continue;
      const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
      cx += M[0] * x + M[4] * y + M[8] * z + M[12];
      cy += M[1] * x + M[5] * y + M[9] * z + M[13];
      cz += M[2] * x + M[6] * y + M[10] * z + M[14];
      n++;
    }
    return n ? [cx / n, cy / n, cz / n, n] : null;
  };

  T.dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

  // Of a skinned belly's two joints, the one it actually crosses: the deeper
  // (child) of the pair, which is the same rule Figure.#addSkinnedMuscle uses to
  // place the weight band. Read off the rig hierarchy by name, so it holds for
  // the seated atlas nodes the muscles hang from too.
  T.crossedJoint = (aName, bName) => {
    const fig = app.leader;
    const A = fig.nodes[aName], B = fig.nodes[bName];
    if (!A || !B) return bName;
    for (let n = A.parent; n; n = n.parent) if (n === B) return aName;
    return bName;
  };

  // Bone clouds keyed by the joint node each merged skeleton mesh is seated on.
  T.boneClouds = (stride) => {
    const fig = app.leader;
    const gInv = fig.group.matrixWorld.clone().invert();
    const by = {};
    for (const mesh of fig.layerMeshes.skeleton) {
      let n = mesh.parent, name = null;
      while (n && !name) { name = n.userData?.jointName || null; n = n.parent; }
      if (!name) continue;
      (by[name] ||= []).push(...T.localVerts(mesh, gInv, stride));
    }
    return by;
  };

  // Uniform subsample to at most n points, spread across the whole cloud.
  T.thin = (arr, n) => {
    if (arr.length <= n) return arr;
    const k = arr.length / n, out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * k)]);
    return out;
  };

  // Min distance between two point clouds (both already subsampled).
  T.cloudGap = (A, B) => {
    let best = Infinity;
    for (const p of A) for (const q of B) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  // Every muscle mesh with the bookkeeping a measurement needs.
  T.muscles = () => {
    const fig = app.leader;
    const skinned = new Map();
    for (const sm of fig._skinMuscles) skinned.set(sm.mesh, sm);
    return fig.layerMeshes.muscle.map((mesh) => {
      const sm = skinned.get(mesh);
      return {
        mesh,
        sm: sm || null,
        name: mesh.userData.muscleName,
        side: mesh.userData.muscleSide,
        nodeA: sm ? sm.nodeA.userData.jointName : null,
        nodeB: sm ? sm.nodeB.userData.jointName : null,
        seat: sm ? null : (mesh.parent?.userData?.jointName || null),
      };
    });
  };
});

// ------------------------------------------------------------------- static audit
const audit = await page.evaluate(() => {
  const app = window.__app, T = window.__probe;
  const fig = app.leader;
  const V3 = () => app.leader.group.position.clone();
  app.studio.enterClip('sh_flex', { figure: fig, side: 'R', anatomical: true });
  app.studio.scrubClip(0);
  fig.group.updateMatrixWorld(true);
  fig.updateMuscleSkin();
  const gInv = fig.group.matrixWorld.clone().invert();

  // Every joint any clip drives, with its pivot and distal bone direction.
  const driven = new Set();
  for (const m of app.studio.movements) for (const d of m.drive) driven.add(d.joint);
  const rows = [];
  const muscles = T.muscles();
  const jointsOf = (base) => (fig.nodes[base] ? [base] : [`${base}_L`, `${base}_R`]);
  const names = [...driven].flatMap(jointsOf).filter((j) => fig.nodes[j]);

  for (const j of names) {
    const node = fig.nodes[j];
    const p = V3().setFromMatrixPosition(node.matrixWorld).applyMatrix4(gInv);
    // distal direction: mean child joint position
    const acc = V3().set(0, 0, 0); let n = 0;
    for (const ch of node.children) {
      if (!ch.userData?.jointName) continue;
      acc.add(V3().setFromMatrixPosition(ch.matrixWorld).applyMatrix4(gInv)); n++;
    }
    if (!n) continue;
    const d = acc.multiplyScalar(1 / n).sub(p);
    if (d.length() < 1e-4) continue;
    d.normalize();
    for (const mu of muscles) {
      const vs = T.localVerts(mu.mesh, gInv, 7);
      // Proximity gate FIRST: the joint pivot must lie inside the belly's own
      // bounds (+1 cm). Without it the signed-distance test fires on every
      // distant joint whose bone axis happens to slice the belly in two — a
      // forearm flexor "spanning" the hip.
      let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (const v of vs) for (let k = 0; k < 3; k++) {
        if (v[k] < lo[k]) lo[k] = v[k];
        if (v[k] > hi[k]) hi[k] = v[k];
      }
      const pv = [p.x, p.y, p.z];
      let inside = true;
      for (let k = 0; k < 3; k++) if (pv[k] < lo[k] - 0.01 || pv[k] > hi[k] + 0.01) inside = false;
      if (!inside) continue;
      let distal = 0, prox = 0;
      for (const v of vs) {
        const s = (v[0] - p.x) * d.x + (v[1] - p.y) * d.y + (v[2] - p.z) * d.z;
        if (s > 0.02) distal++; else if (s < -0.02) prox++;
      }
      const frac = Math.min(distal, prox) / Math.max(vs.length, 1);
      if (frac < 0.08) continue;                       // does not really span it
      // A muscle handles joint j only if j is the joint its skin actually
      // CROSSES — the deeper (child) of its two nodes. Accepting any endpoint
      // match, as this did, hid a whole side of the table: a belly skinned
      // hip->knee counted as "handling" the hip, although every vertex of its
      // pelvic origin was welded rigidly to the femur with nothing modelling
      // the hip at all.
      //
      // Do NOT read this section as covering that case, though — it is a SPAN
      // test, not an attachment test, and its thresholds (8% of verts each side
      // of the pivot, 20 mm deadband) are too coarse for a compact origin.
      // Measured: with the pre-fix table restored it still did not name
      // sartorius at the hip, whose origin was being dragged 169 mm off the
      // pelvis. The CONTACT section below is the one that catches that class.
      const handled = mu.sm && T.crossedJoint(mu.nodeA, mu.nodeB) === j;
      if (handled) continue;
      rows.push({
        joint: j, muscle: mu.name, side: mu.side,
        kind: mu.sm ? `skinned ${mu.nodeA}->${mu.nodeB}` : `rigid on ${mu.seat}`,
        spanFrac: +frac.toFixed(3),
        distalFrac: +(distal / vs.length).toFixed(3),
      });
    }
  }
  app.studio.exitClip();
  return rows;
});

// --------------------------------------------------------------- contact audit
// Is each skinned belly actually TOUCHING both bones it is skinned between?
// This is the attachment question the span audit above cannot answer, and it is
// the one that catches a belly being dragged across a gap: skinning welds the
// far weight band to a bone, so if that bone is nowhere near the belly, the
// joint tows the band and the belly tears. Measured on the shipped table this
// named the whole quadriceps group at once — 66-81 mm from a shin they were
// skinned to, while their common tendon sits 0.7 mm off it.
// Static (rest pose only), so it costs one measurement no matter how many clips
// are run.
const contact = await page.evaluate(() => {
  const app = window.__app, T = window.__probe;
  const fig = app.leader;
  app.studio.enterClip('sh_flex', { figure: fig, side: 'R', anatomical: true });
  app.studio.scrubClip(0);
  fig.group.updateMatrixWorld(true);
  fig.updateMuscleSkin();
  const gInv = fig.group.matrixWorld.clone().invert();

  const clouds = {};
  for (const [k, v] of Object.entries(T.boneClouds(3))) clouds[k] = T.thin(v, 1500);
  const near = (p, cloud) => {
    let best = Infinity;
    for (const q of cloud) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const rows = [];
  for (const sm of fig._skinMuscles) {
    if (sm.mesh.userData.muscleSide === 'L') continue;   // the mirror says the same
    const a = sm.nodeA.userData.jointName, b = sm.nodeB.userData.jointName;
    const vs = T.localVerts(sm.mesh, gInv, 11);
    const gap = (j) => {
      const cloud = clouds[j];
      if (!cloud?.length) return null;
      let best = Infinity;
      for (const v of vs) { const d = near(v, cloud); if (d < best) best = d; }
      return best;
    };
    const ga = gap(a), gb = gap(b);
    rows.push({ name: sm.mesh.userData.muscleName, a, b, ga, gb });
  }
  app.studio.exitClip();
  return rows;
});

// ------------------------------------------------------------------- per-clip run
const ids = await page.evaluate((want) => {
  const all = window.__app.studio.movements.map((m) => m.id);
  return want.length ? want.filter((i) => all.includes(i)) : all;
}, wantIds);
if (wantIds.length && ids.length !== wantIds.length) {
  console.log(`WARN: unknown ids ignored: ${wantIds.filter((i) => !ids.includes(i)).join(', ')}`);
}

const TS = [0, 0.25, 0.5, 0.75, 1];
const results = [];

for (const id of ids) {
  for (const side of SIDES) {
    const r = await page.evaluate(async ({ id, side, TS }) => {
      const app = window.__app, T = window.__probe;
      const fig = app.leader;
      if (!app.studio.enterClip(id, { figure: fig, side, anatomical: true })) return { id, side, error: 'enterClip refused' };
      const move = app.studio.movements.find((m) => m.id === id);
      const moverNames = new Set();
      for (const m of (move.movers || [])) {
        if (Array.isArray(m)) for (const x of m.slice(1)) moverNames.add(x.toLowerCase());
        else moverNames.add(String(m).toLowerCase());
      }

      const muscles = T.muscles();
      // Weight clusters, chosen once at bind.
      const info = muscles.map((mu) => {
        if (!mu.sm) return { ...mu, mesh: undefined, sm: undefined, rigid: true };
        const w = mu.sm.weight;
        let minW = 1, maxW = 0;
        for (let i = 0; i < w.length; i++) { if (w[i] < minW) minW = w[i]; if (w[i] > maxW) maxW = w[i]; }
        // Attachment clusters. Prefer the vertices that are GENUINELY saturated
        // (weight <= 0.02 / >= 0.98), because only those are rigid in their
        // bone's frame and so only those make "drift" mean anything. Falling
        // back to a fixed 8% slice — as this did unconditionally — quietly mixes
        // in half-blended vertices whenever the saturated region is small, and
        // they are SUPPOSED to move: it reported 30 mm of "drift" on a
        // latissimus whose weights run a perfect 0..1. The 8% fallback is kept
        // only for bellies that never saturate, whose poor saturation is
        // reported separately anyway.
        const sorted = Array.from(w).sort((a, b) => a - b);
        const k = Math.max(1, Math.floor(w.length * 0.08));
        let loCut = sorted[k - 1], hiCut = sorted[w.length - k];
        if (minW <= 0.02) loCut = 0.02;
        if (maxW >= 0.98) hiCut = 0.98;
        // A TOE TAIL (Figure.#buildToeDigits) hands part of nodeB's share on to
        // a third frame — the toe the tendon lies along — so that tissue is
        // saturated toward nodeB by `weight` and yet is NOT rigid in nodeB's
        // frame, by design. Left in the nodeB cluster it reads as the ankle end
        // coming unglued in every toe clip (measured: 5.7–18.3 mm on the three
        // long toe muscles, all of it the tail doing its job). Whether the tail
        // stays on its toe is dev-verify-foot-muscles.mjs's posed check.
        // (Not for a belly whose nodeB IS the toes — the long-extensor tendons —
        // where the tail is the whole nodeB share and the cluster would empty.)
        const tw = /^toes/.test(mu.sm.nodeB.userData.jointName) ? null : mu.sm.tail?.w;
        return {
          ...mu, mesh: undefined, sm: undefined, rigid: false, minW: +minW.toFixed(4), maxW: +maxW.toFixed(4),
          _keepA: (i) => w[i] <= loCut, _keepB: (i) => w[i] >= hiCut && !(tw && tw[i] > 0.02),
        };
      });

      const samples = [];
      for (const t of TS) {
        app.studio.scrubClip(t);
        fig.group.updateMatrixWorld(true);
        fig.updateMuscleSkin();
        const gInv = fig.group.matrixWorld.clone().invert();
        const row = { t, m: [] };
        muscles.forEach((mu, k) => {
          const meta = info[k];
          const vs = T.localVerts(mu.mesh, gInv, 11);
          let cx = 0, cy = 0, cz = 0;
          for (const v of vs) { cx += v[0]; cy += v[1]; cz += v[2]; }
          const world = [cx / vs.length, cy / vs.length, cz / vs.length];
          if (meta.rigid) { row.m.push({ world }); return; }
          const A = T.clusterInNode(mu.mesh, mu.sm.nodeA, meta._keepA);
          const B = T.clusterInNode(mu.mesh, mu.sm.nodeB, meta._keepB);
          // Belly length measured between the two attachment centroids, in the
          // figure frame, so stretch is comparable across poses.
          const Ag = T.clusterInNode(mu.mesh, fig.group, meta._keepA);
          const Bg = T.clusterInNode(mu.mesh, fig.group, meta._keepB);
          row.m.push({ world, A, B, len: Ag && Bg ? T.dist(Ag, Bg) : null });
        });
        // Bone continuity at the driven joints.
        row.bones = {};
        const clouds = T.boneClouds(3);
        const sided = (j) => (fig.nodes[j] ? j : `${j}_${side}`);
        for (const d of move.drive) {
          const j = sided(d.joint);
          const node = fig.nodes[j]; if (!node) continue;
          let pn = node.parent, pj = null;
          while (pn && !pj) { pj = pn.userData?.jointName || null; pn = pn.parent; }
          if (!pj) continue;
          const A = clouds[j], B = clouds[pj];
          if (!A?.length || !B?.length) continue;
          // Sample UNIFORMLY, never slice(0,N): the cloud is mesh-concatenated,
          // so a head slice is one bone rather than a spatial sample. And keep
          // it dense — a coarse subsample reports a neutral "gap" of tens of mm
          // that is pure sampling. Deltas survive subsampling, absolutes do not.
          row.bones[`${pj}|${j}`] = +T.cloudGap(T.thin(A, 2000), T.thin(B, 2000)).toFixed(5);
        }
        samples.push(row);
      }

      // Reduce.
      const base = samples[0];
      const out = { id, side, title: move.title, drive: move.drive.map((d) => `${d.joint}.${d.axis}->${d.to}`), muscles: [], bones: {} };
      muscles.forEach((mu, k) => {
        const meta = info[k];
        let aDrift = 0, bDrift = 0, worldMove = 0, stretchMax = 1, stretchMin = 1;
        for (const s of samples) {
          const cur = s.m[k], b0 = base.m[k];
          worldMove = Math.max(worldMove, T.dist(cur.world, b0.world));
          if (meta.rigid) continue;
          if (cur.A && b0.A) aDrift = Math.max(aDrift, T.dist(cur.A, b0.A));
          if (cur.B && b0.B) bDrift = Math.max(bDrift, T.dist(cur.B, b0.B));
          if (cur.len && b0.len) {
            stretchMax = Math.max(stretchMax, cur.len / b0.len);
            stretchMin = Math.min(stretchMin, cur.len / b0.len);
          }
        }
        out.muscles.push({
          name: mu.name, side: mu.side, rigid: meta.rigid,
          span: meta.rigid ? `rigid:${mu.seat}` : `${mu.nodeA}->${mu.nodeB}`,
          isMover: moverNames.has(String(mu.name).toLowerCase()),
          minW: meta.minW ?? null, maxW: meta.maxW ?? null,
          aDriftMm: +(aDrift * 1000).toFixed(1),
          bDriftMm: +(bDrift * 1000).toFixed(1),
          worldMoveMm: +(worldMove * 1000).toFixed(1),
          stretchMax: +stretchMax.toFixed(3), stretchMin: +stretchMin.toFixed(3),
        });
      });
      for (const key of Object.keys(base.bones)) {
        const series = samples.map((s) => s.bones[key]);
        out.bones[key] = { base: series[0], max: Math.max(...series), series };
      }
      return out;
    }, { id, side, TS });

    results.push(r);
    if (SHOTS) {
      // NOT t=1: a clip's timeline ends back on its START pose so it loops
      // seamlessly, so t=1 is neutral and a screenshot there shows 0 degrees.
      // The stroke peaks around t=0.5 — that is the frame worth looking at.
      await page.evaluate(() => window.__app.studio.scrubClip(0.5));
      await sleep(250);
      await page.screenshot({ path: path.join(outDir, `clip-${id}-${side}-peak.png`) });
    }
    await page.evaluate(() => window.__app.studio.exitClip());
    await sleep(60);
  }
}

// ------------------------------------------------------------------------ report
const DRIFT_MM = 5;      // an end glued to its bone is rigid in that bone's frame
const SAT_LO = 0.02, SAT_HI = 0.98;
const STRETCH_HI = 1.35, STRETCH_LO = 0.7;

const findings = [];
console.log(`\n=== clips: ${ids.join(', ')}  sides: ${SIDES.join('')} ===\n`);
for (const r of results) {
  if (r.error) { console.log(`${r.id} [${r.side}]: ${r.error}`); continue; }
  // Only this clip's own side: the off-side copies never move, so flagging them
  // as inert says nothing about the clip.
  const mine = (m) => !m.side || m.side === r.side;
  const bad = r.muscles.filter((m) => !m.rigid && (m.aDriftMm > DRIFT_MM || m.bDriftMm > DRIFT_MM));
  const torn = r.muscles.filter((m) => !m.rigid && (m.stretchMax > STRETCH_HI || m.stretchMin < STRETCH_LO));
  const inert = r.muscles.filter((m) => m.isMover && mine(m) && m.worldMoveMm < 1);
  const boneBad = Object.entries(r.bones).filter(([, v]) => v.max - v.base > 0.004);

  const head = `${r.id} [${r.side}] ${r.title}  (${r.drive.join(', ')})`;
  const flags = [];
  if (bad.length) flags.push(`${bad.length} unglued`);
  if (torn.length) flags.push(`${torn.length} stretched`);
  if (inert.length) flags.push(`${inert.length} inert movers`);
  if (boneBad.length) flags.push(`${boneBad.length} bone gaps`);
  console.log(`${flags.length ? 'FLAG' : ' ok '} ${head}${flags.length ? '  -- ' + flags.join(', ') : ''}`);

  const show = (label, list, fmt) => {
    for (const m of list.slice(0, 12)) console.log(`        ${label} ${m.name} [${m.side}] ${m.span}: ${fmt(m)}`);
    if (list.length > 12) console.log(`        ... ${list.length - 12} more`);
  };
  show('UNGLUED  ', bad.sort((a, b) => Math.max(b.aDriftMm, b.bDriftMm) - Math.max(a.aDriftMm, a.bDriftMm)),
    (m) => `origin-end drift ${m.aDriftMm}mm, insertion-end drift ${m.bDriftMm}mm (weights ${m.minW}..${m.maxW})`);
  show('STRETCH  ', torn, (m) => `length x${m.stretchMin}..x${m.stretchMax} of bind`);
  show('INERT    ', inert, (m) => `named a prime mover but moved ${m.worldMoveMm}mm`);
  for (const [k, v] of boneBad) console.log(`        BONEGAP   ${k}: ${(v.base * 1000).toFixed(1)}mm -> ${(v.max * 1000).toFixed(1)}mm`);

  if (flags.length) findings.push({ id: r.id, side: r.side, bad, torn, inert, boneBad });
}

// Skin saturation is a BIND-TIME property of each belly (it depends only on the
// geometry and the joint pivots, not the pose), so it is identical in every clip
// and belongs in one table rather than repeated 47 times. It is also the ROOT
// CAUSE behind most per-clip drift above: an end whose weight never reaches 1 is
// only partly following its bone, and an end stuck at 0 is not following it at
// all — the belly stays welded to the other bone and tears away as the joint
// bends.
const sat = (results.find((r) => !r.error)?.muscles || [])
  .filter((m) => !m.rigid && (m.minW > SAT_LO || m.maxW < SAT_HI))
  .sort((a, b) => a.maxW - b.maxW);
console.log(`
=== skin-weight saturation (bind-time, same for every clip) ===`);
console.log(`  ${sat.length} of ${(results[0]?.muscles || []).filter((m) => !m.rigid).length} skinned bellies never commit fully to one end`);
for (const m of sat) {
  const verdict = m.maxW < 0.02 ? 'NEVER follows nodeB at all'
    : m.maxW < 0.6 ? 'insertion end only partly follows nodeB' : 'slightly short of full commit';
  console.log(`  ${m.name} [${m.side}] ${m.span}: weights ${m.minW}..${m.maxW} — ${verdict}`);
}

// A belly is allowed to stop a little shy of the bone (fascia, cartilage, the
// atlas's own trimming); 25 mm is the line between "attached" and "skinned to
// something it cannot reach". On the fixed table every crossing unit clears it.
const CONTACT_MM = 25;
console.log(`\n=== contact audit: is a belly actually TOUCHING both bones it is skinned between? ===`);
const loose = contact.filter((r) => Math.max(r.ga ?? 0, r.gb ?? 0) > CONTACT_MM / 1000)
  .sort((x, y) => Math.max(y.ga, y.gb) - Math.max(x.ga, x.gb));
console.log(`  ${loose.length} of ${contact.length} bellies are skinned to a bone they never reach (> ${CONTACT_MM} mm)`);
for (const r of loose) {
  const mm = (v) => (v === null ? ' n/a' : `${(v * 1000).toFixed(1)}mm`);
  console.log(`  ${r.name}: ${r.a} ${mm(r.ga)}, ${r.b} ${mm(r.gb)}  <- the far band is towed across that gap`);
}

console.log(`\n=== static audit: muscles spanning a driven joint they are NOT skinned across ===`);
const byMuscle = {};
for (const a of audit) (byMuscle[`${a.muscle} (${a.kind})`] ||= []).push(`${a.joint}:${(a.spanFrac * 100).toFixed(0)}%`);
for (const [k, v] of Object.entries(byMuscle).sort()) console.log(`  ${k}  spans ${[...new Set(v)].join(' ')}`);
if (!audit.length) console.log('  (none)');

fs.writeFileSync(path.join(outDir, 'clip-anatomy.json'), JSON.stringify({ results, audit }, null, 1));
console.log(`\nwrote ${path.join(outDir, 'clip-anatomy.json')}`);
console.log(logs.length ? `ERRORS:\n${logs.join('\n')}` : 'No console errors.');
await browser.close();
