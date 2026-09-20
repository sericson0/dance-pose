// Dev check: the muscles and tendons welded to an ENDPOINT joint actually lie
// on that endpoint's bones.
//
//   node scripts/dev-verify-foot-muscles.mjs <outDir>
//
// The hand and foot bones are moved AFTER they are baked — #alignEndpointGeometry
// lays them onto the clothed glove/shoe (the foot: an 18.6 deg / 13.9 deg
// rotation onto the shoe's midline, a x1.13 / x0.97 stretch along it and a
// ~13 mm seat translation, all pivoting about the ankle), then a heeled foot is
// pitched and a narrow one squeezed. Each of those used to write into the
// SKELETON layer alone, so the muscle tissue riding the very same nodes stayed
// in the raw atlas position while the bones rotated out from under it. The error
// grows with distance from the pivot, so it was worst exactly where the plantar
// tendons run: "a yellow tendon arcing under the metatarsals with an air gap".
//
// What this measures, and why nothing already here could see it:
//
//   CONTACT — the tissue COMMITTED to an endpoint node (skin weight >= 0.8
//     toward it, so the skin has handed it to that bone outright) against the
//     bone cloud of the WHOLE endpoint (ankle + toes for a foot, wrist for a
//     hand). The MEAN over that tissue, not the minimum: a 13 cm tendon always
//     has SOME vertex near a tarsus that big, which is why
//     dev-probe-clip-anatomy's contact audit read 0.7-1.5 mm for the worst
//     offender in the same pose. And the tissue is rigid on its node, so it
//     rides the clip perfectly and dev-probe-muscle-anchor's `anchor` scored a
//     flat 0 while the belly hung in the air. Only the DISTRIBUTION of a static
//     rest-pose gap can see this class.
//
// Measured (mean mm, leader / follower, worst side) before the fix and after:
//   Flexor digitorum longus     25.6 / 24.6  ->  8.0 / 8.6
//   Flexor hallucis longus      22.2 / 21.0  ->  4.7 / 7.1
//   Ext digitorum long. tendons 23.6 / 21.0  ->  1.4 / 1.2
//   Fibularis brevis             9.9 / 21.8  ->  5.4 / 4.3
//   Tibialis posterior           5.1 / 17.7  ->  3.7 / 3.5
//   Extensor digitorum (hand)   16.4 / 15.0  ->  4.9 / 4.6
//   Flexor carpi radialis       13.6 / 17.3  ->  1.3 / 1.2
//
//   POSED — tissue lying ON A TOE stays on it when the toes move. The rest-pose
//     reading above cannot see this: the long toe muscles are skinned
//     knee -> ankle, which leaves the tendon running out along the phalanges no
//     frame to follow the toes with (Figure.#buildToeDigits gives it one). Mean
//     distance from that tissue to the phalanges, growth over rest, mm, leader /
//     follower at the worse of +35 / -70 deg, before -> after:
//       Flexor digitorum longus      19.4 / 14.4  ->  0.1 / 0.2
//       Flexor hallucis longus       13.8 / 10.5  ->  0.4 / 0.1
//       Extensor hallucis longus     11.2 /  7.6  ->  0.0 / 0.2
//       Ext digitorum longus tendons  6.5 /  3.4  ->  0.1 / 0.1
//     NO_TAILS=1 strips the tails in the page, to show this check failing
//     without them. (For the extensor tendons it strips the per-toe FRAMES but
//     cannot un-split the per-toe joint lines, so that row's "before" is what
//     NO_TAILS shows, not the true pre-fix number.)
//
// Honours DEV_URL and BROWSER_PATH (defaults to Edge, isolated profile so it
// runs beside an open browser).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2] || '.';
fs.mkdirSync(outDir, { recursive: true });

// Mean gap allowed between endpoint-committed tissue and its endpoint's bones.
// Correctly seated tissue reads 1-9 mm (the worst, flexor digitorum longus,
// 8.6); before the fix nine rows sat at 13-26. 12 mm separates the two
// populations with room to spare and is a visible centimetre of daylight.
const MEAN_MM = 12;

// Bellies gated on CONTINUITY instead of contact, with the reason. A row here is
// not an excuse — it is a different, stricter question asked of a tendon whose
// resting place genuinely is not bone.
const EXEMPT = {
  // The extensor tendons cross the FRONT of the ankle inside the extensor
  // retinaculum, held clear of the talus by the joint capsule, so this stump is
  // legitimately ~20 mm off bone in any correct placement (measured 24.6 mm
  // before the fix and 20.9 after — the number barely moves either way). What
  // DOES matter is that it stays welded to its own tendon mesh, which is on the
  // foot at 1.4 mm; that junction is measured below and holds at 0.008 mm.
  'Extensor digitorum longus': 'runs over the ankle inside the retinaculum',
};
// The exempt belly's real test: its distal stump must still meet the tendon that
// carries it onto the phalanges.
const JUNCTION_MM = 1;
// Tissue lying on a toe may not end up further than this from the phalanges
// once the toes are posed, in mm of MEAN growth over its rest-pose gap.
const TAIL_GROWTH_MM = 3;

const BASE = process.env.DEV_URL || 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tangle-footmus-')),
  args: ['--window-size=1400,900', '--use-angle=default'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

const data = await page.evaluate((noTails) => {
  const app = window.__app;
  // NO_TAILS=1 strips the toe tails, to show the posed check failing without them.
  if (noTails) for (const f of [app.leader, app.follower]) for (const sm of f._skinMuscles) sm.tail = null;
  // The joint groups whose bones are moved after the bake, and the bone cloud
  // each one's tissue is measured against. A shank tendon's far end runs out
  // onto the PHALANGES, which hang on the toes node, so the foot is one cluster.
  const GROUPS = { ankle: ['ankle', 'toes'], toes: ['ankle', 'toes'], wrist: ['wrist'] };
  const nodeNameOf = (obj) => {
    let n = obj;
    while (n && (!n.userData || n.userData.jointName === undefined)) n = n.parent;
    return n ? n.userData.jointName : null;
  };
  const rows = []; const junctions = [];

  for (const [figName, fig] of [['leader', app.leader], ['follower', app.follower]]) {
    fig.setLayers({ skeleton: true, body: false, muscle: true });
    fig.group.updateMatrixWorld(true);
    fig.updateMuscleSkin();
    fig.group.updateMatrixWorld(true);

    const clouds = {};
    for (const mesh of fig.layerMeshes.skeleton) {
      const jn = nodeNameOf(mesh);
      if (!jn) continue;
      const pos = mesh.geometry.attributes.position;
      const arr = clouds[jn] || (clouds[jn] = []);
      const step = Math.max(1, Math.floor(pos.count / 4000));
      const e = mesh.matrixWorld.elements;
      for (let i = 0; i < pos.count; i += step) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        arr.push([
          e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14],
        ]);
      }
    }
    const near = (p, cloud) => {
      let best = Infinity;
      for (const q of cloud) {
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    const worldVerts = (mesh, keep) => {
      const pos = mesh.geometry.attributes.position;
      const e = mesh.matrixWorld.elements;
      const vs = [];
      const step = Math.max(1, Math.floor(pos.count / 600));
      for (let i = 0; i < pos.count; i += step) {
        if (keep && !keep(i)) continue;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        vs.push([
          e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14],
        ]);
      }
      return vs;
    };

    for (const sm of fig._skinMuscles) {
      const side = sm.mesh.userData.muscleSide;
      for (const [node, committed] of [
        [sm.nodeB, (i) => sm.weight[i] >= 0.8],
        [sm.nodeA, (i) => sm.weight[i] <= 0.2],
      ]) {
        const jn = node.userData.jointName;
        const base = jn.replace(/_[LR]$/, '');
        if (!GROUPS[base]) continue;
        const cloud = GROUPS[base].flatMap((b) => clouds[`${b}_${side}`] || []);
        if (!cloud.length) continue;
        const vs = worldVerts(sm.mesh, committed);
        if (vs.length < 5) continue;
        const ds = vs.map((p) => near(p, cloud));
        rows.push({
          fig: figName,
          name: sm.mesh.userData.muscleName,
          side,
          node: jn,
          n: ds.length,
          mean: ds.reduce((s, d) => s + d, 0) / ds.length * 1000,
          max: Math.max(...ds) * 1000,
        });
      }
    }

    // CONTINUITY: the extensor digitorum longus belly must meet its own tendon.
    for (const side of ['R', 'L']) {
      const belly = fig._skinMuscles.find((s) => s.mesh.userData.muscleName === 'Extensor digitorum longus'
        && s.mesh.userData.muscleSide === side);
      const tend = fig._skinMuscles.find((s) => s.mesh.userData.muscleName === 'Extensor digitorum longus tendons'
        && s.mesh.userData.muscleSide === side);
      if (!belly || !tend) continue;
      const stump = worldVerts(belly.mesh, (i) => belly.weight[i] >= 0.8);
      const tv = worldVerts(tend.mesh, null);
      if (!stump.length || !tv.length) continue;
      junctions.push({
        fig: figName, side,
        gap: Math.min(...stump.map((p) => near(p, tv))) * 1000,
      });
    }
  }
  // POSED: tissue lying ON A TOE must stay on it when the toes move. Everything
  // above is a rest-pose reading, and at rest this class is invisible — the
  // long flexors' plantar tendons sit on the phalanges to a few mm. But a
  // skinned belly has two frames and these spend both reaching the foot
  // (knee → ankle), so the tail running out along the toes had nothing to
  // follow them with: the toes flexed away from tendons that stayed dead
  // straight in the ankle's frame (see Figure.#buildToeDigits). Chosen by
  // CONTACT, not by the skin weights, so the fix's own bookkeeping cannot hide
  // from it: tissue within TOE_CONTACT of a phalanx at rest, and nearer the
  // toe than the rest of the foot. The number is how much further from the
  // phalanges that same tissue is once the toes are posed.
  const TOE_CONTACT = 0.008;
  const tails = [];
  for (const [figName, fig] of [['leader', app.leader], ['follower', app.follower]]) {
    const pose = (deg, side) => {
      fig.resetPose();
      if (deg) fig.setJointDegrees({ [`toes_${side}`]: { x: deg } });
      fig.syncAtlasNodes(); fig.group.updateMatrixWorld(true);
      fig.updateMuscleSkin(); fig.group.updateMatrixWorld(true);
    };
    const cloudOf = (jn) => {
      const out = [];
      for (const mesh of fig.layerMeshes.skeleton) {
        if (nodeNameOf(mesh) !== jn) continue;
        const pos = mesh.geometry.attributes.position; const e = mesh.matrixWorld.elements;
        for (let i = 0; i < pos.count; i += 2) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          out.push([e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14]]);
        }
      }
      return out;
    };
    const near = (p, cloud) => {
      let best = Infinity;
      for (const q of cloud) {
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    const vert = (mesh, i) => {
      const pos = mesh.geometry.attributes.position; const e = mesh.matrixWorld.elements;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14]];
    };
    for (const side of ['R', 'L']) {
      pose(0, side);
      const toes0 = cloudOf(`toes_${side}`); const foot0 = cloudOf(`ankle_${side}`);
      if (!toes0.length) continue;
      const sets = [];
      for (const sm of fig._skinMuscles) {
        if (sm.mesh.userData.muscleSide !== side) continue;
        if (!/^(ankle|toes)_/.test(sm.nodeB.userData.jointName)) continue;
        const idx = [];
        for (let i = 0; i < sm.weight.length; i++) {
          const p = vert(sm.mesh, i);
          const dT = near(p, toes0);
          if (dT < TOE_CONTACT && dT < near(p, foot0)) idx.push(i);
        }
        if (idx.length >= 8) sets.push({ sm, idx });
      }
      const limits = fig.nodes[`toes_${side}`].userData.def?.limits?.x || [-70, 35];
      for (const { sm, idx } of sets) {
        const mean = (cloud) => idx.reduce((s, i) => s + near(vert(sm.mesh, i), cloud), 0) / idx.length * 1000;
        const row = { fig: figName, side, name: sm.mesh.userData.muscleName, n: idx.length, rest: mean(toes0), posed: [] };
        for (const deg of [limits[1], limits[0]]) {
          pose(deg, side);
          row.posed.push({ deg, mean: mean(cloudOf(`toes_${side}`)) });
        }
        pose(0, side);
        tails.push(row);
      }
      fig.resetPose(); fig.syncAtlasNodes(); fig.group.updateMatrixWorld(true); fig.updateMuscleSkin();
    }
  }
  return { rows, junctions, tails };
}, !!process.env.NO_TAILS);

await page.screenshot({ path: `${outDir}/foot-muscles.png` });

let bad = 0;
console.log('=== endpoint-committed muscle tissue vs its endpoint\'s bones (rest pose, mm) ===');
console.log('fig      side node        n     mean     max   name');
for (const r of data.rows.sort((a, b) => b.mean - a.mean)) {
  const exempt = EXEMPT[r.name];
  const fail = !exempt && r.mean > MEAN_MM;
  if (fail) bad++;
  console.log(`${r.fig.padEnd(8)} ${r.side}    ${r.node.padEnd(9)} ${String(r.n).padStart(4)} ${r.mean.toFixed(1).padStart(7)} ${r.max.toFixed(1).padStart(7)}   ${r.name}`
    + (fail ? '   <-- FAIL: off its own bone' : exempt ? `   (exempt: ${exempt})` : ''));
}

console.log(`\n=== continuity: the exempt belly still meets its own tendon (<= ${JUNCTION_MM} mm) ===`);
for (const j of data.junctions) {
  const fail = j.gap > JUNCTION_MM;
  if (fail) bad++;
  console.log(`  ${j.fig.padEnd(8)} ${j.side}  extensor digitorum longus -> its tendons: ${j.gap.toFixed(3)} mm${fail ? '   <-- FAIL' : ''}`);
}

console.log(`\n=== posed: tissue lying on a toe stays on it as the toes move (growth <= ${TAIL_GROWTH_MM} mm) ===`);
console.log('fig      side    n    rest   ' + 'flexed        extended      name');
for (const t of data.tails) {
  const growth = Math.max(...t.posed.map((p) => p.mean - t.rest));
  const fail = growth > TAIL_GROWTH_MM;
  if (fail) bad++;
  console.log(`${t.fig.padEnd(8)} ${t.side}    ${String(t.n).padStart(4)} ${t.rest.toFixed(1).padStart(7)}   `
    + t.posed.map((p) => `${String(Math.round(p.deg)).padStart(4)}° ${p.mean.toFixed(1).padStart(5)}`).join('    ')
    + `    ${t.name}${fail ? `   <-- FAIL: left its toe by ${growth.toFixed(1)} mm` : ''}`);
}
if (!data.tails.length) { console.log('  FAIL: no muscle tissue found on any toe'); bad++; }

if (!data.rows.length || !data.junctions.length) {
  console.log('\nFAIL: measured nothing (did the muscle atlas load?)');
  bad++;
}

console.log(logs.length ? `\nConsole errors:\n${logs.join('\n')}` : '\nNo console errors.');
await browser.close();
if (bad || logs.length) {
  console.log(`\nFAILED: ${bad} check(s).`);
  process.exit(1);
}
console.log(`\nOK: every endpoint-committed belly lies within ${MEAN_MM} mm of its own bones.`);
