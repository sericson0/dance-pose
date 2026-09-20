// Probe: does the tissue RESTING on a bone stay in that bone's frame, and is the
// weight band a band at all?
//
//   node scripts/dev-probe-muscle-anchor.mjs <outDir> [clipIds...] [--side=L|R|LR]
//                                            [--only=substr,substr] [--all]
//
// This exists because `dev-probe-clip-anatomy.mjs`'s three headline metrics are
// STRUCTURALLY BLIND to the worst class of skinning bug, and print a clean bill
// of health while a belly is visibly torn in half. Both of the bugs that class
// has produced here read perfect on all three:
//
//   soleus   stretch x0.947..1.016, drift 0.0-0.1 mm, saturation 0 of 124 bad
//            — while tearing its lower half 84.8 mm off the shank.
//   cuff     subscapularis stretch x0.915..1.048
//            — while the scapula renders as bare bone.
//
// Why they are blind: `drift` reads a belly END in the frame of the bone it is
// SKINNED to, so a belly welded to the wrong bone is rigid in that bone and
// scores a perfect 0. It is not being stretched, it is being TRANSPORTED. And
// `stretch` is the distance between two attachment CENTROIDS, which a rigid
// rotation about an offset pivot changes on its own — so it reports huge numbers
// for healthy bellies folding across a hinge (the Achilles' x0.595) and nothing
// at all for a belly sliding sideways off its bone.
//
// So this probe asks the question those cannot:
//
//   anchor   — take the tissue that RESTS on each bone at the clip's t=0 (within
//              CONTACT_MM of that bone's surface) and measure how far it moves in
//              that bone's OWN frame as the clip runs. Tissue lying on a bone
//              should stay put in that bone's frame whatever it is skinned to.
//              This is the number that names "the muscle came off the bone",
//              and, unlike `drift`, it is chosen by CONTACT rather than by the
//              table, so a wrong table entry cannot hide from it.
//   band     — the fraction of vertices strictly between weight 0.02 and 0.98.
//              Two opposite failures, both invisible to saturation (which only
//              checks that SOME vertex reaches each end):
//                too HIGH — the window is wider than the belly, so the whole
//                  belly is rubber between two bones (the rotator cuff: the
//                  scapula->shoulder axis runs across the fibres, so `band` is
//                  sized off a 165.7 mm inter-node distance while the belly
//                  projects onto 34 mm of it).
//                too LOW  — a knife edge, so single triangles straddle two bones
//                  and rip (pectineus; the biceps common tendon).
//   edge     — the largest ABSOLUTE growth of any triangle edge, in mm. Local and
//              pose-invariant, so unlike `stretch` it does not fire on a belly
//              that merely folds. A tear shows up here and nowhere else.
//
// Honours DEV_URL and BROWSER_PATH (defaults to Edge, isolated profile).
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
const only = (flags.find((f) => f.startsWith('--only=')) || '--only=').split('=')[1]
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALL = flags.includes('--all');
fs.mkdirSync(outDir, { recursive: true });

// Tissue within this of a bone surface at t=0 counts as RESTING on it. 8 mm is
// the same order the CONTACT audit uses and comfortably inside the 25 mm line
// that audit draws between "touches" and "never reaches".
const CONTACT_MM = 8;
// Report thresholds. ANCHOR_MM is the one that matters: correctly glued tissue
// reads 0-2 mm (measured on the hip muscles), so 15 mm is already a visible
// centimetre and a half of bone showing through.
const ANCHOR_MM = 15;
// Mean mis-commitment of contact tissue. Correctly wired bellies sit at a few
// percent; the rotator cuff sits near half, which is what "the whole belly is
// rubber between two bones" looks like as a number.
const MIS_FRAC = 0.25;
const EDGE_MM = 12;
const BAND_HI = 0.35;
const BAND_LO = 0.05;

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tangle-anchor-')),
  args: ['--window-size=1400,900', '--use-angle=default'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.evaluate(() => {
  const el = document.getElementById('layer-mode');
  el.value = 'muscle';
  el.dispatchEvent(new Event('change'));
  window.__app.setVisibleFigures('leader');
});
await sleep(600);

await page.evaluate(() => {
  const app = window.__app;
  const T = window.__anchor = {};

  // Live figure-local vertices of a mesh. Works for both muscle kinds: a skinned
  // belly hangs off `group` (already figure-local), a rigid one off its joint
  // node; matrixWorld covers both.
  T.verts = (mesh, gInv) => {
    const a = mesh.geometry.attributes.position.array;
    const n = a.length / 3;
    const out = new Float64Array(n * 3);
    const m = mesh.matrixWorld.elements, g = gInv.elements;
    for (let i = 0; i < n; i++) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      out[i * 3] = g[0] * wx + g[4] * wy + g[8] * wz + g[12];
      out[i * 3 + 1] = g[1] * wx + g[5] * wy + g[9] * wz + g[13];
      out[i * 3 + 2] = g[2] * wx + g[6] * wy + g[10] * wz + g[14];
    }
    return out;
  };

  // Bone-surface point clouds in figure-local space, keyed by the joint node the
  // merged skeleton mesh is seated on (the ATLAS node for a seated limb joint,
  // which is exactly the node the muscles hang from). Thinned per node.
  T.clouds = (gInv, perNode = 1600) => {
    const fig = app.leader;
    const by = {};
    for (const mesh of fig.layerMeshes.skeleton) {
      let n = mesh.parent, name = null;
      while (n && !name) { name = n.userData?.jointName || null; n = n.parent; }
      if (!name) continue;
      (by[name] ||= []).push(T.verts(mesh, gInv));
    }
    const out = {};
    for (const [name, chunks] of Object.entries(by)) {
      const total = chunks.reduce((s, c) => s + c.length / 3, 0);
      const step = Math.max(1, Math.floor(total / perNode));
      const pts = [];
      for (const c of chunks) {
        for (let i = 0; i < c.length / 3; i += step) pts.push(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
      }
      out[name] = Float64Array.from(pts);
    }
    return out;
  };

  T.nearest = (px, py, pz, cloud) => {
    let best = Infinity;
    for (let k = 0; k < cloud.length; k += 3) {
      const dx = px - cloud[k], dy = py - cloud[k + 1], dz = pz - cloud[k + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  // Unique triangle edges of a geometry, as flat [i0,i1,...].
  T.edges = (geom) => {
    const idx = geom.index ? geom.index.array : null;
    const n = geom.attributes.position.count;
    const seen = new Set();
    const out = [];
    const add = (u, w) => {
      const key = u < w ? u * n + w : w * n + u;
      if (seen.has(key)) return;
      seen.add(key); out.push(u, w);
    };
    if (idx) {
      for (let i = 0; i < idx.length; i += 3) {
        add(idx[i], idx[i + 1]); add(idx[i + 1], idx[i + 2]); add(idx[i], idx[i + 2]);
      }
    } else {
      for (let i = 0; i < n; i += 3) { add(i, i + 1); add(i + 1, i + 2); add(i, i + 2); }
    }
    return Uint32Array.from(out);
  };

  // Snapshot at the clip's t=0: which vertices rest on which bone, the baseline
  // vertex positions, each node's matrix, and the edge list.
  T.snap = (onlyList, all, contactMm) => {
    const fig = app.leader;
    fig.group.updateMatrixWorld(true);
    fig.updateMuscleSkin();
    const gInv = fig.group.matrixWorld.clone().invert();
    const clouds = T.clouds(gInv);
    const G0 = fig.group.matrixWorld.elements.slice();
    const picked = [];
    for (const sm of fig._skinMuscles) {
      const name = sm.mesh.userData.muscleName;
      if (!all && onlyList.length && !onlyList.some((s) => name.toLowerCase().includes(s.toLowerCase()))) continue;
      const aName = sm.nodeA.userData.jointName, bName = sm.nodeB.userData.jointName;
      const p0 = T.verts(sm.mesh, gInv);
      const nv = p0.length / 3;
      const cA = clouds[aName], cB = clouds[bName];
      const restOnA = [], restOnB = [];
      for (let i = 0; i < nv; i++) {
        const x = p0[i * 3], y = p0[i * 3 + 1], z = p0[i * 3 + 2];
        if (cA && T.nearest(x, y, z, cA) * 1000 < contactMm) restOnA.push(i);
        if (cB && T.nearest(x, y, z, cB) * 1000 < contactMm) restOnB.push(i);
      }
      let band = 0;
      for (let i = 0; i < sm.weight.length; i++) if (sm.weight[i] > 0.02 && sm.weight[i] < 0.98) band++;
      // MIS-COMMITMENT — the sharpest number here, and a purely static one.
      // A vertex TOUCHING bone A should be weighted to follow A (weight 0); one
      // touching B should follow B (weight 1). So the mean weight of the tissue
      // resting on A is how much of that contact the skinning has handed to the
      // wrong bone, and vice versa. 0 is perfect. This does not need a clip at
      // all, and unlike `drift` it is chosen by CONTACT, so a wrong table entry
      // or a window wider than the belly cannot hide behind it.
      const meanW = (idxs, flip) => (idxs.length
        ? idxs.reduce((s, i) => s + (flip ? 1 - sm.weight[i] : sm.weight[i]), 0) / idxs.length
        : null);
      picked.push({
        name, side: sm.mesh.userData.muscleSide, aName, bName,
        misA: meanW(restOnA, false), misB: meanW(restOnB, true),
        p0, G0,
        m0A: sm.nodeA.matrixWorld.clone().invert().elements.slice(),
        m0B: sm.nodeB.matrixWorld.clone().invert().elements.slice(),
        restOnA, restOnB,
        bandFrac: band / sm.weight.length,
        nv,
        edges: T.edges(sm.mesh.geometry),
      });
    }
    window.__anchorSnap = picked;
    return picked.map((p) => ({
      name: p.name, side: p.side, aName: p.aName, bName: p.bName,
      bandFrac: p.bandFrac, nv: p.nv, onA: p.restOnA.length, onB: p.restOnB.length,
    }));
  };

  // At the current t: how far the resting tissue has moved in its own bone's
  // frame, and the worst absolute edge growth.
  T.measure = () => {
    const fig = app.leader;
    fig.group.updateMatrixWorld(true);
    fig.updateMuscleSkin();
    const gInv = fig.group.matrixWorld.clone().invert();
    const byName = new Map();
    for (const sm of fig._skinMuscles) byName.set(`${sm.mesh.userData.muscleName}|${sm.mesh.userData.muscleSide}`, sm);
    const out = [];
    for (const s of window.__anchorSnap) {
      const sm = byName.get(`${s.name}|${s.side}`);
      if (!sm) continue;
      const p1 = T.verts(sm.mesh, gInv);
      // Where a vertex WOULD be if it were rigidly welded to this bone. At t=0 a
      // figure-local vertex sits at G0*p0 in the world, so in the bone's own
      // frame it is m0*G0*p0 (m0 = the bone's inverse world matrix at t=0).
      // Carrying that forward by the bone's current world matrix and back into
      // figure-local gives D = gInv * W * m0 * G0. The distance from the vertex's
      // ACTUAL position to that prediction is how far the tissue has come off
      // the bone — zero for anything genuinely glued, whatever it is skinned to.
      const anchor = (idxs, node, m0) => {
        if (!idxs.length) return null;
        const W = node.matrixWorld.elements;
        const mul = (x, y) => {
          const r = new Array(16);
          for (let c = 0; c < 4; c++) for (let rw = 0; rw < 4; rw++) {
            r[c * 4 + rw] = x[rw] * y[c * 4] + x[4 + rw] * y[c * 4 + 1]
              + x[8 + rw] * y[c * 4 + 2] + x[12 + rw] * y[c * 4 + 3];
          }
          return r;
        };
        const D = mul(mul(gInv.elements, W), mul(m0, s.G0));
        const A = [];
        let max = 0, sum = 0;
        for (const i of idxs) {
          const x = s.p0[i * 3], y = s.p0[i * 3 + 1], z = s.p0[i * 3 + 2];
          const px = D[0] * x + D[4] * y + D[8] * z + D[12];
          const py = D[1] * x + D[5] * y + D[9] * z + D[13];
          const pz = D[2] * x + D[6] * y + D[10] * z + D[14];
          const d = Math.hypot(p1[i * 3] - px, p1[i * 3 + 1] - py, p1[i * 3 + 2] - pz) * 1000;
          if (d > max) max = d;
          sum += d;
        }
        A.push(max, sum / idxs.length);
        return A;
      };
      const aRes = anchor(s.restOnA, sm.nodeA, s.m0A);
      const bRes = anchor(s.restOnB, sm.nodeB, s.m0B);
      let edgeMax = 0, edgeRatio = 1;
      for (let e = 0; e < s.edges.length; e += 2) {
        const u = s.edges[e], w = s.edges[e + 1];
        const l0 = Math.hypot(s.p0[u * 3] - s.p0[w * 3], s.p0[u * 3 + 1] - s.p0[w * 3 + 1], s.p0[u * 3 + 2] - s.p0[w * 3 + 2]);
        const l1 = Math.hypot(p1[u * 3] - p1[w * 3], p1[u * 3 + 1] - p1[w * 3 + 1], p1[u * 3 + 2] - p1[w * 3 + 2]);
        const g = (l1 - l0) * 1000;
        if (g > edgeMax) { edgeMax = g; edgeRatio = l0 > 1e-9 ? l1 / l0 : 1; }
      }
      out.push({
        name: s.name, side: s.side, aName: s.aName, bName: s.bName,
        bandFrac: s.bandFrac, misA: s.misA, misB: s.misB,
        aMax: aRes ? aRes[0] : null, aMean: aRes ? aRes[1] : null, aN: s.restOnA.length,
        bMax: bRes ? bRes[0] : null, bMean: bRes ? bRes[1] : null, bN: s.restOnB.length,
        edgeMax, edgeRatio,
      });
    }
    return out;
  };
});

const CLIPS = wantIds.length ? wantIds : ['sh_flex', 'sh_abd', 'el_flex'];
const TS = [0.25, 0.5, 0.75];
const findings = [];

console.log(`=== anchor probe: clips ${CLIPS.join(', ')}  sides ${SIDES.join(',')} ===\n`);

for (const id of CLIPS) {
  for (const side of SIDES) {
    const entered = await page.evaluate((i, s) => window.__app.studio.enterClip(i, {
      figure: window.__app.leader, side: s, anatomical: true,
    }), id, side);
    if (!entered) { console.log(`  ${id} [${side}]: enterClip refused`); continue; }
    await page.evaluate(() => window.__app.studio.scrubClip(0));
    await sleep(350);
    const listed = await page.evaluate((o, a, c) => window.__anchor.snap(o, a, c), only, ALL, CONTACT_MM);
    let worst = new Map();
    for (const t of TS) {
      await page.evaluate((tt) => window.__app.studio.scrubClip(tt), t);
      await sleep(250);
      const rows = await page.evaluate(() => window.__anchor.measure());
      for (const r of rows) {
        const key = `${r.name}|${r.side}`;
        const prev = worst.get(key);
        const score = Math.max(r.aMax ?? 0, r.bMax ?? 0);
        if (!prev || score > Math.max(prev.aMax ?? 0, prev.bMax ?? 0)) worst.set(key, { ...r, t });
      }
    }
    await page.evaluate(() => window.__app.studio.exitClip());
    await sleep(250);

    const mis = (r) => Math.max(r.misA ?? 0, r.misB ?? 0);
    // Sort by CONSEQUENCE, not by mis-commitment: a belly can be badly
    // mis-committed and still sit perfectly still in a clip that never drives
    // its joints, and those would otherwise crowd out the ones actually tearing.
    const sev = (r) => Math.max(r.aMax ?? 0, r.bMax ?? 0) + r.edgeMax;
    const rows = [...worst.values()].sort((x, y) => sev(y) - sev(x));
    const bad = rows.filter((r) => mis(r) > MIS_FRAC
      || Math.max(r.aMax ?? 0, r.bMax ?? 0) > ANCHOR_MM
      || r.edgeMax > EDGE_MM || r.bandFrac > BAND_HI || r.bandFrac < BAND_LO);
    console.log(`${bad.length ? 'FLAG' : ' ok '} ${id} [${side}]  (${listed.length} bellies measured)`);
    for (const r of bad) {
      const tag = [];
      if (mis(r) > MIS_FRAC) tag.push('MISCOMMIT');
      if (Math.max(r.aMax ?? 0, r.bMax ?? 0) > ANCHOR_MM) tag.push('ANCHOR');
      if (r.edgeMax > EDGE_MM) tag.push('EDGE');
      if (r.bandFrac > BAND_HI) tag.push('BAND-WIDE');
      if (r.bandFrac < BAND_LO) tag.push('BAND-THIN');
      console.log(`    ${tag.join('+').padEnd(26)} ${r.name} [${r.side}] ${r.aName}->${r.bName}`);
      console.log(`        miscommit  on ${r.aName}: ${pct(r.misA)} of ${r.aN} contact verts`
        + `   on ${r.bName}: ${pct(r.misB)} of ${r.bN}`);
      console.log(`        anchor     on ${r.aName}: max ${fmt(r.aMax)} mean ${fmt(r.aMean)}`
        + `   on ${r.bName}: max ${fmt(r.bMax)} mean ${fmt(r.bMean)}`);
      console.log(`        band ${(r.bandFrac * 100).toFixed(1)}%   worst edge +${r.edgeMax.toFixed(1)}mm (x${r.edgeRatio.toFixed(2)})   at t=${r.t}`);
    }
    findings.push({ id, side, rows });
  }
}

function fmt(v) { return v == null ? '  n/a' : `${v.toFixed(1)}mm`; }
function pct(v) { return v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`; }

fs.writeFileSync(path.join(outDir, 'muscle-anchor.json'), JSON.stringify(findings, null, 2));
console.log(`\nwrote ${path.join(outDir, 'muscle-anchor.json')}`);
console.log(logs.length ? `\nCONSOLE ERRORS:\n${logs.join('\n')}` : '\nNo console errors.');
await browser.close();
